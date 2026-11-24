/**
 * 検査通過後の自動マージ（設計は docs/DESIGN.md「検査通過後の自動マージ」）
 * - 持ち主が事前に有効にした規則（repos.auto_merge_enabled）に従い、Upbeater 自身がマージする。AI がマージを呼ぶ必要は無い
 * - 予約（auto_merges）は、PR の head のコミットに対する run がすべて成功し、下書きでなく、衝突が無く、
 *   ブランチ保護・必須の検査を満たした時だけ、検査済みの SHA でマージする
 * - 評価は「起きた時」に行う（run の完了・Webhook・Cron）。GitHub へは、DB の run がすべて成功した予約だけ問い合わせる
 */
import type { Env, RepoRow } from "./env";
import { GitHubError, parseRepo, type GitHubClient, type PullRequest } from "./github";
import { recordOperation } from "./operations";

export type MergeMethod = "merge" | "squash" | "rebase";
export type AutoMergeStatus = "waiting" | "merging" | "merged" | "cancelled" | "closed" | "stopped";

export interface AutoMergeRow {
  owner_id: string;
  repo_id: string;
  pr_number: number;
  method: MergeMethod | null;
  request_id: string | null;
  status: AutoMergeStatus;
  head_sha: string;
  head_updated_at: number;
  code: string | null;
  reason: string | null;
  reported_key: string | null;
  attempts: number;
  update_attempted_sha: string | null;
  merge_commit_sha: string | null;
  next_check_at: number;
  created_at: number;
  updated_at: number;
}

const MIN = 60_000;
/** 検査（run）が 1 件も始まらないまま待つ上限。これを過ぎたら人の判断が要るものとして記録する */
export const NO_RUN_NOTICE_MS = 10 * MIN;
/** GitHub の判定待ち・保留中の検査で先送りできる回数。超えたら止めて人に任せる */
export const MAX_DEFER = 12;
/** 予約の有効期間 */
export const RESERVATION_TTL_MS = 7 * 24 * 60 * MIN;
/** merging のまま止まった予約を待機に戻すまでの時間 */
const MERGING_LEASE_MS = 5 * MIN;

const backoff = (attempts: number) => Math.min(5 * MIN * 2 ** Math.max(0, attempts), 60 * MIN);

export function isMergeMethod(v: unknown): v is MergeMethod {
  return v === "merge" || v === "squash" || v === "rebase";
}

/** マージの push を合図にできるように、PR・コミットを記録する（gitops.ts の markRequested と同じ） */
async function markRequested(env: Env, owner_id: string, full: string, kind: "commit" | "pull", value: string, now: number): Promise<void> {
  await env.DB.prepare("INSERT OR IGNORE INTO requested_refs (owner_id, repo_full_name, kind, value, created_at) VALUES (?, ?, ?, ?, ?)").bind(owner_id, full, kind, value, now).run();
}

async function getRow(env: Env, repoId: string, n: number): Promise<AutoMergeRow | null> {
  return env.DB.prepare("SELECT * FROM auto_merges WHERE repo_id = ? AND pr_number = ?").bind(repoId, n).first<AutoMergeRow>();
}

async function getRepo(env: Env, repoId: string): Promise<RepoRow | null> {
  return env.DB.prepare("SELECT * FROM repos WHERE id = ?").bind(repoId).first<RepoRow>();
}

interface Note {
  stage: string;
  status: "ok" | "retry" | "failed";
  reason?: string;
  needs_human?: boolean;
  retryable?: boolean;
  detail?: Record<string, unknown>;
}

async function record(env: Env, row: Pick<AutoMergeRow, "owner_id" | "repo_id" | "pr_number" | "request_id" | "head_sha">, n: Note): Promise<void> {
  await recordOperation(env, {
    owner_id: row.owner_id,
    repo_id: row.repo_id,
    kind: "auto_merge",
    stage: n.stage,
    status: n.status,
    reason: n.reason ?? null,
    needs_human: n.needs_human,
    retryable: n.retryable,
    detail: { pr_number: row.pr_number, request_id: row.request_id, head_sha: row.head_sha, ...n.detail },
  });
}

