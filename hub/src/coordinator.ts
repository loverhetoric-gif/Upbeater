/**
 * RepoCoordinator（Durable Object、リポジトリごとに 1 つ）
 * - 合図の処理（定義ファイルの取得 → run の作成）と、ジョブの状態の遷移を直列に行う
 * - GitHub の障害・回数制限で定義ファイルを取れない時は、合図を待ち行列（DO の永続領域）に残して間隔を広げて再試行する
 */
import { DurableObject } from "cloudflare:workers";
import { flushChecks } from "./checks";
import type { Env, RepoRow } from "./env";
import { createGitHubClient, GitHubError, parseRepo, type WorkflowFile } from "./github";
import { recordOperation } from "./operations";
import { advanceRun, afterJobFinished, cancelRun, createRuns, rerunFailed, type CreatedRun, type EventInfo } from "./runs";
import { latestDue, parseCron, parseWorkflow } from "./workflow";

export const RETRY_BASE_MS = 30_000;
export const RETRY_MAX_MS = 60 * 60_000;

export function backoffDelay(attempt: number, retryAfterMs?: number, rand: () => number = Math.random): number {
  const exp = Math.min(RETRY_MAX_MS, RETRY_BASE_MS * 2 ** Math.max(0, attempt - 1));
  return Math.max(Math.round(exp * (1 + rand() * 0.2)), retryAfterMs ?? 0);
}

interface PendingEvent {
  repo_id: string;
  event: Omit<EventInfo, "sha"> & { sha: string | null };
  /** 既定ブランチの定義を使う（ブランチ削除・定期・手動） */
  useDefaultBranch: boolean;
  attempt: number;
}

export type EventOutcome = { status: "created"; runs: CreatedRun[] } | { status: "queued_retry"; retry_at: number; reason: string } | { status: "skipped"; reason: string } | { status: "failed"; reason: string };

export async function getRepo(env: Env, id: string): Promise<RepoRow | null> {
  return env.DB.prepare("SELECT * FROM repos WHERE id = ?").bind(id).first<RepoRow>();
}

/** 既定ブランチの定義の写しを更新する（定期実行の履歴も合わせる） */
export async function syncWorkflows(env: Env, repo: RepoRow, sha: string, files: WorkflowFile[], now = Date.now()): Promise<void> {
  const seen = new Set<string>();
  for (const f of files) {
    seen.add(f.path);
    const r = parseWorkflow(f.path, f.text);
    const id = (await env.DB.prepare("SELECT id FROM workflows WHERE repo_id = ? AND file = ?").bind(repo.id, f.path).first<{ id: string }>())?.id ?? crypto.randomUUID();
    await env.DB.prepare(
      `INSERT INTO workflows (id, owner_id, repo_id, file, commit_sha, name, definition, problems, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (repo_id, file) DO UPDATE SET commit_sha = excluded.commit_sha, name = excluded.name, definition = excluded.definition, problems = excluded.problems, updated_at = excluded.updated_at`,
    )
      .bind(id, repo.owner_id, repo.id, f.path, sha, r.ok ? r.workflow.name : null, r.ok ? JSON.stringify(r.workflow) : null, r.ok ? null : JSON.stringify(r.problems), now)
      .run();
    const crons = r.ok ? (r.workflow.on.schedule ?? []) : [];
    await env.DB.prepare("DELETE FROM schedules WHERE workflow_id = ? AND cron NOT IN (SELECT value FROM json_each(?))").bind(id, JSON.stringify(crons)).run();
    for (const c of crons) {
      // 新しく書かれた予定は、書かれた時点より前の回を補わない
      const due = latestDue(parseCron(c), now) ?? now;
      await env.DB.prepare("INSERT OR IGNORE INTO schedules (owner_id, workflow_id, cron, last_due) VALUES (?, ?, ?, ?)").bind(repo.owner_id, id, c, due).run();
    }
  }
  const stale = await env.DB.prepare("SELECT id, file FROM workflows WHERE repo_id = ?").bind(repo.id).all<{ id: string; file: string }>();
  for (const w of stale.results) {
    if (seen.has(w.file)) continue;
    await env.DB.batch([env.DB.prepare("DELETE FROM schedules WHERE workflow_id = ?").bind(w.id), env.DB.prepare("DELETE FROM workflows WHERE id = ?").bind(w.id)]);
  }
}

