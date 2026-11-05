/**
 * MCP の道具（ツール）。すべて呼び出した利用者（owner_id）のデータだけを扱う
 */
import { coordinatorCall, type EventOutcome } from "./coordinator";
import type { Env, JobRow, RepoRow, RunRow } from "./env";
import { createGitHubClient, GitHubError, parseRepo, type GitHubClient } from "./github";
import { checkBranchName, checkRepoName, commitFilesOp, createBranchOp, mergePrOp, openPrOp, OpError, shipChangeOp, type FileChange, type OpContext, type OpResult } from "./gitops";
import { HttpError } from "./http";
import { recordOperation } from "./operations";
import { assembleLogs } from "./routes/runner";
import { createSecretForm } from "./routes/secret-form";
import { convertWorkflow, type ConvertResult } from "./workflow/convert";

// ───────── 入力の検証（JSON Schema の部分集合） ─────────

export type Schema =
  | { type: "string"; description?: string; enum?: readonly string[]; maxLength?: number }
  | { type: "integer"; description?: string; minimum?: number; maximum?: number }
  | { type: "boolean"; description?: string }
  | { type: "array"; description?: string; items: Schema; maxItems?: number }
  | { type: "object"; description?: string; properties: Record<string, Schema>; required?: readonly string[]; additionalProperties?: Schema | false };

export class InvalidParams extends Error {}

export function validate(schema: Schema, v: unknown, path = "引数"): unknown {
  switch (schema.type) {
    case "string":
      if (typeof v !== "string") throw new InvalidParams(`${path} は文字列です`);
      if (schema.maxLength !== undefined && v.length > schema.maxLength) throw new InvalidParams(`${path} が長すぎます`);
      if (schema.enum && !schema.enum.includes(v)) throw new InvalidParams(`${path} は ${schema.enum.join(" / ")} のいずれかです`);
      return v;
    case "integer":
      if (typeof v !== "number" || !Number.isSafeInteger(v)) throw new InvalidParams(`${path} は整数です`);
      if (schema.minimum !== undefined && v < schema.minimum) throw new InvalidParams(`${path} は ${schema.minimum} 以上です`);
      if (schema.maximum !== undefined && v > schema.maximum) throw new InvalidParams(`${path} は ${schema.maximum} 以下です`);
      return v;
    case "boolean":
      if (typeof v !== "boolean") throw new InvalidParams(`${path} は true / false です`);
      return v;
    case "array":
      if (!Array.isArray(v)) throw new InvalidParams(`${path} は配列です`);
      if (schema.maxItems !== undefined && v.length > schema.maxItems) throw new InvalidParams(`${path} が多すぎます`);
      return v.map((x, i) => validate(schema.items, x, `${path}[${i}]`));
    case "object": {
      if (v === undefined) v = {};
      if (v === null || typeof v !== "object" || Array.isArray(v)) throw new InvalidParams(`${path} はオブジェクトです`);
      const o = v as Record<string, unknown>;
      for (const r of schema.required ?? []) if (o[r] === undefined || o[r] === null) throw new InvalidParams(`${path}.${r} が必要です`);
      const out: Record<string, unknown> = {};
      for (const [k, val] of Object.entries(o)) {
        const s = schema.properties[k] ?? (schema.additionalProperties || undefined);
        if (!s) throw new InvalidParams(`${path}.${k} は使えない項目です`);
        if (val !== undefined && val !== null) out[k] = validate(s, val, `${path}.${k}`);
      }
      return out;
    }
  }
}

// ───────── 道具の定義 ─────────

export type ToolResult = { ok: boolean; [k: string]: unknown } | OpResult;

export interface ToolContext {
  env: Env;
  owner_id: string;
  /** Hub の URL（入力ページの URL を作る） */
  origin?: string;
  gh?: GitHubClient;
}

interface Tool {
  name: string;
  title: string;
  description: string;
  inputSchema: Extract<Schema, { type: "object" }>;
  annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean; idempotentHint?: boolean; openWorldHint?: boolean };
  run(ctx: ToolContext, args: Record<string, unknown>): Promise<ToolResult>;
}

