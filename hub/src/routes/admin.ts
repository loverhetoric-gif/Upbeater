/**
 * 管理 API（暫定。開発順序4で MCP から呼ぶ）
 * - POST /v1/admin/repos                      リポジトリの登録
 * - PUT  /v1/admin/secrets                    秘密情報の登録（値は返さない）／GET で名前の一覧
 * - POST /v1/admin/runner-codes               Runner の一回限りの登録コード
 * - POST /v1/admin/runs                       手動実行
 * - GET  /v1/admin/runs/:id                   実行の状況（ジョブ・手順）
 * - POST /v1/admin/runs/:id/cancel|rerun      取り消し・失敗したジョブの再実行
 * - GET  /v1/admin/jobs/:id/logs              ログ（通番の順。秘密情報は伏せる）
 * - POST /v1/admin/secret-forms               秘密情報の入力ページ（一回限り・期限なし）を発行する
 */
import { coordinatorCall, type EventOutcome } from "../coordinator";
import { randomCode, sha256Hex, timingSafeEqual } from "../crypto";
import type { Env, JobRow, RepoRow, RunRow } from "../env";
import { bearer, HttpError, int, json, readJson, str } from "../http";
import { putSecret } from "../secrets";
import { createSecretForm } from "./secret-form";
import { assembleLogs } from "./runner";

const ID = /^[A-Za-z0-9:_-]{1,64}$/;
const REPO = /^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/;

export async function requireAdmin(req: Request, env: Env): Promise<void> {
  const t = bearer(req);
  if (!env.ADMIN_TOKEN || !t || !timingSafeEqual(await sha256Hex(t), await sha256Hex(env.ADMIN_TOKEN))) throw new HttpError(401, "unauthorized");
}

async function repoOf(env: Env, owner: string, full: string): Promise<RepoRow> {
  const r = await env.DB.prepare("SELECT * FROM repos WHERE owner_id = ? AND full_name = ?").bind(owner, full.toLowerCase()).first<RepoRow>();
  if (!r) throw new HttpError(404, "repo_not_found");
  return r;
}

export async function handleAdmin(req: Request, env: Env, p: string): Promise<Response> {
  await requireAdmin(req, env);
  const m = req.method;
  if (p === "/v1/admin/repos" && m === "POST") {
    const b = await readJson(req);
    const owner = str(b.owner_id, "owner_id", { pattern: ID });
    const full = str(b.repo, "repo", { pattern: REPO }).toLowerCase();
    const id = crypto.randomUUID();
    try {
      await env.DB.prepare("INSERT INTO repos (id, owner_id, full_name, default_branch, trigger_on_own_commits, created_at) VALUES (?, ?, ?, ?, ?, ?)")
        .bind(id, owner, full, str(b.default_branch ?? "main", "default_branch", { max: 200 }), b.trigger_on_own_commits === true ? 1 : 0, Date.now())
        .run();
    } catch (e) {
      if (e instanceof Error && /UNIQUE/i.test(e.message)) throw new HttpError(409, "repo_exists");
      throw e;
    }
    return json({ id }, 201);
  }
  if (p === "/v1/admin/secrets" && m === "PUT") {
    const b = await readJson(req);
    const owner = str(b.owner_id, "owner_id", { pattern: ID });
    const repo = b.repo ? (await repoOf(env, owner, str(b.repo, "repo", { pattern: REPO }))).id : "";
    const name = str(b.name, "name", { pattern: /^[A-Z_][A-Z0-9_]{0,99}$/ });
    const value = str(b.value, "value", { max: 64 * 1024 });
    await putSecret(env, owner, repo, name, value);
    return json({ ok: true, name });
  }
  if (p === "/v1/admin/secret-forms" && m === "POST") {
    const b = await readJson(req);
    const owner = str(b.owner_id, "owner_id", { pattern: ID });
    const repo = b.repo ? (await repoOf(env, owner, str(b.repo, "repo", { pattern: REPO }))).id : "";
    return createSecretForm(env, new URL(req.url).origin, owner, repo, b.names);
  }
  if (p === "/v1/admin/secrets" && m === "GET") {
    const owner = str(new URL(req.url).searchParams.get("owner_id"), "owner_id", { pattern: ID });
    const r = await env.DB.prepare("SELECT s.name, COALESCE(r.full_name, '') AS repo, s.updated_at FROM secrets s LEFT JOIN repos r ON r.id = s.repo_id WHERE s.owner_id = ? ORDER BY s.name")
      .bind(owner)
      .all();
    return json({ secrets: r.results });
  }
  if (p === "/v1/admin/runner-codes" && m === "POST") {
    const b = await readJson(req);
    const owner = str(b.owner_id, "owner_id", { pattern: ID });
    const code = randomCode(10);
    const expiresAt = Date.now() + 15 * 60_000;
    await env.DB.prepare("INSERT INTO runner_registration_codes (code_hash, owner_id, expires_at, created_at) VALUES (?, ?, ?, ?)")
      .bind(await sha256Hex("runner." + code), owner, expiresAt, Date.now())
      .run();
    return json({ code, expires_at: expiresAt }, 201);
  }
  if (p === "/v1/admin/runs" && m === "POST") {
    const b = await readJson(req);
    const owner = str(b.owner_id, "owner_id", { pattern: ID });
    const repo = await repoOf(env, owner, str(b.repo, "repo", { pattern: REPO }));
    const workflow = str(b.workflow, "workflow", { max: 200 });
    const inputs = b.inputs && typeof b.inputs === "object" ? (b.inputs as Record<string, string>) : {};
    const r = await coordinatorCall<EventOutcome>(env, repo.id, "/event", {
      event: { kind: "manual", ref: `refs/heads/${repo.default_branch}`, branch: repo.default_branch, sha: null, actor: "manual", isFork: false, workflowFile: workflow, inputs },
      useDefaultBranch: true,
    });
    return json(r, r.status === "created" ? 201 : 202);
  }
  const run = /^\/v1\/admin\/runs\/([0-9a-f-]{36})(?:\/(cancel|rerun))?$/.exec(p);
  if (run) {
    const r = await env.DB.prepare("SELECT * FROM runs WHERE id = ?").bind(run[1]).first<RunRow>();
    if (!r) throw new HttpError(404, "run_not_found");
    if (run[2] && m === "POST") return json(await coordinatorCall(env, r.repo_id, `/${run[2]}`, { run_id: r.id }));
    const jobs = await env.DB.prepare("SELECT id, job_key, name, status, reason, attempt, runs_on, concurrency_group, runner_id FROM jobs WHERE run_id = ? ORDER BY created_at").bind(r.id).all();
    return json({ run: { ...r, problems: r.problems ? JSON.parse(r.problems) : null }, jobs: jobs.results });
  }
  const logs = /^\/v1\/admin\/jobs\/([0-9a-f-]{36})\/logs$/.exec(p);
  if (logs && m === "GET") {
    const j = await env.DB.prepare("SELECT * FROM jobs WHERE id = ?").bind(logs[1]).first<JobRow>();
    if (!j) throw new HttpError(404, "job_not_found");
    const attempt = new URL(req.url).searchParams.get("attempt");
    const text = await assembleLogs(env, j, attempt ? int(Number(attempt), "attempt", 1) : j.attempt);
    return new Response(text, { headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" } });
  }
  throw new HttpError(404, "not_found");
}
