/**
 * Runner 用 API（Runner から Hub へ取りに来る方式。受け口を外部に開けない）
 * - POST /v1/runners/register             登録コード → Runner トークン（Hub はハッシュのみ保存）
 * - POST /v1/runners/claim                ラベルに合うジョブを 1 件受け取る（同じジョブを二重に渡さない）
 * - POST /v1/runners/jobs/:id/heartbeat   心拍。取り消し・時間超過なら中断を指示する
 * - POST /v1/runners/jobs/:id/logs        ログの断片（通番つき。重複・順不同を許し、欠けている通番を返す）
 * - POST /v1/runners/jobs/:id/steps       手順ごとの状態
 * - POST /v1/runners/jobs/:id/complete    終了の報告
 * ジョブごとの報告は、受け取った時に渡したジョブトークンが必要（再実行に移った古い実行の報告は受け付けない）。
 */
import { coordinatorCall } from "../coordinator";
import { normalizeCode, randomToken, sha256Hex } from "../crypto";
import type { Env, JobRow, JobSpec, RepoRow, RunRow } from "../env";
import { createGitHubTokenProvider, GitHubError, parseRepo } from "../github";
import { bearer, HttpError, int, json, readJson, str } from "../http";
import { operationStatement } from "../operations";
import { Masker, resolveSecrets } from "../secrets";

export const RUNNER_TOKEN_PREFIX = "upb_r_";
export const HEARTBEAT_INTERVAL_MS = 30_000;
/** 心拍がこの時間途絶えたら、Runner が落ちたとみなす */
export const HEARTBEAT_TIMEOUT_MS = 2 * 60_000;
export const MAX_ATTEMPTS = 3;
const MAX_CHUNK = 256 * 1024;

interface RunnerRow {
  id: string;
  owner_id: string;
  name: string;
  labels: string;
}

export async function authRunner(req: Request, env: Env): Promise<RunnerRow> {
  const t = bearer(req);
  if (!t || !t.startsWith(RUNNER_TOKEN_PREFIX)) throw new HttpError(401, "unauthorized");
  const r = await env.DB.prepare("SELECT id, owner_id, name, labels FROM runners WHERE token_hash = ? AND revoked_at IS NULL").bind(await sha256Hex(t)).first<RunnerRow>();
  if (!r) throw new HttpError(401, "unauthorized");
  return r;
}

/** このジョブの現在の実行であることを確かめる（二重実行の防止） */
export async function authJob(req: Request, env: Env, runner: RunnerRow, id: string, allowFinished = false): Promise<JobRow> {
  const job = await env.DB.prepare("SELECT * FROM jobs WHERE id = ? AND owner_id = ?").bind(id, runner.owner_id).first<JobRow>();
  if (!job) throw new HttpError(404, "job_not_found");
  const token = req.headers.get("x-upbeater-job-token") ?? "";
  if (job.runner_id !== runner.id || !job.job_token_hash || (await sha256Hex(token)) !== job.job_token_hash) {
    throw new HttpError(409, "stale_job", "このジョブは別の実行に移っています。実行を中止してください");
  }
  if (!allowFinished && job.status !== "claimed") throw new HttpError(409, "job_not_active", `このジョブは ${job.status} です`);
  return job;
}

export async function handleRegisterRunner(req: Request, env: Env): Promise<Response> {
  const b = await readJson(req);
  const code = normalizeCode(str(b.code, "code", { max: 64 }));
  const name = str(b.name, "name", { max: 100 });
  const labels = Array.isArray(b.labels) ? [...new Set(b.labels.filter((l): l is string => typeof l === "string" && /^[A-Za-z0-9._-]{1,50}$/.test(l)))] : [];
  if (labels.length === 0) throw new HttpError(400, "invalid_labels", "ラベル（例：linux・macos）を指定してください");
  const now = Date.now();
  const id = crypto.randomUUID();
  const token = randomToken(RUNNER_TOKEN_PREFIX);
  const codeHash = await sha256Hex("runner." + code);
  const results = await env.DB.batch([
    env.DB.prepare("UPDATE runner_registration_codes SET used_at = ?, runner_id = ? WHERE code_hash = ? AND used_at IS NULL AND expires_at > ?").bind(now, id, codeHash, now),
    env.DB.prepare(
      `INSERT INTO runners (id, owner_id, name, labels, token_hash, created_at, last_seen_at)
       SELECT ?, owner_id, ?, ?, ?, ?, ? FROM runner_registration_codes WHERE code_hash = ? AND runner_id = ?`,
    ).bind(id, name, JSON.stringify(labels), await sha256Hex(token), now, now, codeHash, id),
  ]);
  if ((results[1]?.meta.changes ?? 0) !== 1) throw new HttpError(400, "invalid_code", "登録コードが無効か、期限切れか、使用済みです");
  return json({ runner_id: id, token, labels }, 201);
}