const str = (description: string, maxLength = 200): Schema => ({ type: "string", description, maxLength });
const int = (description: string, minimum = 0, maximum?: number): Schema => ({ type: "integer", description, minimum, ...(maximum !== undefined ? { maximum } : {}) });
const repoArg = str("リポジトリ（owner/name）");
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const requestId: Schema = { type: "string", description: "依頼 ID（任意）。同じ ID で再実行すると、完了済みなら結果を返し、失敗していればその段階から続ける", maxLength: 100 };
const fileSchema: Schema = {
  type: "array",
  description: "書き込む・削除するファイル",
  maxItems: 100,
  items: {
    type: "object",
    properties: {
      path: str("リポジトリ内のパス", 400),
      content: { type: "string", description: "内容（delete のときは省略）" },
      encoding: { type: "string", enum: ["utf-8", "base64"], description: "content の符号化（既定は utf-8）" },
      delete: { type: "boolean", description: "true ならこのファイルを削除する" },
    },
    required: ["path"],
  },
};
const mergeMethod: Schema = { type: "string", enum: ["squash", "merge", "rebase"], description: "マージの方法（既定は squash）" };
const SECRET_NAME = /^[A-Z_][A-Z0-9_]{0,99}$/;

async function ownedRepo(ctx: ToolContext, full: string): Promise<RepoRow> {
  const ref = checkRepoName(full);
  const r = await ctx.env.DB.prepare("SELECT * FROM repos WHERE owner_id = ? AND full_name = ?").bind(ctx.owner_id, `${ref.owner}/${ref.name}`).first<RepoRow>();
  if (!r) throw new OpError("repo_not_found", `${full} は Upbeater に登録されていません（register_repo で登録してください）`);
  return r;
}

async function ownedRun(ctx: ToolContext, id: string): Promise<RunRow> {
  if (!UUID.test(id)) throw new OpError("invalid_input", "run_id の形式が正しくありません");
  const r = await ctx.env.DB.prepare("SELECT * FROM runs WHERE id = ? AND owner_id = ?").bind(id, ctx.owner_id).first<RunRow>();
  if (!r) throw new OpError("run_not_found", "その実行は見つかりません");
  return r;
}

function gh(ctx: ToolContext): GitHubClient {
  return ctx.gh ?? createGitHubClient(ctx.env);
}

function opCtx(ctx: ToolContext): OpContext {
  return { env: ctx.env, gh: gh(ctx), owner_id: ctx.owner_id };
}

const parseJson = <T>(s: string | null): T | null => (s ? (JSON.parse(s) as T) : null);

/** ログの末尾 n 行（長すぎる時は文字数でも切る） */
function tail(text: string, lines: number, maxChars = 60_000): { text: string; truncated: boolean } {
  const all = text.split("\n");
  let out = all.slice(-lines).join("\n");
  let truncated = all.length > lines;
  if (out.length > maxChars) {
    out = out.slice(-maxChars);
    truncated = true;
  }
  return { text: out, truncated };
}

function migrationReport(results: ConvertResult[], skipped: string[]): string {
  const lines = ["GitHub Actions の定義を Upbeater の定義（`.upbeater/`）に変換しました。", ""];
  for (const r of results) {
    lines.push(`### ${r.source} → ${r.file}`);
    if (r.notes.length === 0 && r.problems.length === 0) lines.push("- そのまま変換できました");
    for (const n of r.notes) lines.push(`- ${n.level === "error" ? "✕ 変換できません" : "△ 注意"}（${n.file}:${n.line}）${n.message}`);
    for (const p of r.problems) lines.push(`- ✕ 変換後の定義の誤り（${p.file}:${p.line}:${p.column}）${p.message}`);
    lines.push("");
  }
  if (skipped.length) lines.push(`既にあるため書かなかったもの：${skipped.join("、")}`, "");
  lines.push("Upbeater で動くのを確かめてから、`.github/workflows` を消して Actions を止めてください。");
  return lines.join("\n");
}

