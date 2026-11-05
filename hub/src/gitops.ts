/**
 * GitHub 操作（ブランチ作成 → コミット → PR → マージ）
 * - 各段階は冪等。途中結果を github_requests に保存し、失敗した段階から再開する
 * - 依頼 ID で重複を検知し、完了済みなら既存の結果を返す
 * - 許可リストのリポジトリだけを操作する。既定ブランチ（main）への直接書き込みは禁止し、PR 経由のみとする
 * - 失敗は「段階・理由・再試行の可否・人の判断の要否・具体的な内容」として返す。確認画面は介さない
 */
import { sha256Hex } from "./crypto";
import type { Env } from "./env";
import { GitHubError, parseRepo, type GitHubClient, type PullRequest, type RepoRef, type TreeEntry } from "./github";
import { recordOperation } from "./operations";

export class OpError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly opts: { retryable?: boolean; needsHuman?: boolean; details?: unknown } = {},
  ) {
    super(message);
  }
}

export interface OpFailure {
  ok: false;
  request_id: string;
  stage: string;
  code: string;
  reason: string;
  retryable: boolean;
  needs_human: boolean;
  details?: unknown;
}
export interface OpSuccess {
  ok: true;
  request_id: string;
  result: Record<string, unknown>;
  /** 同じ依頼が完了済みだったため、既存の結果を返した */
  duplicate?: boolean;
  /** 前回失敗した段階から再開した */
  resumed?: boolean;
}
export type OpResult = OpSuccess | OpFailure;

