/**
 * Cron（5 分ごと）：定期実行・心拍の途絶と時間超過の検知・結果表示の再試行・Runner 不在の通知（Webhook の取りこぼしの照合は RECONCILE_GITHUB="1" のときだけ）
 */
import { dispatchCloudRunners } from "./cloud";
import { flushChecks } from "./checks";
import { coordinatorCall } from "./coordinator";
import type { Env, JobRow, JobSpec, RepoRow } from "./env";
import { createGitHubClient, parseRepo, type GitHubClient } from "./github";
import { operationStatement, recordOperation } from "./operations";
import { HEARTBEAT_TIMEOUT_MS, MAX_ATTEMPTS } from "./routes/runner";
import { latestDue, parseCron, type Workflow } from "./workflow";

/** 実行の上限を過ぎてから打ち切るまでの猶予（Runner 自身の打ち切りを待つ） */
export const TIMEOUT_GRACE_MS = 60_000;
/** この時間、受け取る Runner がいなければ通知する */
export const NO_RUNNER_NOTICE_MS = 30 * 60_000;
export const RECONCILE_INTERVAL_MS = 10 * 60_000;

/** 定義ファイルの schedule を評価する。抜けた回（Hub の停止中など）は、何回分抜けても一度だけ実行する */
export async function runSchedules(env: Env, now = Date.now()): Promise<number> {
  const rows = await env.DB.prepare(
    `SELECT s.workflow_id, s.cron, s.last_due, w.file, w.repo_id, w.definition FROM schedules s JOIN workflows w ON w.id = s.workflow_id WHERE w.definition IS NOT NULL`,
  ).all<{ workflow_id: string; cron: string; last_due: number; file: string; repo_id: string; definition: string }>();
  let fired = 0;
  for (const r of rows.results) {
    let due: number | null;
    try {
      due = latestDue(parseCron(r.cron), now);
    } catch {
      continue;
    }
    if (due === null || due <= r.last_due) continue;
    // 先に記録してから実行する（二重に実行しない）
    const claimed = await env.DB.prepare("UPDATE schedules SET last_due = ? WHERE workflow_id = ? AND cron = ? AND last_due = ?").bind(due, r.workflow_id, r.cron, r.last_due).run();
    if ((claimed.meta.changes ?? 0) !== 1) continue;
    const repo = await env.DB.prepare("SELECT * FROM repos WHERE id = ?").bind(r.repo_id).first<RepoRow>();
    if (!repo) continue;
    void (JSON.parse(r.definition) as Workflow);
    await coordinatorCall(env, repo.id, "/event", {
      event: { kind: "schedule", ref: `refs/heads/${repo.default_branch}`, branch: repo.default_branch, sha: null, actor: "schedule", isFork: false, workflowFile: r.file },
      useDefaultBranch: true,
    });
    fired++;
  }
  return fired;
}

/** 心拍の途絶（Runner が落ちた）と時間超過を検知する */
export async function sweepJobs(env: Env, now = Date.now()): Promise<{ lost: number; timedOut: number }> {
  const claimed = await env.DB.prepare("SELECT * FROM jobs WHERE status = 'claimed'").all<JobRow>();
  let lost = 0;
  let timedOut = 0;
  for (const j of claimed.results) {
    const spec = JSON.parse(j.spec) as JobSpec;
    const deadline = (j.claimed_at ?? now) + spec.timeout * 60_000 + TIMEOUT_GRACE_MS;
    if (now > deadline) {
      // 時間超過：打ち切る（Runner には中断を指示し、子プロセスまで止めさせる）。決まって超える処理なので再実行しない
      const r = await env.DB.prepare(
        "UPDATE jobs SET status = 'failed', reason = ?, cancel_requested = 1, finished_at = ?, updated_at = ? WHERE id = ? AND status = 'claimed'",
      )
        .bind(`時間超過（${spec.timeout} 分）`, now, now, j.id)
        .run();
      if ((r.meta.changes ?? 0) === 1) {
        timedOut++;
        await recordOperation(env, { owner_id: j.owner_id, repo_id: j.repo_id, run_id: j.run_id, job_id: j.id, kind: "job", stage: "timeout", status: "failed", reason: `時間超過（${spec.timeout} 分）` });
        await coordinatorCall(env, j.repo_id, "/advance", { job_id: j.id });
      }
      continue;
    }
    if ((j.heartbeat_at ?? 0) < now - HEARTBEAT_TIMEOUT_MS) {
      lost++;
      const retry = j.rerunnable === 1 && j.attempt < MAX_ATTEMPTS && j.cancel_requested === 0;
      // 心拍が途絶えた：失敗として扱い、再実行してよいジョブは待ち行列に戻す（古い実行の報告は受け付けなくなる）
      const r = await env.DB.prepare(
        retry
          ? "UPDATE jobs SET status = 'queued', reason = ?, runner_id = NULL, job_token_hash = NULL, claimed_at = NULL, heartbeat_at = NULL, updated_at = ? WHERE id = ? AND status = 'claimed'"
          : "UPDATE jobs SET status = 'failed', reason = ?, job_token_hash = NULL, finished_at = ?, updated_at = ? WHERE id = ? AND status = 'claimed'",
      )
        .bind(...(retry ? ["Runner からの心拍が途絶えたため再実行します", now, j.id] : [j.rerunnable ? "Runner からの心拍が途絶えました（上限の回数に達しました）" : "Runner からの心拍が途絶えました（再実行しない設定）", now, now, j.id]))
        .run();
      if ((r.meta.changes ?? 0) !== 1) continue;
      await env.DB.batch([
        operationStatement(env, {
          owner_id: j.owner_id,
          repo_id: j.repo_id,
          run_id: j.run_id,
          job_id: j.id,
          kind: "job",
          stage: "heartbeat_lost",
          status: retry ? "retry" : "failed",
          reason: retry ? "心拍の途絶。再実行します" : "心拍の途絶",
          retryable: retry,
          needs_human: !retry,
          detail: { attempt: j.attempt },
        }, now),
      ]);
      // 状態の表示を更新し、失敗なら後続を進める
      await coordinatorCall(env, j.repo_id, "/advance", { job_id: j.id });
    }
  }
  return { lost, timedOut };
}