interface Patch {
  status?: AutoMergeStatus;
  code?: string | null;
  reason?: string | null;
  head_sha?: string;
  head_updated_at?: number;
  attempts?: number;
  update_attempted_sha?: string | null;
  merge_commit_sha?: string | null;
  next_check_at?: number;
  reported_key?: string | null;
}

/** 状態を書き換える。from を渡すと、その状態のときだけ（競合に強くする） */
async function patchRow(env: Env, row: AutoMergeRow, p: Patch, now: number, from?: AutoMergeStatus): Promise<boolean> {
  const sets: string[] = ["updated_at = ?"];
  const binds: unknown[] = [now];
  for (const [k, v] of Object.entries(p)) {
    if (v === undefined) continue;
    sets.push(`${k} = ?`);
    binds.push(v);
  }
  binds.push(row.repo_id, row.pr_number);
  let sql = `UPDATE auto_merges SET ${sets.join(", ")} WHERE repo_id = ? AND pr_number = ?`;
  if (from) {
    sql += " AND status = ?";
    binds.push(from);
  }
  const r = await env.DB.prepare(sql).bind(...binds).run();
  return (r.meta.changes ?? 0) === 1;
}

/**
 * 待機中の理由を残す。人の判断が要るものは「種類:コミット」ごとに 1 度だけ operations に記録する
 * （同じ理由を Cron のたびに記録しない）。理由が変わった時だけ記録する
 */
async function wait(env: Env, row: AutoMergeRow, code: string, reason: string, now: number, o: { needs_human?: boolean; next_in: number; attempts?: number; detail?: Record<string, unknown> }): Promise<string> {
  const key = `${code}:${row.head_sha}`;
  const changed = row.code !== code || (o.needs_human && row.reported_key !== key);
  await patchRow(env, row, { status: "waiting", code, reason, attempts: o.attempts ?? row.attempts, next_check_at: now + o.next_in, ...(o.needs_human ? { reported_key: key } : {}) }, now);
  if (changed) await record(env, row, { stage: "waiting", status: o.needs_human ? "failed" : "ok", reason, needs_human: o.needs_human, retryable: true, detail: { code, ...o.detail } });
  return code;
}

async function stop(env: Env, row: AutoMergeRow, code: string, reason: string, now: number, detail?: Record<string, unknown>): Promise<string> {
  await patchRow(env, row, { status: "stopped", code, reason, reported_key: `${code}:${row.head_sha}` }, now);
  await record(env, row, { stage: "stopped", status: "failed", reason, needs_human: true, detail: { code, ...detail } });
  return code;
}

// ───────── 予約・取り消し ─────────

export interface ReserveInput {
  owner_id: string;
  repo: RepoRow;
  pr: PullRequest;
  method?: MergeMethod;
  request_id: string;
}

/** 自動マージを予約する（同じ PR の予約があれば、検査待ちの状態に戻して作り直す） */
export async function reserveAutoMerge(env: Env, a: ReserveInput, now = Date.now()): Promise<AutoMergeRow> {
  await markRequested(env, a.owner_id, a.repo.full_name, "pull", String(a.pr.number), now);
  await env.DB.prepare(
    `INSERT INTO auto_merges (owner_id, repo_id, pr_number, method, request_id, status, head_sha, head_updated_at, attempts, next_check_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 'waiting', ?, ?, 0, ?, ?, ?)
     ON CONFLICT (repo_id, pr_number) DO UPDATE SET owner_id = excluded.owner_id, method = excluded.method, request_id = excluded.request_id, status = 'waiting',
       head_sha = excluded.head_sha, head_updated_at = excluded.head_updated_at, code = NULL, reason = NULL, reported_key = NULL, attempts = 0,
       update_attempted_sha = NULL, merge_commit_sha = NULL, next_check_at = excluded.next_check_at, created_at = excluded.created_at, updated_at = excluded.updated_at`,
  )
    .bind(a.owner_id, a.repo.id, a.pr.number, a.method ?? null, a.request_id, a.pr.head_sha, now, now, now, now)
    .run();
  const row = (await getRow(env, a.repo.id, a.pr.number))!;
  await record(env, row, { stage: "reserved", status: "ok", reason: "検査が通ったら Upbeater がマージします", detail: { method: a.method ?? a.repo.auto_merge_method } });
  return row;
}