export async function handleClaim(req: Request, env: Env): Promise<Response> {
  const runner = await authRunner(req, env);
  const b = await readJson(req).catch(() => ({}) as Record<string, unknown>);
  const labels = Array.isArray(b.labels) && b.labels.length ? b.labels.filter((l): l is string => typeof l === "string") : (JSON.parse(runner.labels) as string[]);
  const now = Date.now();
  await env.DB.prepare("UPDATE runners SET last_seen_at = ?, labels = ? WHERE id = ?").bind(now, JSON.stringify(labels), runner.id).run();
  const token = randomToken("upb_j_");
  // runs-on のラベルがすべてこの Runner にあるジョブを、古い順に 1 件だけ受け取る（UPDATE は 1 件ずつ直列に実行される）
  const job = await env.DB.prepare(
    `UPDATE jobs SET status = 'claimed', runner_id = ?, job_token_hash = ?, attempt = attempt + 1, claimed_at = ?, heartbeat_at = ?, cancel_requested = 0, updated_at = ?
     WHERE id = (
       SELECT j.id FROM jobs j WHERE j.owner_id = ? AND j.status = 'queued'
         AND NOT EXISTS (SELECT 1 FROM json_each(j.runs_on) l WHERE l.value NOT IN (SELECT value FROM json_each(?)))
       ORDER BY j.created_at, j.id LIMIT 1)
       AND status = 'queued'
     RETURNING *`,
  )
    .bind(runner.id, await sha256Hex(token), now, now, now, runner.owner_id, JSON.stringify(labels))
    .first<JobRow>();
  if (!job) return new Response(null, { status: 204 });

  const run = (await env.DB.prepare("SELECT * FROM runs WHERE id = ?").bind(job.run_id).first<RunRow>())!;
  const repo = (await env.DB.prepare("SELECT * FROM repos WHERE id = ?").bind(job.repo_id).first<RepoRow>())!;
  const spec = JSON.parse(job.spec) as JobSpec;

  // 取得用の短期トークン（GitHub App のインストールトークン）
  let authHeader: string | null = null;
  try {
    const t = await createGitHubTokenProvider(env).getToken(parseRepo(repo.full_name));
    if (t) authHeader = `Authorization: Basic ${btoa(`x-access-token:${t}`)}`;
  } catch (e) {
    if (!(e instanceof GitHubError) || e.retryable) {
      // 一時的な失敗：受け取りを取り消して待ち行列に戻す（回数は数えない）
      await env.DB.prepare("UPDATE jobs SET status = 'queued', runner_id = NULL, job_token_hash = NULL, attempt = attempt - 1, claimed_at = NULL WHERE id = ?").bind(job.id).run();
      return json({ error: "github_unavailable" }, 503, { "retry-after": "30" });
    }
    await env.DB.prepare("UPDATE jobs SET status = 'failed', reason = ?, finished_at = ?, updated_at = ? WHERE id = ?").bind(e.message, now, now, job.id).run();
    await coordinatorCall(env, repo.id, "/advance", { job_id: job.id });
    return json({ error: "job_failed", reason: e.message }, 409);
  }

  // 秘密情報：このジョブに指定された分だけ渡す。フォークからの PR には渡さない
  const secrets = run.is_fork ? {} : await resolveSecrets(env, repo.owner_id, repo.id, spec.secrets);
  await env.DB.batch([
    env.DB.prepare("UPDATE runs SET status = 'running', updated_at = ? WHERE id = ? AND status = 'queued'").bind(now, run.id),
    operationStatement(env, { owner_id: repo.owner_id, repo_id: repo.id, run_id: run.id, job_id: job.id, kind: "job", stage: "claimed", status: "ok", detail: { runner: runner.name, attempt: job.attempt, secrets_withheld: run.is_fork === 1 && spec.secrets.length > 0 } }, now),
  ]);
  await coordinatorCall(env, repo.id, "/advance-run", { run_id: run.id }).catch(() => undefined);
  const web = (env.GITHUB_WEB_BASE || "https://github.com").replace(/\/$/, "");
  return json({
    job: {
      id: job.id,
      attempt: job.attempt,
      name: job.name,
      job_key: job.job_key,
      run_id: run.id,
      run_number: run.number,
      matrix: job.matrix ? JSON.parse(job.matrix) : null,
      timeout_minutes: spec.timeout,
      rerunnable: job.rerunnable === 1,
    },
    job_token: token,
    repo: { full_name: repo.full_name, clone_url: `${web}/${repo.full_name}.git`, sha: run.sha, ref: run.ref, auth_header: authHeader },
    event: { kind: run.event, branch: run.branch, actor: run.actor, inputs: run.inputs ? JSON.parse(run.inputs) : {} },
    steps: spec.steps,
    env: { ...spec.env, CI: "true", UPBEATER: "true", UPBEATER_RUN_NUMBER: String(run.number), UPBEATER_SHA: run.sha, UPBEATER_REF: run.ref ?? "", UPBEATER_EVENT: run.event },
    secrets,
    secrets_withheld: run.is_fork === 1 && spec.secrets.length > 0,
    artifacts: spec.artifacts,
    cache: spec.cache ?? null,
    heartbeat_interval_ms: HEARTBEAT_INTERVAL_MS,
  });
}