/** 受け取る Runner がいないまま待っているジョブを一度だけ通知する（Linux はクラウド Runner が受け取る。macOS 専用などは復帰を待つ） */
export async function noticeWaitingJobs(env: Env, now = Date.now()): Promise<number> {
  const rows = await env.DB.prepare("SELECT * FROM jobs WHERE status = 'queued' AND waiting_notified = 0 AND created_at < ?").bind(now - NO_RUNNER_NOTICE_MS).all<JobRow>();
  for (const j of rows.results) {
    await env.DB.batch([
      env.DB.prepare("UPDATE jobs SET waiting_notified = 1 WHERE id = ?").bind(j.id),
      operationStatement(env, {
        owner_id: j.owner_id,
        repo_id: j.repo_id,
        run_id: j.run_id,
        job_id: j.id,
        kind: "job",
        stage: "no_runner",
        status: "retry",
        reason: `ラベル ${JSON.parse(j.runs_on).join("・")} の Runner が ${Math.round(NO_RUNNER_NOTICE_MS / 60_000)} 分以上受け取っていません`,
        needs_human: true,
      }, now),
    ]);
  }
  return rows.results.length;
}

/** Webhook の取りこぼし（Hub の停止中など）：既定ブランチの先頭を照合し、未処理なら push として処理する */
export async function reconcile(env: Env, opts: { gh?: GitHubClient; now?: number } = {}): Promise<number> {
  const now = opts.now ?? Date.now();
  const gh = opts.gh ?? createGitHubClient(env);
  const repos = await env.DB.prepare("SELECT * FROM repos WHERE paused = 0 AND (last_reconciled_at IS NULL OR last_reconciled_at < ?) LIMIT 50").bind(now - RECONCILE_INTERVAL_MS).all<RepoRow>();
  let recovered = 0;
  for (const repo of repos.results) {
    await env.DB.prepare("UPDATE repos SET last_reconciled_at = ? WHERE id = ?").bind(now, repo.id).run();
    let head: string | null;
    try {
      head = await gh.getBranchHead(parseRepo(repo.full_name), repo.default_branch);
    } catch {
      continue; // 次の照合で試す
    }
    if (!head || head === repo.last_seen_sha) continue;
    const done = await env.DB.prepare("SELECT 1 FROM runs WHERE repo_id = ? AND sha = ? LIMIT 1").bind(repo.id, head).first();
    if (done) {
      await env.DB.prepare("UPDATE repos SET last_seen_sha = ? WHERE id = ?").bind(head, repo.id).run();
      continue;
    }
    await recordOperation(env, { owner_id: repo.owner_id, repo_id: repo.id, kind: "event", stage: "reconcile", status: "ok", reason: "取りこぼした更新を照合で見つけました", detail: { sha: head } });
    await coordinatorCall(env, repo.id, "/event", {
      event: { kind: "push", ref: `refs/heads/${repo.default_branch}`, branch: repo.default_branch, sha: head, actor: "reconcile", isFork: false },
      useDefaultBranch: false,
    });
    recovered++;
  }
  return recovered;
}

export async function runCron(env: Env, now = Date.now()): Promise<void> {
  // 一つの失敗で他を止めない
  const tasks: [string, () => Promise<unknown>][] = [
    ["schedules", () => runSchedules(env, now)],
    ["sweep", () => sweepJobs(env, now)],
    ["notice", () => noticeWaitingJobs(env, now)],
    // 取りこぼしの照合は GitHub を 10 分ごとに読むので、既定では動かさない（RECONCILE_GITHUB="1" のときだけ）。
    // 2026-11 に GitHub への定期アクセスでアカウントが止められたため。取りこぼしは手動の実行（run_workflow）で補う
    ["reconcile", () => (env.RECONCILE_GITHUB === "1" ? reconcile(env, { now }) : Promise.resolve(0))],
    ["cloud", () => (env.HUB_URL ? dispatchCloudRunners(env, env.HUB_URL, now) : Promise.resolve(0))],
    ["checks", () => flushChecks(env, { now })],
    [
      "cleanup",
      () =>
        env.DB.batch([
          env.DB.prepare("DELETE FROM webhook_deliveries WHERE received_at < ?").bind(now - 7 * 86_400_000),
          env.DB.prepare("DELETE FROM requested_refs WHERE created_at < ?").bind(now - 30 * 86_400_000),
          env.DB.prepare("DELETE FROM oauth_requests WHERE expires_at < ?").bind(now),
          env.DB.prepare("DELETE FROM oauth_codes WHERE expires_at < ?").bind(now - 86_400_000),
          env.DB.prepare("DELETE FROM oauth_tokens WHERE expires_at < ?").bind(now - 86_400_000),
          env.DB.prepare("DELETE FROM runners WHERE ephemeral = 1 AND expires_at < ?").bind(now - 7 * 86_400_000),
        ]),
    ],
  ];
  for (const [name, t] of tasks) {
    try {
      await t();
    } catch {
      console.error("定期の処理に失敗", name);
    }
  }
}