/** 予約を取り消す。待機中・止まっている予約だけが対象（マージ済み・マージ中は取り消せない） */
export async function cancelAutoMerge(env: Env, owner_id: string, repo: RepoRow, n: number, now = Date.now()): Promise<{ ok: boolean; code?: string; reason?: string; status?: AutoMergeStatus }> {
  const row = await getRow(env, repo.id, n);
  if (!row || row.owner_id !== owner_id) return { ok: false, code: "not_found", reason: `PR #${n} の自動マージの予約はありません` };
  if (row.status === "cancelled") return { ok: true, status: "cancelled" };
  if (row.status === "merged" || row.status === "closed") return { ok: false, code: "already_finished", reason: `この予約は既に終わっています（${row.status}）`, status: row.status };
  if (row.status === "merging") return { ok: false, code: "merging", reason: "マージの処理中です。少し待ってからもう一度取り消してください", status: row.status };
  if (!(await patchRow(env, row, { status: "cancelled", code: "cancelled", reason: "取り消されました" }, now, row.status))) {
    return { ok: false, code: "conflict", reason: "状態が変わりました。もう一度取り消してください" };
  }
  await record(env, row, { stage: "cancelled", status: "ok", reason: "自動マージの予約が取り消されました" });
  return { ok: true, status: "cancelled" };
}

// ───────── 評価 ─────────