export const TOOLS: Tool[] = [
  // ── リポジトリ ──
  {
    name: "list_repos",
    title: "リポジトリの一覧",
    description: "Upbeater に登録したリポジトリ。既定ブランチ、一時停止の有無、最後の実行（番号・状態・結果）を返す",
    inputSchema: { type: "object", properties: {} },
    annotations: { readOnlyHint: true },
    async run(ctx) {
      const r = await ctx.env.DB.prepare(
        `SELECT r.full_name AS repo, r.default_branch, r.paused, r.trigger_on_own_commits, r.created_at,
                (SELECT json_object('number', x.number, 'workflow', x.workflow_file, 'event', x.event, 'status', x.status, 'conclusion', x.conclusion, 'created_at', x.created_at)
                   FROM runs x WHERE x.repo_id = r.id ORDER BY x.number DESC LIMIT 1) AS last_run
         FROM repos r WHERE r.owner_id = ? ORDER BY r.full_name`,
      )
        .bind(ctx.owner_id)
        .all<{ paused: number; trigger_on_own_commits: number; last_run: string | null }>();
      return { ok: true, repos: r.results.map((x) => ({ ...x, paused: x.paused === 1, trigger_on_own_commits: x.trigger_on_own_commits === 1, last_run: parseJson(x.last_run) })) };
    },
  },
  {
    name: "register_repo",
    title: "リポジトリの登録",
    description: "リポジトリを Upbeater に登録する。GitHub App が入っているかを確かめ、既定ブランチを GitHub から読む。登録すると、更新の合図で .upbeater/*.yml が実行され、GitHub 操作もできるようになる",
    inputSchema: {
      type: "object",
      properties: { repo: repoArg, trigger_on_own_commits: { type: "boolean", description: "Upbeater 自身のコミットも合図にする（既定は false。無限の連鎖に注意）" } },
      required: ["repo"],
    },
    annotations: { idempotentHint: true },
    async run(ctx, a) {
      const ref = checkRepoName(a.repo as string);
      const full = `${ref.owner}/${ref.name}`;
      const existing = await ctx.env.DB.prepare("SELECT id, default_branch FROM repos WHERE owner_id = ? AND full_name = ?").bind(ctx.owner_id, full).first<{ id: string; default_branch: string }>();
      if (existing) return { ok: true, repo: full, default_branch: existing.default_branch, already_registered: true };
      let def: string;
      try {
        def = await gh(ctx).getDefaultBranch(ref);
      } catch (e) {
        if (e instanceof GitHubError && !e.retryable) {
          throw new OpError("app_not_installed", `${full} を読めません。GitHub App（Upbeater）をこのリポジトリに入れてください`, { needsHuman: true, details: { http_status: e.status } });
        }
        throw e;
      }
      const id = crypto.randomUUID();
      await ctx.env.DB.prepare("INSERT INTO repos (id, owner_id, full_name, default_branch, trigger_on_own_commits, created_at) VALUES (?, ?, ?, ?, ?, ?)")
        .bind(id, ctx.owner_id, full, def, a.trigger_on_own_commits === true ? 1 : 0, Date.now())
        .run();
      await recordOperation(ctx.env, { owner_id: ctx.owner_id, repo_id: id, kind: "repo", stage: "register", status: "ok", detail: { repo: full } });
      return { ok: true, repo: full, default_branch: def, note: "次の更新から実行されます（既定ブランチの定義は 10 分以内の照合でも読み込みます）" };
    },
  },
  {
    name: "pause",
    title: "一時停止・再開",
    description: "リポジトリの合図（push・PR・定期実行）での実行を止める／再開する。手動実行は止めない。再開すると、既定ブランチの最新に照合で追いつく",
    inputSchema: { type: "object", properties: { repo: repoArg, paused: { type: "boolean", description: "true で停止、false で再開（既定は true）" } }, required: ["repo"] },
    annotations: { idempotentHint: true },
    async run(ctx, a) {
      const repo = await ownedRepo(ctx, a.repo as string);
      const paused = a.paused !== false;
      // 再開したら、すぐ次の照合で追いつくようにする
      await ctx.env.DB.prepare("UPDATE repos SET paused = ?, last_reconciled_at = CASE WHEN ? = 0 THEN NULL ELSE last_reconciled_at END WHERE id = ?").bind(paused ? 1 : 0, paused ? 1 : 0, repo.id).run();
      await recordOperation(ctx.env, { owner_id: ctx.owner_id, repo_id: repo.id, kind: "repo", stage: paused ? "pause" : "resume", status: "ok" });
      return { ok: true, repo: repo.full_name, paused };
    },
  },

  // ── 実行 ──
  {
    name: "run_workflow",
    title: "手動実行",
    description: "定義ファイル（例 .upbeater/deploy.yml）を既定ブランチの最新のコミットで手動実行する。定義の on に manual が必要",
    inputSchema: {
      type: "object",
      properties: {
        repo: repoArg,
        workflow: str("定義ファイルのパス（例 .upbeater/deploy.yml）", 200),
        inputs: { type: "object", description: "入力（inputs.<名前> で参照できる）", properties: {}, additionalProperties: { type: "string", maxLength: 1000 } },
      },
      required: ["repo", "workflow"],
    },
    async run(ctx, a) {
      const repo = await ownedRepo(ctx, a.repo as string);
      const workflow = a.workflow as string;
      if (!/^\.upbeater\/[^/]+\.ya?ml$/.test(workflow)) throw new OpError("invalid_input", "workflow は .upbeater/<名前>.yml の形で指定してください");
      const r = await coordinatorCall<EventOutcome>(ctx.env, repo.id, "/event", {
        event: { kind: "manual", ref: `refs/heads/${repo.default_branch}`, branch: repo.default_branch, sha: null, actor: "mcp", isFork: false, workflowFile: workflow, inputs: a.inputs ?? {} },
        useDefaultBranch: true,
      });
      if (r.status === "created") {
        if (r.runs.length === 0) throw new OpError("no_run", `${workflow} は実行されませんでした（ファイルが無いか、on に manual がありません）`);
        return { ok: true, runs: r.runs };
      }
      if (r.status === "queued_retry") return { ok: true, queued: true, retry_at: r.retry_at, reason: r.reason, note: "GitHub に届かないため、待ち行列に残して再試行します" };
      throw new OpError(r.status === "failed" ? "github_error" : "skipped", r.reason, { needsHuman: r.status === "failed" });
    },
  },
  {
    name: "list_runs",
    title: "実行の一覧",
    description: "実行の一覧（新しい順）。リポジトリ・状態・結果で絞り込める",
    inputSchema: {
      type: "object",
      properties: {
        repo: repoArg,
        status: { type: "string", enum: ["queued", "running", "completed"], description: "状態で絞り込む" },
        conclusion: { type: "string", enum: ["success", "failure", "cancelled", "definition_error"], description: "結果で絞り込む" },
        limit: int("件数（既定 20、最大 100）", 1, 100),
      },
    },
    annotations: { readOnlyHint: true },
    async run(ctx, a) {
      const where = ["x.owner_id = ?"];
      const binds: unknown[] = [ctx.owner_id];
      if (a.repo) (where.push("x.repo_id = ?"), binds.push((await ownedRepo(ctx, a.repo as string)).id));
      if (a.status) (where.push("x.status = ?"), binds.push(a.status));
      if (a.conclusion) (where.push("x.conclusion = ?"), binds.push(a.conclusion));
      const r = await ctx.env.DB.prepare(
        `SELECT x.id AS run_id, r.full_name AS repo, x.number, x.workflow_file AS workflow, x.event, x.branch, x.sha, x.actor, x.status, x.conclusion, x.created_at, x.updated_at
         FROM runs x JOIN repos r ON r.id = x.repo_id WHERE ${where.join(" AND ")} ORDER BY x.created_at DESC LIMIT ${(a.limit as number | undefined) ?? 20}`,
      )
        .bind(...binds)
        .all();
      return { ok: true, runs: r.results };
    },
  },
  {
    name: "get_run",
    title: "実行の詳細",
    description: "実行の状況：ジョブごとの状態・理由・Runner と、手順ごとの状態・終了コード。定義の誤りがあれば行番号つきで返す",
    inputSchema: { type: "object", properties: { run_id: str("実行の ID", 36) }, required: ["run_id"] },
    annotations: { readOnlyHint: true },
    async run(ctx, a) {
      const run = await ownedRun(ctx, a.run_id as string);
      const repo = await ctx.env.DB.prepare("SELECT full_name FROM repos WHERE id = ?").bind(run.repo_id).first<{ full_name: string }>();
      const jobs = await ctx.env.DB.prepare(
        `SELECT j.id AS job_id, j.name, j.status, j.reason, j.attempt, j.runs_on, j.claimed_at, j.finished_at, n.name AS runner
         FROM jobs j LEFT JOIN runners n ON n.id = j.runner_id WHERE j.run_id = ? ORDER BY j.created_at`,
      )
        .bind(run.id)
        .all<{ job_id: string; attempt: number; runs_on: string }>();
      const steps = await ctx.env.DB.prepare(
        "SELECT s.job_id, s.attempt, s.idx, s.name, s.status, s.exit_code, s.started_at, s.finished_at FROM steps s JOIN jobs j ON j.id = s.job_id AND j.attempt = s.attempt WHERE j.run_id = ? ORDER BY s.idx",
      )
        .bind(run.id)
        .all<{ job_id: string }>();
      return {
        ok: true,
        run: { run_id: run.id, repo: repo?.full_name, number: run.number, workflow: run.workflow_file, event: run.event, branch: run.branch, sha: run.sha, actor: run.actor, status: run.status, conclusion: run.conclusion, problems: parseJson(run.problems), created_at: run.created_at, updated_at: run.updated_at },
        jobs: jobs.results.map((j) => ({ ...j, runs_on: parseJson(j.runs_on), steps: steps.results.filter((s) => s.job_id === j.job_id).map(({ job_id: _j, ...s }) => s) })),
      };
    },
  },
  {
    name: "get_logs",
    title: "ログ",
    description: "ジョブのログ（秘密情報は伏せてある）。既定は最新の回の末尾 200 行",
    inputSchema: {
      type: "object",
      properties: { job_id: str("ジョブの ID（get_run で分かる）", 36), attempt: int("回（既定は最新）", 1), lines: int("末尾の行数（既定 200、最大 2000）", 1, 2000) },
      required: ["job_id"],
    },
    annotations: { readOnlyHint: true },
    async run(ctx, a) {
      if (!UUID.test(a.job_id as string)) throw new OpError("invalid_input", "job_id の形式が正しくありません");
      const j = await ctx.env.DB.prepare("SELECT * FROM jobs WHERE id = ? AND owner_id = ?").bind(a.job_id, ctx.owner_id).first<JobRow>();
      if (!j) throw new OpError("job_not_found", "そのジョブは見つかりません");
      const attempt = (a.attempt as number | undefined) ?? j.attempt;
      if (attempt < 1 || attempt > Math.max(j.attempt, 1)) throw new OpError("invalid_input", `回は 1〜${Math.max(j.attempt, 1)} です`);
      const t = tail(await assembleLogs(ctx.env, j, attempt), (a.lines as number | undefined) ?? 200);
      return { ok: true, job_id: j.id, name: j.name, status: j.status, attempt, truncated: t.truncated, log: t.text };
    },
  },
  {
    name: "rerun",
    title: "再実行",
    description: "実行のうち、失敗・取り消しになったジョブ（とその後のジョブ）を再実行する",
    inputSchema: { type: "object", properties: { run_id: str("実行の ID", 36) }, required: ["run_id"] },
    async run(ctx, a) {
      const run = await ownedRun(ctx, a.run_id as string);
      const r = await coordinatorCall<{ jobs: number }>(ctx.env, run.repo_id, "/rerun", { run_id: run.id });
      if (!r.jobs) throw new OpError("nothing_to_rerun", "再実行するジョブがありません（失敗・取り消しのジョブが無いか、実行中です）");
      return { ok: true, run_id: run.id, jobs: r.jobs };
    },
  },
  {
    name: "cancel",
    title: "取り消し",
    description: "実行を取り消す。実行中のジョブには Runner に中断を指示する",
    inputSchema: { type: "object", properties: { run_id: str("実行の ID", 36) }, required: ["run_id"] },
    annotations: { destructiveHint: true, idempotentHint: true },
    async run(ctx, a) {
      const run = await ownedRun(ctx, a.run_id as string);
      if (run.status === "completed") return { ok: true, run_id: run.id, already_completed: true, conclusion: run.conclusion };
      await coordinatorCall(ctx.env, run.repo_id, "/cancel", { run_id: run.id });
      return { ok: true, run_id: run.id, cancelled: true };
    },
  },
  {
    name: "list_runners",
    title: "Runner の一覧",
    description: "登録した Runner。ラベル、最後の連絡、いま動かしているジョブ",
    inputSchema: { type: "object", properties: {} },
    annotations: { readOnlyHint: true },
    async run(ctx) {
      const r = await ctx.env.DB.prepare(
        `SELECT n.id AS runner_id, n.name, n.labels, n.created_at, n.last_seen_at, n.revoked_at,
                (SELECT json_group_array(json_object('job_id', j.id, 'name', j.name)) FROM jobs j WHERE j.runner_id = n.id AND j.status = 'claimed') AS running
         FROM runners n WHERE n.owner_id = ? AND (n.ephemeral = 0 OR n.expires_at > ?) ORDER BY n.name`,
      )
        .bind(ctx.owner_id, Date.now())
        .all<{ labels: string; running: string; last_seen_at: number | null }>();
      const now = Date.now();
      return {
        ok: true,
        runners: r.results.map((x) => ({ ...x, labels: parseJson(x.labels), running: parseJson(x.running), online: x.last_seen_at !== null && now - x.last_seen_at < 2 * 60_000 })),
      };
    },
  },
  {
    name: "list_operations",
    title: "操作の記録",
    description: "すべての操作の段階・結果・理由（新しい順）。needs_human_only で人の判断が要る失敗だけに絞れる",
    inputSchema: {
      type: "object",
      properties: { repo: repoArg, needs_human_only: { type: "boolean", description: "人の判断が要る失敗だけ" }, kind: str("種類（event・run・job・github・repo など）", 40), limit: int("件数（既定 30、最大 200）", 1, 200) },
    },
    annotations: { readOnlyHint: true },
    async run(ctx, a) {
      const where = ["o.owner_id = ?"];
      const binds: unknown[] = [ctx.owner_id];
      if (a.repo) (where.push("o.repo_id = ?"), binds.push((await ownedRepo(ctx, a.repo as string)).id));
      if (a.needs_human_only) where.push("o.needs_human = 1");
      if (a.kind) (where.push("o.kind = ?"), binds.push(a.kind));
      const r = await ctx.env.DB.prepare(
        `SELECT o.id, r.full_name AS repo, o.run_id, o.job_id, o.kind, o.stage, o.status, o.reason, o.retryable, o.needs_human, o.detail, o.created_at
         FROM operations o LEFT JOIN repos r ON r.id = o.repo_id WHERE ${where.join(" AND ")} ORDER BY o.id DESC LIMIT ${(a.limit as number | undefined) ?? 30}`,
      )
        .bind(...binds)
        .all<{ detail: string | null; retryable: number; needs_human: number }>();
      return { ok: true, operations: r.results.map((o) => ({ ...o, retryable: o.retryable === 1, needs_human: o.needs_human === 1, detail: parseJson(o.detail) })) };
    },
  },

  // ── 移行 ──
  {
    name: "migrate_workflows",
    title: "Actions の定義の移行",
    description:
      "リポジトリの .github/workflows/*.yml を Upbeater の定義（.upbeater/*.yml）に変換し、PR にする（マージはしない）。変換できない所は行番号つきで報告し、定義ではその手順を失敗させて黙って抜け落ちないようにする。check: true なら PR を作らず報告だけ",
    inputSchema: {
      type: "object",
      properties: {
        repo: repoArg,
        check: { type: "boolean", description: "true なら報告だけ（PR を作らない）" },
        labels: { type: "object", description: "runs-on のラベルの置き換え（例 { \"linux\": \"macos\" }）", properties: {}, additionalProperties: { type: "string", maxLength: 50 } },
        overwrite: { type: "boolean", description: "既にある .upbeater の定義も書き直す（既定は false）" },
        branch: str("作業ブランチ（既定 upbeater-migration）"),
        request_id: requestId,
      },
      required: ["repo"],
    },
    async run(ctx, a) {
      const repo = await ownedRepo(ctx, a.repo as string);
      const ref = parseRepo(repo.full_name);
      const client = gh(ctx);
      const head = await client.getBranchHead(ref, repo.default_branch);
      if (!head) throw new OpError("branch_not_found", `既定ブランチ（${repo.default_branch}）が見つかりません`, { needsHuman: true });
      const sources = await client.listYamlFiles(ref, head, ".github/workflows");
      if (sources.length === 0) throw new OpError("no_workflows", `${repo.full_name} に .github/workflows/*.yml がありません`);
      const existing = new Set((await client.listWorkflowFiles(ref, head)).map((f) => f.path));
      const results = sources.map((f) => convertWorkflow(f.path, f.text, { labels: (a.labels as Record<string, string> | undefined) ?? {} }));
      const files: FileChange[] = [];
      const skipped: string[] = [];
      for (const r of results) {
        if (!r.text) continue;
        if (existing.has(r.file) && !a.overwrite) skipped.push(r.file);
        else files.push({ path: r.file, content: r.text });
      }
      const summary = results.map((r) => ({
        source: r.source,
        file: r.file,
        errors: r.notes.filter((n) => n.level === "error").length + r.problems.length,
        warnings: r.notes.filter((n) => n.level === "warning").length,
        notes: r.notes,
        problems: r.problems,
      }));
      const report = migrationReport(results, skipped);
      if (a.check || files.length === 0) return { ok: true, check: true, files: summary, skipped, ...(files.length === 0 && !a.check ? { note: "書く定義がありません（既にある定義は overwrite: true で書き直せます）" } : {}) };
      const branch = checkBranchName((a.branch as string | undefined) ?? "upbeater-migration");
      const r = await shipChangeOp(
        opCtx(ctx),
        { repo: repo.full_name, branch, title: "GitHub Actions の定義を Upbeater に移行", body: report, files, merge: false, request_id: a.request_id as string | undefined },
        "migrate_workflows",
      );
      return r.ok ? { ...r, files: summary, skipped } : r;
    },
  },

  // ── 秘密情報 ──
  {
    name: "list_secrets",
    title: "秘密情報の一覧",
    description: "登録した秘密情報の名前と対象（値は返さない）。repo を省くと全リポジトリ共通のものも含めてすべて",
    inputSchema: { type: "object", properties: { repo: repoArg } },
    annotations: { readOnlyHint: true },
    async run(ctx, a) {
      const where = ["s.owner_id = ?"];
      const binds: unknown[] = [ctx.owner_id];
      if (a.repo) (where.push("(s.repo_id = ? OR s.repo_id = '')"), binds.push((await ownedRepo(ctx, a.repo as string)).id));
      const r = await ctx.env.DB.prepare(`SELECT s.name, COALESCE(r.full_name, '（全リポジトリ共通）') AS scope, s.updated_at FROM secrets s LEFT JOIN repos r ON r.id = s.repo_id WHERE ${where.join(" AND ")} ORDER BY s.name`)
        .bind(...binds)
        .all();
      return { ok: true, secrets: r.results };
    },
  },
  {
    name: "request_secrets",
    title: "秘密情報の入力ページ",
    description:
      "秘密情報の値を入れてもらうページ（一回限り・スマホで開ける）の URL を発行する。値はチャットに書かせず、この URL を利用者に渡して入れてもらう。同じリポジトリの、まだ使っていない前のページは使えなくなる",
    inputSchema: {
      type: "object",
      properties: { repo: { type: "string", description: "対象のリポジトリ（owner/name）。省くと全リポジトリ共通", maxLength: 200 }, names: { type: "array", items: str("名前（英大文字・数字・_）", 100), maxItems: 30, description: "入れてもらう名前（例 CLOUDFLARE_API_TOKEN）" } },
      required: ["names"],
    },
    async run(ctx, a) {
      const names = a.names as string[];
      for (const n of names) if (!SECRET_NAME.test(n)) throw new OpError("invalid_input", `名前「${n}」は使えません（英大文字・数字・_）`);
      const repoId = a.repo ? (await ownedRepo(ctx, a.repo as string)).id : "";
      if (!ctx.origin) throw new OpError("internal_error", "Hub の URL が分かりません", { retryable: true });
      const res = await createSecretForm(ctx.env, ctx.origin, ctx.owner_id, repoId, names);
      const b = (await res.json()) as { url: string; names: string[] };
      await recordOperation(ctx.env, { owner_id: ctx.owner_id, repo_id: repoId || null, kind: "secret", stage: "form_issued", status: "ok", detail: { names: b.names } });
      return { ok: true, url: b.url, names: b.names, note: "この URL を利用者に渡し、値を入れてもらってください（一回限り）" };
    },
  },

  // ── GitHub 操作 ──
  {
    name: "create_branch",
    title: "ブランチの作成",
    description: "作業ブランチを作る（既にあればそのまま使う）",
    inputSchema: { type: "object", properties: { repo: repoArg, branch: str("作るブランチ"), from: str("元のブランチ（既定はリポジトリの既定ブランチ）"), request_id: requestId }, required: ["repo", "branch"] },
    async run(ctx, a) {
      return createBranchOp(opCtx(ctx), a as Parameters<typeof createBranchOp>[1]);
    },
  },
  {
    name: "commit_files",
    title: "コミット",
    description: "作業ブランチにファイルの追加・変更・削除を 1 つのコミットとして書き込む。既定ブランチ（main）への直接書き込みは禁止",
    inputSchema: {
      type: "object",
      properties: { repo: repoArg, branch: str("書き込むブランチ"), message: str("コミットメッセージ", 2000), files: fileSchema, request_id: requestId },
      required: ["repo", "branch", "message", "files"],
    },
    async run(ctx, a) {
      return commitFilesOp(opCtx(ctx), a as { repo: string; branch: string; message: string; files: FileChange[]; request_id?: string });
    },
  },
  {
    name: "open_pr",
    title: "PR の作成",
    description: "PR を作る（同じブランチの PR が既にあればそれを返す）",
    inputSchema: {
      type: "object",
      properties: { repo: repoArg, head: str("作業ブランチ"), base: str("取り込み先（既定はリポジトリの既定ブランチ）"), title: str("題名", 256), body: str("説明", 60000), request_id: requestId },
      required: ["repo", "head", "title"],
    },
    async run(ctx, a) {
      return openPrOp(opCtx(ctx), a as Parameters<typeof openPrOp>[1]);
    },
  },
  {
    name: "merge_pr",
    title: "PR のマージ",
    description:
      "マージ前に衝突を確認し、衝突していれば main を取り込んで再試行する。解消できなければ PR を残し、衝突しうるファイルを返す。ブランチ保護・必須の検査で止まる場合は満たせない条件を返す",
    inputSchema: { type: "object", properties: { repo: repoArg, number: int("PR の番号", 1), method: mergeMethod, request_id: requestId }, required: ["repo", "number"] },
    annotations: { destructiveHint: true },
    async run(ctx, a) {
      return mergePrOp(opCtx(ctx), a as Parameters<typeof mergePrOp>[1]);
    },
  },
  {
    name: "ship_change",
    title: "変更を一続きで反映",
    description:
      "ブランチ作成 → コミット → PR → マージを一続きで行う。失敗した場合は段階・理由・再試行の可否を返し、同じ request_id で呼び直すと失敗した段階から続ける。マージ後は .upbeater の定義に従って自動処理が始まる",
    inputSchema: {
      type: "object",
      properties: {
        repo: repoArg,
        branch: str("作業ブランチ"),
        title: str("PR の題名", 256),
        message: str("コミットメッセージ（既定は題名）", 2000),
        body: str("PR の説明", 60000),
        base: str("取り込み先（既定はリポジトリの既定ブランチ）"),
        files: fileSchema,
        merge: { type: "boolean", description: "false なら PR の作成までで止める（既定は true）" },
        method: mergeMethod,
        request_id: requestId,
      },
      required: ["repo", "branch", "title", "files"],
    },
    annotations: { destructiveHint: true },
    async run(ctx, a) {
      return shipChangeOp(opCtx(ctx), a as unknown as Parameters<typeof shipChangeOp>[1]);
    },
  },
  {
    name: "get_request",
    title: "GitHub 操作の状況",
    description: "依頼 ID の GitHub 操作の状況（実行中・成功・失敗、最後の段階、結果または失敗の理由）",
    inputSchema: { type: "object", properties: { request_id: str("依頼 ID", 100) }, required: ["request_id"] },
    annotations: { readOnlyHint: true },
    async run(ctx, a) {
      const r = await ctx.env.DB.prepare("SELECT request_id, tool, status, stage, result, error, created_at, updated_at FROM github_requests WHERE owner_id = ? AND request_id = ?")
        .bind(ctx.owner_id, a.request_id)
        .first<{ result: string | null; error: string | null }>();
      if (!r) return { ok: false, code: "not_found", reason: "その依頼 ID は見つかりません" };
      return { ok: true, ...r, result: parseJson(r.result), error: parseJson(r.error) };
    },
  },
];

/** 道具を実行する。失敗は例外にせず、段階・理由・再試行の可否として返す */
export async function callTool(ctx: ToolContext, name: string, rawArgs: unknown): Promise<ToolResult> {
  const tool = TOOLS.find((t) => t.name === name);
  if (!tool) throw new InvalidParams(`道具「${name}」はありません`);
  const args = validate(tool.inputSchema, rawArgs) as Record<string, unknown>;
  try {
    return await tool.run(ctx, args);
  } catch (e) {
    if (e instanceof OpError) return { ok: false, stage: name, code: e.code, reason: e.message, retryable: e.opts.retryable ?? false, needs_human: e.opts.needsHuman ?? false, ...(e.opts.details ? { details: e.opts.details } : {}) };
    if (e instanceof GitHubError) return { ok: false, stage: name, code: "github_error", reason: e.message, retryable: e.retryable, needs_human: e.needsHuman };
    if (e instanceof HttpError) return { ok: false, stage: name, code: e.code, reason: e.message, retryable: false, needs_human: false };
    console.error("道具の実行に失敗", name);
    return { ok: false, stage: name, code: "internal_error", reason: "一時的な内部エラー", retryable: true, needs_human: false };
  }
}