export interface OpContext {
  env: Env;
  gh: GitHubClient;
  owner_id: string;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

type State = Record<string, unknown>;

interface Runner {
  state: State;
  /** 段階の完了を保存する（同じ依頼の再実行ではこの段階を飛ばす） */
  done(stage: string, patch: State): Promise<void>;
  /** いま実行中の段階（失敗の報告に使う） */
  stage: string;
}

/** 実行中とみなす時間。これを過ぎた running は中断とみなして再開できる */
const RUNNING_LEASE_MS = 2 * 60_000;

function stableStringify(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(",")}]`;
  if (v && typeof v === "object") {
    return `{${Object.keys(v as object)
      .sort()
      .filter((k) => (v as Record<string, unknown>)[k] !== undefined)
      .map((k) => `${JSON.stringify(k)}:${stableStringify((v as Record<string, unknown>)[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(v);
}

async function runRequest(
  ctx: OpContext,
  tool: string,
  requestId: string | undefined,
  input: Record<string, unknown>,
  body: (r: Runner) => Promise<Record<string, unknown>>,
): Promise<OpResult> {
  const { env, owner_id } = ctx;
  const now = ctx.now ?? Date.now;
  const inputHash = await sha256Hex(stableStringify({ tool, input }));
  // 依頼 ID が無ければ、内容から決める（同じ内容の依頼は同じ依頼とみなす）
  const id = requestId || `auto-${inputHash.slice(0, 32)}`;

  let state: State = {};
  let resumed = false;
  const existing = await env.DB.prepare("SELECT * FROM github_requests WHERE owner_id = ? AND request_id = ?")
    .bind(owner_id, id)
    .first<{ tool: string; input_hash: string; status: string; state: string; result: string | null; updated_at: number }>();

  const fail = (stage: string, code: string, reason: string, o: Partial<OpFailure> = {}): OpFailure => ({
    ok: false,
    request_id: id,
    stage,
    code,
    reason,
    retryable: o.retryable ?? false,
    needs_human: o.needs_human ?? false,
    ...(o.details !== undefined ? { details: o.details } : {}),
  });

  if (existing) {
    if (existing.input_hash !== inputHash || existing.tool !== tool) {
      return fail("request", "request_id_conflict", "同じ依頼 ID で別の内容が依頼されました。新しい依頼 ID を使ってください");
    }
    if (existing.status === "succeeded") {
      return { ok: true, request_id: id, result: JSON.parse(existing.result ?? "{}") as Record<string, unknown>, duplicate: true };
    }
    if (existing.status === "running" && existing.updated_at > now() - RUNNING_LEASE_MS) {
      return fail("request", "in_progress", "同じ依頼を実行中です。しばらくしてから同じ依頼 ID で確かめてください", { retryable: true });
    }
    // 失敗・中断した依頼は、保存した途中結果から再開する（running への切り替えは競合に強くする）
    const claim = await env.DB.prepare(
      "UPDATE github_requests SET status = 'running', updated_at = ? WHERE owner_id = ? AND request_id = ? AND updated_at = ? AND status != 'succeeded'",
    )
      .bind(now(), owner_id, id, existing.updated_at)
      .run();
    if ((claim.meta.changes ?? 0) !== 1) return fail("request", "in_progress", "同じ依頼を実行中です", { retryable: true });
    state = JSON.parse(existing.state) as State;
    resumed = true;
  } else {
    const ins = await env.DB.prepare(
      `INSERT OR IGNORE INTO github_requests (owner_id, request_id, tool, input_hash, status, state, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'running', '{}', ?, ?)`,
    )
      .bind(owner_id, id, tool, inputHash, now(), now())
      .run();
    if ((ins.meta.changes ?? 0) !== 1) return fail("request", "in_progress", "同じ依頼を実行中です", { retryable: true });
  }

  const repo = typeof input.repo === "string" ? input.repo : null;
  const runner: Runner = {
    state,
    stage: "start",
    async done(stage, patch) {
      Object.assign(state, patch);
      await env.DB.prepare("UPDATE github_requests SET stage = ?, state = ?, updated_at = ? WHERE owner_id = ? AND request_id = ?")
        .bind(stage, JSON.stringify(state), now(), owner_id, id)
        .run();
      await recordOperation(env, { owner_id, kind: "github", stage, status: "ok", detail: { tool, request_id: id, repo, ...patch } });
    },
  };

  try {
    const result = await body(runner);
    await env.DB.prepare("UPDATE github_requests SET status = 'succeeded', stage = 'done', result = ?, error = NULL, updated_at = ? WHERE owner_id = ? AND request_id = ?")
      .bind(JSON.stringify(result), now(), owner_id, id)
      .run();
    return { ok: true, request_id: id, result, ...(resumed ? { resumed: true } : {}) };
  } catch (e) {
    let f: OpFailure;
    if (e instanceof OpError) {
      f = fail(runner.stage, e.code, e.message, { retryable: e.opts.retryable, needs_human: e.opts.needsHuman, details: e.opts.details });
    } else if (e instanceof GitHubError) {
      f = fail(runner.stage, e.retryable ? "github_unavailable" : "github_error", e.message, {
        retryable: e.retryable,
        needs_human: e.needsHuman,
        details: { http_status: e.status, ...(e.retryAfterMs !== undefined ? { retry_after_ms: e.retryAfterMs } : {}) },
      });
    } else {
      f = fail(runner.stage, "internal_error", "一時的な内部エラー", { retryable: true });
    }
    await env.DB.prepare("UPDATE github_requests SET status = 'failed', stage = ?, error = ?, updated_at = ? WHERE owner_id = ? AND request_id = ?")
      .bind(runner.stage, JSON.stringify(f), now(), owner_id, id)
      .run();
    await recordOperation(env, {
      owner_id,
      kind: "github",
      stage: runner.stage,
      status: "failed",
      reason: f.reason,
      retryable: f.retryable,
      needs_human: f.needs_human,
      detail: { tool, request_id: id, repo, code: f.code },
    });
    return f;
  }
}

// ───────── 入力の検証 ─────────

const REPO = /^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/;
const BRANCH = /^(?!\/)(?!.*\.\.)(?!.*\/\/)(?!.*@\{)[A-Za-z0-9._\/-]{1,200}(?<![\/.])$/;

export function checkRepoName(repo: string): RepoRef {
  if (!REPO.test(repo)) throw new OpError("invalid_input", "リポジトリは owner/name の形式で指定してください");
  return parseRepo(repo.toLowerCase());
}

export function checkBranchName(b: string): string {
  if (!BRANCH.test(b) || b.endsWith(".lock")) throw new OpError("invalid_input", `ブランチ名「${b}」は使えません`);
  return b;
}

export interface FileChange {
  path: string;
  /** 書き込む内容。delete が true なら省略 */
  content?: string;
  encoding?: "utf-8" | "base64";
  delete?: boolean;
}

const MAX_FILES = 100;
const MAX_FILE_BYTES = 1024 * 1024;

export function checkFiles(files: FileChange[]): FileChange[] {
  if (files.length === 0 || files.length > MAX_FILES) throw new OpError("invalid_input", `ファイルは 1〜${MAX_FILES} 件で指定してください`);
  const seen = new Set<string>();
  for (const f of files) {
    const p = f.path;
    if (!p || p.length > 400 || p.startsWith("/") || p.endsWith("/") || p.split("/").some((s) => s === "" || s === "." || s === ".." || s === ".git")) {
      throw new OpError("invalid_input", `パス「${p}」は使えません`);
    }
    if (seen.has(p)) throw new OpError("invalid_input", `パス「${p}」が重複しています`);
    seen.add(p);
    if (!f.delete && typeof f.content !== "string") throw new OpError("invalid_input", `「${p}」の内容がありません`);
    if ((f.content?.length ?? 0) > MAX_FILE_BYTES * 1.4) throw new OpError("invalid_input", `「${p}」が大きすぎます（1 MB まで）`);
  }
  return files;
}

async function assertAllowed(ctx: OpContext, repo: RepoRef): Promise<void> {
  const row = await ctx.env.DB.prepare("SELECT 1 AS ok FROM repo_allowlist WHERE owner_id = ? AND repo_full_name = ?")
    .bind(ctx.owner_id, `${repo.owner}/${repo.name}`)
    .first();
  if (!row) {
    throw new OpError("repo_not_allowed", `${repo.owner}/${repo.name} は操作の許可リストにありません（register_app で登録したリポジトリだけを操作できます）`, {
      needsHuman: true,
    });
  }
}

function toBase64Utf8(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}

// ───────── 各段階（冪等） ─────────

async function stageBranch(ctx: OpContext, r: Runner, repo: RepoRef, branch: string, from?: string): Promise<void> {
  if (r.state.branch_ready) return;
  r.stage = "create_branch";
  const def = await ctx.gh.getDefaultBranch(repo);
  if (branch === def) throw new OpError("direct_write_forbidden", `既定ブランチ（${def}）は作業ブランチにできません`);
  const base = from ?? def;
  const existing = await ctx.gh.getBranchHead(repo, branch);
  if (existing) {
    await r.done("create_branch", { branch_ready: true, default_branch: def, branch_created: false, branch_sha: existing });
    return;
  }
  const baseSha = await ctx.gh.getBranchHead(repo, base);
  if (!baseSha) throw new OpError("branch_not_found", `元のブランチ「${base}」が見つかりません`, { needsHuman: true });
  const res = await ctx.gh.createBranch(repo, branch, baseSha);
  await r.done("create_branch", { branch_ready: true, default_branch: def, branch_created: res === "created", branch_sha: baseSha });
}

async function stageCommit(ctx: OpContext, r: Runner, repo: RepoRef, branch: string, message: string, files: FileChange[]): Promise<void> {
  if (r.state.commit_pushed) return;
  r.stage = "commit_files";
  const def = (r.state.default_branch as string | undefined) ?? (await ctx.gh.getDefaultBranch(repo));
  if (branch === def) {
    throw new OpError("direct_write_forbidden", `既定ブランチ（${def}）への直接書き込みは禁止です。作業ブランチに書き込み、PR を経由してください`);
  }
  for (let attempt = 0; attempt < 3; attempt++) {
    if (!r.state.commit_sha) {
      const head = await ctx.gh.getBranchHead(repo, branch);
      if (!head) throw new OpError("branch_not_found", `ブランチ「${branch}」が見つかりません`, { needsHuman: true });
      const baseTree = await ctx.gh.getCommitTree(repo, head);
      const entries: TreeEntry[] = [];
      for (const f of files) {
        if (f.delete) entries.push({ path: f.path, sha: null });
        else entries.push({ path: f.path, sha: await ctx.gh.createBlob(repo, f.encoding === "base64" ? f.content! : toBase64Utf8(f.content!)) });
      }
      const tree = await ctx.gh.createTree(repo, baseTree, entries);
      const commit = await ctx.gh.createCommit(repo, message, tree, [head]);
      await r.done("commit_created", { commit_sha: commit, commit_parent: head });
    }
    const commit = r.state.commit_sha as string;
    const res = await ctx.gh.updateBranch(repo, branch, commit);
    if (res === "updated" || (await ctx.gh.getBranchHead(repo, branch)) === commit) {
      await r.done("commit_pushed", { commit_pushed: true });
      return;
    }
    // 他の書き込みでブランチが先に進んでいた：新しい先頭の上に作り直す
    await r.done("commit_rebuild", { commit_sha: null });
  }
  throw new OpError("branch_moving", "ブランチが他の書き込みで更新され続けているため、コミットできませんでした", { retryable: true });
}

async function stagePull(ctx: OpContext, r: Runner, repo: RepoRef, head: string, base: string | undefined, title: string, body: string): Promise<PullRequest> {
  r.stage = "open_pr";
  if (typeof r.state.pr_number === "number") return ctx.gh.getPull(repo, r.state.pr_number);
  const def = (r.state.default_branch as string | undefined) ?? (await ctx.gh.getDefaultBranch(repo));
  const target = base ?? def;
  if (head === target) throw new OpError("invalid_input", "PR の元と先が同じブランチです");
  let pr = await ctx.gh.createPull(repo, { head, base: target, title, body });
  if (pr === "exists") {
    const found = await ctx.gh.findOpenPull(repo, head, target);
    if (!found) throw new OpError("pr_not_found", "PR が既にあると言われましたが、見つかりません", { retryable: true });
    pr = found;
  }
  await r.done("open_pr", { pr_number: pr.number, pr_url: pr.html_url, base_branch: target });
  return pr;
}

async function stageMerge(ctx: OpContext, r: Runner, repo: RepoRef, n: number, method: "merge" | "squash" | "rebase"): Promise<string> {
  r.stage = "merge_pr";
  if (typeof r.state.merged_sha === "string") return r.state.merged_sha;
  const sleep = ctx.sleep ?? ((ms: number) => new Promise((res) => setTimeout(res, ms)));
  const poll = Number(ctx.env.GITHUB_POLL_MS ?? "1500") || 1500;
  let updatedOnce = false;

  for (let attempt = 1; attempt <= 6; attempt++) {
    const pr = await ctx.gh.getPull(repo, n);
    if (pr.merged) {
      await r.done("merge_pr", { merged_sha: pr.merge_commit_sha ?? "" });
      return pr.merge_commit_sha ?? "";
    }
    if (pr.state !== "open") throw new OpError("pr_closed", `PR #${n} は閉じられています`, { needsHuman: true });
    if (pr.mergeable === null || pr.mergeable_state === "unknown") {
      await sleep(poll * attempt); // GitHub が判定を計算中
      continue;
    }
    if (pr.mergeable_state === "draft") throw new OpError("pr_draft", `PR #${n} は下書きです`, { needsHuman: true });

    if (pr.mergeable_state === "dirty" || pr.mergeable_state === "behind") {
      // まず base（main）を取り込んで再試行する
      if (!updatedOnce) {
        updatedOnce = true;
        const u = await ctx.gh.updatePullBranch(repo, n, pr.head_sha);
        await r.done("update_branch", { base_merged: u === "updated" });
        if (u === "updated") {
          await sleep(poll);
          continue;
        }
      }
      if (pr.mergeable_state === "behind") throw new OpError("update_failed", "main の取り込みに失敗しました", { retryable: true });
      // 解消できない衝突：PR を残し、衝突しうるファイルを具体的に返す
      const prFiles = new Set(await ctx.gh.listPullFiles(repo, n));
      const baseFiles = await ctx.gh.compareFiles(repo, pr.head_sha, pr.base_ref);
      const files = baseFiles.filter((f) => prFiles.has(f));
      throw new OpError("merge_conflict", `PR #${n} は ${pr.base_ref} と衝突しています。PR は残してあります`, {
        needsHuman: true,
        details: { pr_url: pr.html_url, conflicting_files: files },
      });
    }

    if (pr.mergeable_state === "blocked") {
      const checks = await ctx.gh.getChecks(repo, pr.head_sha);
      const failing = checks.filter((c) => c.state === "failure").map((c) => c.name);
      const pending = checks.filter((c) => c.state === "pending").map((c) => c.name);
      const conditions: string[] = [];
      if (failing.length) conditions.push(`失敗した必須の検査：${failing.join("、")}`);
      if (pending.length) conditions.push(`完了していない検査：${pending.join("、")}`);
      if (!failing.length && !pending.length) conditions.push("必須のレビュー（承認）またはブランチ保護の条件を満たしていません");
      throw new OpError("requirements_not_met", `PR #${n} はマージの条件を満たしていません`, {
        retryable: failing.length === 0 && pending.length > 0,
        needsHuman: failing.length > 0 || pending.length === 0,
        details: { pr_url: pr.html_url, conditions, failing_checks: failing, pending_checks: pending },
      });
    }

    const m = await ctx.gh.mergePull(repo, n, { sha: pr.head_sha, method });
    if (m.merged) {
      await r.done("merge_pr", { merged_sha: m.sha });
      return m.sha;
    }
    if (m.reason === "head_changed") continue; // 判定の間に PR が更新された
    throw new OpError("not_mergeable", `PR #${n} をマージできません：${m.message}`, { needsHuman: true, details: { pr_url: pr.html_url } });
  }
  throw new OpError("mergeability_unknown", "GitHub がマージの可否を判定できませんでした", { retryable: true });
}

// ───────── 公開する操作 ─────────

export async function createBranchOp(ctx: OpContext, a: { repo: string; branch: string; from?: string; request_id?: string }): Promise<OpResult> {
  return runRequest(ctx, "create_branch", a.request_id, { repo: a.repo.toLowerCase(), branch: a.branch, from: a.from }, async (r) => {
    const repo = checkRepoName(a.repo);
    checkBranchName(a.branch);
    if (a.from) checkBranchName(a.from);
    await assertAllowed(ctx, repo);
    await stageBranch(ctx, r, repo, a.branch, a.from);
    return { branch: a.branch, created: r.state.branch_created, sha: r.state.branch_sha };
  });
}

export async function commitFilesOp(
  ctx: OpContext,
  a: { repo: string; branch: string; message: string; files: FileChange[]; request_id?: string },
): Promise<OpResult> {
  return runRequest(ctx, "commit_files", a.request_id, { repo: a.repo.toLowerCase(), branch: a.branch, message: a.message, files: a.files }, async (r) => {
    const repo = checkRepoName(a.repo);
    checkBranchName(a.branch);
    checkFiles(a.files);
    await assertAllowed(ctx, repo);
    await stageCommit(ctx, r, repo, a.branch, a.message, a.files);
    return { branch: a.branch, commit_sha: r.state.commit_sha };
  });
}

export async function openPrOp(
  ctx: OpContext,
  a: { repo: string; head: string; base?: string; title: string; body?: string; request_id?: string },
): Promise<OpResult> {
  return runRequest(ctx, "open_pr", a.request_id, { repo: a.repo.toLowerCase(), head: a.head, base: a.base, title: a.title, body: a.body }, async (r) => {
    const repo = checkRepoName(a.repo);
    checkBranchName(a.head);
    if (a.base) checkBranchName(a.base);
    await assertAllowed(ctx, repo);
    const pr = await stagePull(ctx, r, repo, a.head, a.base, a.title, a.body ?? "");
    return { number: pr.number, url: pr.html_url, base: r.state.base_branch };
  });
}

export async function mergePrOp(
  ctx: OpContext,
  a: { repo: string; number: number; method?: "merge" | "squash" | "rebase"; request_id?: string },
): Promise<OpResult> {
  return runRequest(ctx, "merge_pr", a.request_id, { repo: a.repo.toLowerCase(), number: a.number, method: a.method }, async (r) => {
    const repo = checkRepoName(a.repo);
    await assertAllowed(ctx, repo);
    const sha = await stageMerge(ctx, r, repo, a.number, a.method ?? "squash");
    return { number: a.number, merged: true, merge_commit_sha: sha };
  });
}

/** ブランチ作成 → コミット → PR → マージを一続きで行う。失敗しても同じ依頼 ID で再実行すれば、失敗した段階から続ける */
export async function shipChangeOp(
  ctx: OpContext,
  a: {
    repo: string;
    branch: string;
    title: string;
    message?: string;
    body?: string;
    base?: string;
    files: FileChange[];
    merge?: boolean;
    method?: "merge" | "squash" | "rebase";
    request_id?: string;
  },
): Promise<OpResult> {
  const input = { ...a, repo: a.repo.toLowerCase(), request_id: undefined };
  return runRequest(ctx, "ship_change", a.request_id, input, async (r) => {
    const repo = checkRepoName(a.repo);
    checkBranchName(a.branch);
    if (a.base) checkBranchName(a.base);
    checkFiles(a.files);
    await assertAllowed(ctx, repo);
    await stageBranch(ctx, r, repo, a.branch, a.base);
    await stageCommit(ctx, r, repo, a.branch, a.message ?? a.title, a.files);
    const pr = await stagePull(ctx, r, repo, a.branch, a.base, a.title, a.body ?? "");
    const out: Record<string, unknown> = { branch: a.branch, commit_sha: r.state.commit_sha, pr_number: pr.number, pr_url: pr.html_url };
    if (a.merge !== false) {
      out.merge_commit_sha = await stageMerge(ctx, r, repo, pr.number, a.method ?? "squash");
      out.merged = true;
      out.note = "マージ後は Webhook により自動で配信が始まります";
    }
    return out;
  });
}