/** 予約 1 件を評価し、条件がそろっていればマージする。戻り値は結果の種類（試験・記録用） */
export async function evaluateAutoMerge(env: Env, gh: GitHubClient, repoId: string, n: number, now = Date.now()): Promise<string> {
  const row = await getRow(env, repoId, n);
  if (!row || row.status !== "waiting") return "skipped";
  const repo = await getRepo(env, repoId);
  if (!repo) return "skipped";

  // ① 持ち主の設定（予約の後に無効にされた時も止める）
  if (repo.auto_merge_enabled !== 1) {
    return wait(env, row, "disabled", "このリポジトリの自動マージが無効です（持ち主が有効にすると続きます）", now, { needs_human: true, next_in: 60 * MIN });
  }

  // ② Upbeater の検査（DB の run だけで判断する。GitHub は読まない）
  const runs = await env.DB.prepare("SELECT workflow_file, workflow_name, event, status, conclusion FROM runs WHERE repo_id = ? AND sha = ?").bind(repo.id, row.head_sha).all<{
    workflow_file: string;
    workflow_name: string;
    event: string;
    status: string;
    conclusion: string | null;
  }>();
  if (runs.results.length === 0) {
    if (now - row.head_updated_at > NO_RUN_NOTICE_MS) {
      return wait(env, row, "no_runs", "このコミットの検査（.upbeater の実行）が始まっていません。PR・push で動く定義があるか確かめてください", now, { needs_human: true, next_in: 30 * MIN });
    }
    return wait(env, row, "checks_pending", "検査の開始を待っています", now, { next_in: 5 * MIN });
  }
  const failed = runs.results.filter((r) => r.status === "completed" && r.conclusion !== "success");
  if (failed.length > 0) {
    const names = failed.map((r) => `${r.workflow_name}（${r.conclusion ?? "不明"}）`).join("、");
    return wait(env, row, "checks_failed", `検査が失敗しました：${names}。再実行して成功するか、新しいコミットが積まれると評価し直します`, now, { needs_human: true, next_in: 60 * MIN, detail: { failed: failed.map((r) => r.workflow_file) } });
  }
  if (runs.results.some((r) => r.status !== "completed")) {
    return wait(env, row, "checks_pending", "検査の完了を待っています", now, { next_in: 5 * MIN });
  }

  // ③ ここから GitHub を読む。同時に動かないよう、待機 → マージ中に条件つきで切り替える
  if (!(await patchRow(env, row, { status: "merging" }, now, "waiting"))) return "skipped";
  const full = parseRepo(repo.full_name);
  const method: MergeMethod = isMergeMethod(row.method) ? row.method : isMergeMethod(repo.auto_merge_method) ? repo.auto_merge_method : "squash";
  const cur = { ...row, status: "merging" as const };
  try {
    const pr = await gh.getPull(full, n);
    if (pr.merged) {
      await patchRow(env, cur, { status: "merged", code: "merged", reason: "既にマージされています", merge_commit_sha: pr.merge_commit_sha }, now);
      await record(env, cur, { stage: "merged", status: "ok", reason: "既にマージされていました", detail: { merge_commit_sha: pr.merge_commit_sha } });
      return "merged";
    }
    if (pr.state !== "open") {
      await patchRow(env, cur, { status: "closed", code: "closed", reason: "PR が閉じられたため、予約を終えました" }, now);
      await record(env, cur, { stage: "closed", status: "ok", reason: "PR が閉じられたため、予約を終えました" });
      return "closed";
    }
    if (pr.head_sha !== row.head_sha) {
      // 検査したコミットから進んでいる：新しい head の検査を待ち直す（検査していないコミットはマージしない）
      await patchRow(env, cur, { status: "waiting", code: "head_changed", reason: "新しいコミットが積まれたため、その検査を待ち直します", head_sha: pr.head_sha, head_updated_at: now, reported_key: null, attempts: 0, next_check_at: now + 5 * MIN }, now);
      await record(env, cur, { stage: "head_changed", status: "ok", reason: "新しいコミットが積まれたため、その検査を待ち直します", detail: { new_head_sha: pr.head_sha } });
      return "head_changed";
    }

    const defer = async (code: string, reason: string, o: { needs_human?: boolean; detail?: Record<string, unknown> } = {}): Promise<string> => {
      const attempts = row.attempts + 1;
      if (attempts >= MAX_DEFER) {
        return stop(env, { ...cur, code: row.code }, `${code}_timeout`, `${reason}（${MAX_DEFER} 回待っても解消しないため止めました）`, now, o.detail);
      }
      await patchRow(env, cur, { status: "waiting" }, now);
      return wait(env, { ...cur, status: "waiting", code: row.code }, code, reason, now, { ...o, next_in: backoff(attempts), attempts });
    };

    const state = pr.mergeable_state;
    if (state === "draft") {
      await patchRow(env, cur, { status: "waiting" }, now);
      return wait(env, { ...cur, status: "waiting", code: row.code }, "draft", `PR #${n} は下書きです（準備完了にすると続きます）`, now, { next_in: 60 * MIN });
    }
    if (pr.mergeable === null || state === "unknown") return defer("mergeability_unknown", "GitHub がマージの可否を判定中です");

    if (state === "dirty" || state === "behind") {
      if (row.update_attempted_sha !== row.head_sha) {
        const u = await gh.updatePullBranch(full, n, pr.head_sha);
        await patchRow(env, cur, { update_attempted_sha: row.head_sha }, now);
        if (u === "updated") {
          await patchRow(env, cur, { status: "waiting", code: "base_merged", reason: `${pr.base_ref} を取り込みました。新しいコミットの検査を待ちます`, next_check_at: now + 5 * MIN }, now);
          await record(env, cur, { stage: "waiting", status: "ok", reason: `${pr.base_ref} を取り込みました。新しいコミットの検査を待ちます`, detail: { code: "base_merged" } });
          return "base_merged";
        }
      }
      if (state === "behind") return defer("update_failed", `${pr.base_ref} の取り込みに失敗しました`);
      // 解消できない衝突：予約を止め、衝突しうるファイルを具体的に残す
      const prFiles = new Set(await gh.listPullFiles(full, n));
      const baseFiles = await gh.compareFiles(full, pr.head_sha, pr.base_ref);
      return stop(env, cur, "merge_conflict", `PR #${n} は ${pr.base_ref} と衝突しています。PR は残してあります`, now, { pr_url: pr.html_url, conflicting_files: baseFiles.filter((f) => prFiles.has(f)) });
    }

    if (state === "blocked") {
      const checks = await gh.getChecks(full, pr.head_sha);
      const failing = checks.filter((c) => c.state === "failure").map((c) => c.name);
      const pending = checks.filter((c) => c.state === "pending").map((c) => c.name);
      const detail = { pr_url: pr.html_url, failing_checks: failing, pending_checks: pending };
      if (failing.length) {
        await patchRow(env, cur, { status: "waiting" }, now);
        return wait(env, { ...cur, status: "waiting", code: row.code }, "required_checks_failed", `失敗した必須の検査：${failing.join("、")}`, now, { needs_human: true, next_in: 60 * MIN, detail });
      }
      if (pending.length) return defer("required_checks_pending", `完了していない検査：${pending.join("、")}`, { detail });
      await patchRow(env, cur, { status: "waiting" }, now);
      return wait(env, { ...cur, status: "waiting", code: row.code }, "protection", "必須のレビュー（承認）またはブランチ保護の条件を満たしていません", now, { needs_human: true, next_in: 60 * MIN, detail });
    }

    // 条件がそろった：検査済みの SHA を渡してマージする
    await markRequested(env, row.owner_id, repo.full_name, "pull", String(n), now);
    const m = await gh.mergePull(full, n, { sha: row.head_sha, method });
    if (m.merged) {
      await markRequested(env, row.owner_id, repo.full_name, "commit", m.sha, now);
      await patchRow(env, cur, { status: "merged", code: "merged", reason: "検査が通ったためマージしました", merge_commit_sha: m.sha }, now);
      await record(env, cur, { stage: "merged", status: "ok", reason: "検査が通ったためマージしました", detail: { merge_commit_sha: m.sha, method } });
      return "merged";
    }
    if (m.reason === "head_changed") return defer("head_changed", "判定の間に PR が更新されました。検査を待ち直します");
    return stop(env, cur, "not_mergeable", `PR #${n} をマージできません：${m.message}`, now, { pr_url: pr.html_url });
  } catch (e) {
    // 途中で例外になっても merging のまま残さない
    const after = await getRow(env, repoId, n);
    if (after?.status === "merging") {
      if (e instanceof GitHubError && !e.retryable) {
        await stop(env, cur, "github_error", e.message.slice(0, 300), now, { http_status: e.status });
      } else {
        const attempts = row.attempts + 1;
        const reason = e instanceof Error ? e.message.slice(0, 300) : "一時的な失敗";
        await patchRow(env, cur, { status: "waiting", code: "github_unavailable", reason, attempts, next_check_at: now + backoff(attempts) }, now);
        await record(env, cur, { stage: "waiting", status: "retry", reason, retryable: true, detail: { code: "github_unavailable", attempts } });
      }
    }
    return "error";
  }
}