export async function handleHeartbeat(req: Request, env: Env, id: string): Promise<Response> {
  const runner = await authRunner(req, env);
  const job = await authJob(req, env, runner, id, true);
  if (job.status !== "claimed") return json({ continue: false, status: job.status, reason: job.reason });
  const now = Date.now();
  await env.DB.batch([
    env.DB.prepare("UPDATE jobs SET heartbeat_at = ?, updated_at = ? WHERE id = ? AND status = 'claimed'").bind(now, now, id),
    env.DB.prepare("UPDATE runners SET last_seen_at = ? WHERE id = ?").bind(now, runner.id),
  ]);
  return json({ continue: job.cancel_requested === 0, cancel: job.cancel_requested === 1 });
}

/** ジョブの秘密情報で伏せる（同じ isolate では使い回す） */
const maskerCache = new Map<string, { masker: Masker; at: number }>();
async function maskerFor(env: Env, job: JobRow): Promise<Masker> {
  const key = `${job.id}:${job.attempt}`;
  const hit = maskerCache.get(key);
  if (hit && Date.now() - hit.at < 10 * 60_000) return hit.masker;
  const spec = JSON.parse(job.spec) as JobSpec;
  const values = Object.values(await resolveSecrets(env, job.owner_id, job.repo_id, spec.secrets));
  const masker = new Masker(values);
  if (maskerCache.size > 500) maskerCache.clear();
  maskerCache.set(key, { masker, at: Date.now() });
  return masker;
}

async function missingSeqs(env: Env, job: JobRow, upTo: number): Promise<{ contiguous: number; missing: number[] }> {
  const rows = await env.DB.prepare("SELECT seq FROM log_chunks WHERE job_id = ? AND attempt = ? ORDER BY seq").bind(job.id, job.attempt).all<{ seq: number }>();
  const have = new Set(rows.results.map((r) => r.seq));
  const max = Math.max(upTo, ...rows.results.map((r) => r.seq), 0);
  const missing: number[] = [];
  let contiguous = 0;
  for (let s = 1; s <= max; s++) {
    if (have.has(s)) {
      if (missing.length === 0) contiguous = s;
    } else missing.push(s);
  }
  return { contiguous, missing: missing.slice(0, 1000) };
}