export class RepoCoordinator extends DurableObject<Env> {
  /** 同じリポジトリの処理を一つずつ順に行う */
  private chain: Promise<unknown> = Promise.resolve();

  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const p = this.chain.then(fn, fn);
    this.chain = p.catch(() => undefined);
    return p;
  }

  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const body = (await req.json()) as Record<string, unknown>;
    const repo = await getRepo(this.env, String(body.repo_id));
    if (!repo) return Response.json({ status: "failed", reason: "リポジトリが登録されていません" }, { status: 404 });
    switch (url.pathname) {
      case "/event":
        return Response.json(await this.serial(() => this.handleEvent({ ...(body as unknown as PendingEvent), attempt: 0 }, repo)));
      case "/advance":
        await this.serial(() => afterJobFinished(this.env, repo, String(body.job_id)));
        await flushChecks(this.env).catch(() => undefined);
        return Response.json({ ok: true });
      case "/advance-run":
        await this.serial(() => advanceRun(this.env, repo, String(body.run_id)));
        return Response.json({ ok: true });
      case "/cancel":
        await this.serial(() => cancelRun(this.env, repo, String(body.run_id)));
        await flushChecks(this.env).catch(() => undefined);
        return Response.json({ ok: true });
      case "/rerun":
        return Response.json({ ok: true, jobs: await this.serial(() => rerunFailed(this.env, repo, String(body.run_id))) });
      default:
        return new Response("not found", { status: 404 });
    }
  }

  async alarm(): Promise<void> {
    const pending = (await this.ctx.storage.get<PendingEvent[]>("pending")) ?? [];
    if (pending.length === 0) return;
    await this.ctx.storage.put("pending", []);
    for (const p of pending) {
      const repo = await getRepo(this.env, p.repo_id);
      if (repo) await this.serial(() => this.handleEvent(p, repo, true));
    }
  }

  private async handleEvent(p: PendingEvent, repo: RepoRow, fromAlarm = false): Promise<EventOutcome> {
    const gh = createGitHubClient(this.env);
    const ref = parseRepo(repo.full_name);
    try {
      let sha = p.event.sha;
      let files: WorkflowFile[];
      if (p.useDefaultBranch) {
        sha = sha ?? (await gh.getBranchHead(ref, repo.default_branch));
        if (!sha) return { status: "skipped", reason: "既定ブランチが見つかりません" };
        files = await gh.listWorkflowFiles(ref, sha);
      } else {
        if (!sha) return { status: "skipped", reason: "コミットがありません" };
        if (p.event.kind === "push" && p.event.branch) {
          // 到着順を信用しない：既に新しいコミットを処理していれば、遅れて届いた古い合図は実行しない
          const head = await gh.getBranchHead(ref, p.event.branch);
          if (head === null) return { status: "skipped", reason: "ブランチが削除されています" };
          if (head !== sha) {
            const newer = await this.env.DB.prepare("SELECT 1 FROM runs WHERE repo_id = ? AND sha = ? AND event = 'push' LIMIT 1").bind(repo.id, head).first();
            if (newer) {
              await recordOperation(this.env, { owner_id: repo.owner_id, repo_id: repo.id, kind: "event", stage: "superseded", status: "ok", detail: { sha, head } });
              return { status: "skipped", reason: "より新しいコミットを処理済みです" };
            }
          }
        }
        files = await gh.listWorkflowFiles(ref, sha);
        if (p.event.kind === "push" && p.event.branch === repo.default_branch) {
          await syncWorkflows(this.env, repo, sha, files);
          await this.env.DB.prepare("UPDATE repos SET last_seen_sha = ? WHERE id = ?").bind(sha, repo.id).run();
        }
      }
      const runs = await createRuns(this.env, repo, { ...p.event, sha }, files);
      await flushChecks(this.env, { gh }).catch(() => undefined);
      return { status: "created", runs };
    } catch (e) {
      if (e instanceof GitHubError && !e.retryable) {
        await recordOperation(this.env, { owner_id: repo.owner_id, repo_id: repo.id, kind: "event", stage: "fetch_definitions", status: "failed", reason: e.message, needs_human: e.needsHuman });
        return { status: "failed", reason: e.message };
      }
      // GitHub の障害・回数制限・一時的な失敗：待ち行列に残して再試行する
      const attempt = p.attempt + 1;
      const delay = backoffDelay(attempt, e instanceof GitHubError ? e.retryAfterMs : undefined);
      const retryAt = Date.now() + delay;
      const pending = (await this.ctx.storage.get<PendingEvent[]>("pending")) ?? [];
      pending.push({ ...p, attempt });
      await this.ctx.storage.put("pending", pending);
      const current = await this.ctx.storage.getAlarm();
      if (current === null || current > retryAt) await this.ctx.storage.setAlarm(retryAt);
      const reason = e instanceof Error ? e.message : "一時的な失敗";
      await recordOperation(this.env, { owner_id: repo.owner_id, repo_id: repo.id, kind: "event", stage: "fetch_definitions", status: "retry", reason, retryable: true, detail: { attempt, retry_at: retryAt, from_alarm: fromAlarm } });
      return { status: "queued_retry", retry_at: retryAt, reason };
    }
  }
}

export async function coordinatorCall<T = unknown>(env: Env, repoId: string, path: string, body: Record<string, unknown>): Promise<T> {
  const stub = env.REPO_COORDINATOR.get(env.REPO_COORDINATOR.idFromName(repoId));
  const res = await stub.fetch(`https://coordinator${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ...body, repo_id: repoId }) });
  if (!res.ok && res.status !== 404) throw new Error(`処理の依頼に失敗しました（${res.status}）`);
  return (await res.json()) as T;
}