/** コミットに対する run が終わった時：そのコミットを待っている予約を評価する（flushChecks の後に呼ぶ） */
export async function evaluateForSha(env: Env, gh: GitHubClient, repoId: string, sha: string, now = Date.now()): Promise<void> {
  const rows = await env.DB.prepare("SELECT pr_number FROM auto_merges WHERE repo_id = ? AND head_sha = ? AND status = 'waiting'").bind(repoId, sha).all<{ pr_number: number }>();
  for (const r of rows.results) await evaluateAutoMerge(env, gh, repoId, r.pr_number, now);
}

/** ジョブ・run の完了後の入口 */
export async function autoMergeAfterRun(env: Env, gh: GitHubClient, repoId: string, ref: { job_id?: string; run_id?: string }, now = Date.now()): Promise<void> {
  const run = ref.job_id
    ? await env.DB.prepare("SELECT r.sha, r.status FROM runs r JOIN jobs j ON j.run_id = r.id WHERE j.id = ?").bind(ref.job_id).first<{ sha: string; status: string }>()
    : await env.DB.prepare("SELECT sha, status FROM runs WHERE id = ?").bind(ref.run_id ?? "").first<{ sha: string; status: string }>();
  if (!run || run.status !== "completed") return;
  await evaluateForSha(env, gh, repoId, run.sha, now);
}

// ───────── Webhook（pull_request） ─────────

