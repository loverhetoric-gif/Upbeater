/**
 * GitHub への結果表示（Checks）。待ち行列に積み、間隔を広げながら再試行する。
 * 表示に失敗しても実行は止めない。同じ対象の古い表示は新しいもので置き換える（状態は常に最新だけを送る）。
 */
import type { Env, RepoRow } from "./env";
import { createGitHubClient, GitHubError, parseRepo, type CheckRunInput, type GitHubClient } from "./github";
import { recordOperation } from "./operations";

export const CHECK_MAX_ATTEMPTS = 12;

export function checkBackoff(attempts: number, retryAfterMs?: number): number {
  return Math.max(Math.min(15_000 * 2 ** Math.max(0, attempts - 1), 60 * 60_000), retryAfterMs ?? 0);
}

export async function enqueueCheck(env: Env, repo: RepoRow, target: string, payload: CheckRunInput, now = Date.now()): Promise<void> {
  await env.DB.batch([
    // まだ送っていない古い表示は捨てる（最新の状態だけを送れば足りる）
    env.DB.prepare("DELETE FROM check_updates WHERE target = ?").bind(target),
    env.DB.prepare("INSERT INTO check_updates (owner_id, repo_id, target, payload, next_at, created_at) VALUES (?, ?, ?, ?, ?, ?)").bind(
      repo.owner_id,
      repo.id,
      target,
      JSON.stringify(payload),
      now,
      now,
    ),
  ]);
}

interface UpdateRow {
  id: number;
  owner_id: string;
  repo_id: string;
  target: string;
  payload: string;
  attempts: number;
}

/** 送るべき表示を送る。Hub の処理の後と、Cron で呼ぶ */
export async function flushChecks(env: Env, opts: { gh?: GitHubClient; now?: number; limit?: number } = {}): Promise<{ sent: number; failed: number }> {
  const now = opts.now ?? Date.now();
  const gh = opts.gh ?? createGitHubClient(env);
  const rows = await env.DB.prepare(
    `SELECT u.id, u.owner_id, u.repo_id, u.target, u.payload, u.attempts FROM check_updates u WHERE u.next_at <= ? ORDER BY u.id LIMIT ?`,
  )
    .bind(now, opts.limit ?? 50)
    .all<UpdateRow>();
  let sent = 0;
  let failed = 0;
  for (const u of rows.results) {
    const repo = await env.DB.prepare("SELECT full_name FROM repos WHERE id = ?").bind(u.repo_id).first<{ full_name: string }>();
    if (!repo) {
      await env.DB.prepare("DELETE FROM check_updates WHERE id = ?").bind(u.id).run();
      continue;
    }
    const payload = JSON.parse(u.payload) as CheckRunInput;
    try {
      const existing = await env.DB.prepare("SELECT check_run_id FROM check_runs WHERE target = ?").bind(u.target).first<{ check_run_id: number }>();
      if (existing) await gh.updateCheckRun(parseRepo(repo.full_name), existing.check_run_id, payload);
      else {
        const id = await gh.createCheckRun(parseRepo(repo.full_name), payload);
        await env.DB.prepare("INSERT OR REPLACE INTO check_runs (owner_id, target, check_run_id) VALUES (?, ?, ?)").bind(u.owner_id, u.target, id).run();
      }
      // 送っている間に新しい表示が積まれていれば、それは残す
      await env.DB.prepare("DELETE FROM check_updates WHERE id = ?").bind(u.id).run();
      sent++;
    } catch (e) {
      failed++;
      const attempts = u.attempts + 1;
      const retryable = !(e instanceof GitHubError) || e.retryable;
      const reason = e instanceof Error ? e.message.slice(0, 300) : "不明な失敗";
      if (!retryable || attempts >= CHECK_MAX_ATTEMPTS) {
        await env.DB.prepare("DELETE FROM check_updates WHERE id = ?").bind(u.id).run();
        await recordOperation(env, {
          owner_id: u.owner_id,
          repo_id: u.repo_id,
          kind: "checks",
          stage: "report",
          status: "failed",
          reason: `GitHub に結果を表示できませんでした：${reason}`,
          needs_human: true,
          detail: { target: u.target, attempts },
        });
      } else {
        const wait = checkBackoff(attempts, e instanceof GitHubError ? e.retryAfterMs : undefined);
        await env.DB.prepare("UPDATE check_updates SET attempts = ?, next_at = ?, last_error = ? WHERE id = ?").bind(attempts, now + wait, reason, u.id).run();
        await recordOperation(env, { owner_id: u.owner_id, repo_id: u.repo_id, kind: "checks", stage: "report", status: "retry", reason, retryable: true, detail: { target: u.target, attempts } });
      }
    }
  }
  return { sent, failed };
}