export async function handleLogs(req: Request, env: Env, id: string): Promise<Response> {
  const runner = await authRunner(req, env);
  // 終了の報告の後でも、欠けていた断片の再送は受け付ける
  const job = await authJob(req, env, runner, id, true);
  const b = await readJson(req, 2 * 1024 * 1024);
  if (!Array.isArray(b.chunks)) throw new HttpError(400, "invalid_chunks");
  const masker = await maskerFor(env, job);
  const now = Date.now();
  for (const c of b.chunks as { seq?: unknown; text?: unknown }[]) {
    const seq = int(c.seq, "seq", 1);
    if (typeof c.text !== "string" || c.text.length > MAX_CHUNK) throw new HttpError(400, "invalid_chunk");
    const key = `logs/${job.owner_id}/${job.id}/${job.attempt}/${String(seq).padStart(8, "0")}`;
    // 同じ通番の再送は捨てる（冪等）
    const ins = await env.DB.prepare("INSERT OR IGNORE INTO log_chunks (owner_id, job_id, attempt, seq, r2_key, size, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .bind(job.owner_id, job.id, job.attempt, seq, key, c.text.length, now)
      .run();
    if ((ins.meta.changes ?? 0) === 1) {
      try {
        await env.BLOBS.put(key, masker.mask(c.text));
      } catch (e) {
        await env.DB.prepare("DELETE FROM log_chunks WHERE job_id = ? AND attempt = ? AND seq = ?").bind(job.id, job.attempt, seq).run();
        throw e;
      }
    }
  }
  const m = await missingSeqs(env, job, typeof b.last_seq === "number" ? b.last_seq : 0);
  return json({ ok: true, contiguous_through: m.contiguous, missing: m.missing });
}

export async function handleStep(req: Request, env: Env, id: string): Promise<Response> {
  const runner = await authRunner(req, env);
  const job = await authJob(req, env, runner, id);
  const b = await readJson(req);
  const idx = int(b.index, "index", 0);
  const status = str(b.status, "status", { max: 20, pattern: /^(running|success|failure|skipped|cancelled)$/ });
  const now = Date.now();
  await env.DB.prepare(
    `INSERT INTO steps (owner_id, job_id, attempt, idx, name, status, exit_code, started_at, finished_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (job_id, attempt, idx) DO UPDATE SET status = excluded.status, exit_code = excluded.exit_code, finished_at = excluded.finished_at`,
  )
    .bind(job.owner_id, job.id, job.attempt, idx, typeof b.name === "string" ? b.name.slice(0, 200) : null, status, typeof b.exit_code === "number" ? b.exit_code : null, now, status === "running" ? null : now)
    .run();
  return json({ ok: true });
}

export async function handleComplete(req: Request, env: Env, id: string): Promise<Response> {
  const runner = await authRunner(req, env);
  const job = await authJob(req, env, runner, id, true);
  const b = await readJson(req);
  const conclusion = str(b.conclusion, "conclusion", { pattern: /^(success|failure|cancelled)$/ });
  const reason = typeof b.reason === "string" ? (await maskerFor(env, job)).mask(b.reason).slice(0, 1000) : null;
  const lastSeq = typeof b.last_seq === "number" ? b.last_seq : 0;
  if (job.status === "claimed") {
    const now = Date.now();
    const status = conclusion === "success" ? "succeeded" : conclusion === "cancelled" ? "cancelled" : "failed";
    await env.DB.batch([
      env.DB.prepare("UPDATE jobs SET status = ?, reason = ?, finished_at = ?, updated_at = ? WHERE id = ? AND status = 'claimed'").bind(status, reason ?? (job.cancel_requested ? "取り消しました" : null), now, now, id),
      operationStatement(env, { owner_id: job.owner_id, repo_id: job.repo_id, run_id: job.run_id, job_id: id, kind: "job", stage: "completed", status: status === "failed" ? "failed" : "ok", reason }, now),
    ]);
    await coordinatorCall(env, job.repo_id, "/advance", { job_id: id });
  }
  // 欠けているログの通番を返す（Runner は保持している分を再送する）
  const m = await missingSeqs(env, job, lastSeq);
  return json({ ok: true, status: job.status === "claimed" ? "recorded" : job.status, missing: m.missing });
}

/** ログを通番の順につなぐ。欠けている所は印を入れる */
export async function assembleLogs(env: Env, job: JobRow, attempt = job.attempt): Promise<string> {
  const rows = await env.DB.prepare("SELECT seq, r2_key FROM log_chunks WHERE job_id = ? AND attempt = ? ORDER BY seq").bind(job.id, attempt).all<{ seq: number; r2_key: string }>();
  let out = "";
  let expect = 1;
  for (const r of rows.results) {
    if (r.seq > expect) out += `\n[ログの欠落：通番 ${expect}〜${r.seq - 1}]\n`;
    out += (await (await env.BLOBS.get(r.r2_key))?.text()) ?? `\n[ログの欠落：通番 ${r.seq}]\n`;
    expect = r.seq + 1;
  }
  // 断片の境目で分かれた秘密情報も、つないだ後にもう一度伏せる
  return (await maskerFor(env, { ...job, attempt })).mask(out);
}