export interface PullEventPayload {
  action?: string;
  number?: number;
  pull_request?: { number?: number; merged?: boolean; draft?: boolean; head?: { sha?: string } };
}

/** pull_request の Webhook：新しいコミット・クローズ・準備完了を予約に反映する（run の作成とは別。自分の書き込みでも反映する） */
export async function onPullRequestEvent(env: Env, gh: GitHubClient, repoId: string, p: PullEventPayload, now = Date.now()): Promise<void> {
  const n = p.pull_request?.number ?? p.number;
  if (typeof n !== "number") return;
  const row = await getRow(env, repoId, n);
  if (!row) return;
  const action = p.action ?? "";
  if (action === "synchronize") {
    const sha = p.pull_request?.head?.sha;
    if (!sha || sha === row.head_sha || row.status === "merged" || row.status === "cancelled" || row.status === "closed") return;
    // マージ中に届いたら、マージ側が head の変化を見て待ち直す。ここでは待機・止まっているものだけを更新する
    const ok = await env.DB.prepare(
      `UPDATE auto_merges SET status = 'waiting', head_sha = ?, head_updated_at = ?, code = 'head_changed', reason = ?, reported_key = NULL, attempts = 0, next_check_at = ?, updated_at = ?
       WHERE repo_id = ? AND pr_number = ? AND status IN ('waiting', 'stopped')`,
    )
      .bind(sha, now, "新しいコミットが積まれたため、その検査を待ち直します", now + 5 * MIN, now, repoId, n)
      .run();
    if ((ok.meta.changes ?? 0) === 1) await record(env, { ...row, head_sha: sha }, { stage: "head_changed", status: "ok", reason: "新しいコミットが積まれたため、その検査を待ち直します", detail: { previous_head_sha: row.head_sha } });
    return;
  }
  if (action === "closed") {
    if (row.status === "merged" || row.status === "cancelled" || row.status === "closed") return;
    if (row.status === "merging") return; // マージ中の処理が結果を書く
    const merged = p.pull_request?.merged === true;
    const patch: Patch = merged ? { status: "merged", code: "merged", reason: "PR がマージされました" } : { status: "closed", code: "closed", reason: "PR が閉じられたため、予約を終えました" };
    if (await patchRow(env, row, patch, now, row.status)) {
      await record(env, row, { stage: merged ? "merged" : "closed", status: "ok", reason: patch.reason ?? undefined });
    }
    return;
  }
  if (action === "ready_for_review") await evaluateAutoMerge(env, gh, repoId, n, now);
}

// ───────── Cron ─────────

/** 期限の来た予約を評価する（GitHub へは、DB の run がすべて成功した予約だけ問い合わせる）。止まった merging を戻し、古い予約を閉じる */
export async function sweepAutoMerges(env: Env, gh: GitHubClient, now = Date.now()): Promise<number> {
  await env.DB.prepare("UPDATE auto_merges SET status = 'waiting', next_check_at = ?, updated_at = ? WHERE status = 'merging' AND updated_at < ?").bind(now, now, now - MERGING_LEASE_MS).run();
  const old = await env.DB.prepare("SELECT * FROM auto_merges WHERE status IN ('waiting', 'stopped') AND created_at < ? LIMIT 50").bind(now - RESERVATION_TTL_MS).all<AutoMergeRow>();
  for (const r of old.results) {
    if (await patchRow(env, r, { status: "closed", code: "expired", reason: "予約の期限（7 日）が過ぎたため終えました" }, now, r.status)) {
      await record(env, r, { stage: "closed", status: "ok", reason: "予約の期限（7 日）が過ぎたため終えました", detail: { code: "expired" } });
    }
  }
  const due = await env.DB.prepare("SELECT repo_id, pr_number FROM auto_merges WHERE status = 'waiting' AND next_check_at <= ? ORDER BY next_check_at LIMIT 20").bind(now).all<{ repo_id: string; pr_number: number }>();
  let n = 0;
  for (const d of due.results) {
    try {
      await evaluateAutoMerge(env, gh, d.repo_id, d.pr_number, now);
      n++;
    } catch {
      console.error("自動マージの評価に失敗");
    }
  }
  return n;
}
