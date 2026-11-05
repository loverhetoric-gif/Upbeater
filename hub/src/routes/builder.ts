/**
 * Builder API（Mac などのビルド機が Hub に取りに来る方式）
 * - POST /v1/builder/claim                  次のビルド指示を受け取る（アプリごとに最新の版だけ）
 * - POST /v1/builder/jobs/:id/heartbeat     生存の連絡。取り消されていれば中断を指示する
 * - PUT  /v1/builder/jobs/:id/artifact      成果物の提出（SHA-256 を照合して ready にする）
 * - POST /v1/builder/jobs/:id/fail          失敗の報告（段階・理由・末尾ログ・再試行の可否）
 *
 * Builder が停止・スリープしても指示は待ち行列に残る。連絡の途絶えた指示は期限後に待ち行列へ戻す。
 */
import { storeArtifact } from "../artifact-store";
import { b64url, redactSecrets, sha256Hex } from "../crypto";
import { SUPPORTED_OS, type AppRow, type Env, type ReleaseRow } from "../env";
import { createGitHubTokenProvider, GitHubError, parseRepo } from "../github";
import { bearer, HttpError, json, readJson, str } from "../http";
import { operationStatement, recordOperation } from "../operations";

export const BUILDER_TOKEN_PREFIX = "upb_b_";
/** 生存の連絡がこの時間途絶えたら、指示を待ち行列に戻す */
export const LEASE_MS = 10 * 60_000;
/** 同じ指示を試す上限（中断・一時的な失敗を含む） */
export const MAX_ATTEMPTS = 3;
const MAX_LOG = 16 * 1024;

interface BuilderRow {
  id: string;
  owner_id: string;
  name: string;
}

export interface BuildJobRow {
  id: string;
  owner_id: string;
  app_id: string;
  release_id: string;
  seq: number;
  commit_sha: string;
  os: string;
  status: "queued" | "claimed" | "succeeded" | "failed" | "cancelled";
  builder_id: string | null;
  attempt: number;
  lease_until: number | null;
  stage: string | null;
  reason: string | null;
  log_tail: string | null;
}

/** OS ごとのビルド手順（アプリの install_steps に置く。アプリ固有の処理は本体に書かない） */
export interface BuildSteps {
  requires: string[];
  build: string[];
  artifact: string;
  timeout_minutes: number;
}

export function buildSteps(app: AppRow, os: string): BuildSteps {
  let all: Record<string, Partial<BuildSteps>> = {};
  try {
    all = JSON.parse(app.install_steps) as typeof all;
  } catch {
    all = {};
  }
  const s = all[os] ?? {};
  const strings = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);
  return {
    requires: strings(s.requires),
    build: strings(s.build),
    // direct（ビルド不要）の既定は、リポジトリの内容そのもの
    artifact: typeof s.artifact === "string" && s.artifact ? s.artifact : ".",
    timeout_minutes: typeof s.timeout_minutes === "number" && s.timeout_minutes > 0 ? Math.min(s.timeout_minutes, 180) : 60,
  };
}

async function authenticateBuilder(req: Request, env: Env): Promise<BuilderRow> {
  const token = bearer(req);
  if (!token || !token.startsWith(BUILDER_TOKEN_PREFIX)) throw new HttpError(401, "unauthorized");
  const b = await env.DB.prepare("SELECT id, owner_id, name FROM builders WHERE token_hash = ? AND revoked_at IS NULL")
    .bind(await sha256Hex(token))
    .first<BuilderRow>();
  if (!b) throw new HttpError(401, "unauthorized");
  return b;
}

async function ownJob(env: Env, builder: BuilderRow, id: string): Promise<BuildJobRow> {
  const job = await env.DB.prepare("SELECT * FROM build_jobs WHERE id = ? AND owner_id = ?").bind(id, builder.owner_id).first<BuildJobRow>();
  if (!job || job.builder_id !== builder.id) throw new HttpError(404, "job_not_found");
  return job;
}

/** 連絡の途絶えた指示を待ち行列に戻す（上限に達したものは失敗とする） */
export async function reclaimExpired(env: Env, ownerId: string, now = Date.now()): Promise<void> {
  await env.DB.batch([
    env.DB.prepare(
      `UPDATE build_jobs SET status = 'failed', stage = COALESCE(stage, 'lease'), reason = 'Builder からの連絡が途絶えたまま、上限の回数に達しました', builder_id = NULL, lease_until = NULL, updated_at = ?
       WHERE owner_id = ? AND status = 'claimed' AND lease_until < ? AND attempt >= ?`,
    ).bind(now, ownerId, now, MAX_ATTEMPTS),
    env.DB.prepare(
      "UPDATE build_jobs SET status = 'queued', builder_id = NULL, lease_until = NULL, updated_at = ? WHERE owner_id = ? AND status = 'claimed' AND lease_until < ?",
    ).bind(now, ownerId, now),
    env.DB.prepare(
      "UPDATE releases SET status = 'failed', updated_at = ? WHERE status = 'pending' AND id IN (SELECT release_id FROM build_jobs WHERE owner_id = ? AND status = 'failed')",
    ).bind(now, ownerId),
  ]);
}

export async function handleClaim(req: Request, env: Env): Promise<Response> {
  const builder = await authenticateBuilder(req, env);
  const body = await readJson(req);
  const os = Array.isArray(body.os) ? [...new Set(body.os.filter((x): x is string => typeof x === "string" && (SUPPORTED_OS as readonly string[]).includes(x)))] : [];
  if (os.length === 0) throw new HttpError(400, "invalid_os", "ビルドできる OS を指定してください");
  const now = Date.now();
  await env.DB.prepare("UPDATE builders SET last_seen_at = ?, os = ? WHERE id = ?").bind(now, JSON.stringify(os), builder.id).run();
  await reclaimExpired(env, builder.owner_id, now);

  // 古いものから順番に 1 件だけ受け取る（同時に複数の Builder が来ても 1 件は 1 台にだけ渡る）
  const job = await env.DB.prepare(
    `UPDATE build_jobs SET status = 'claimed', builder_id = ?, lease_until = ?, attempt = attempt + 1, stage = NULL, updated_at = ?
     WHERE id = (SELECT id FROM build_jobs WHERE owner_id = ? AND status = 'queued' AND os IN (SELECT value FROM json_each(?)) ORDER BY created_at, id LIMIT 1)
       AND status = 'queued'
     RETURNING *`,
  )
    .bind(builder.id, now + LEASE_MS, now, builder.owner_id, JSON.stringify(os))
    .first<BuildJobRow>();
  if (!job) return new Response(null, { status: 204 });

  const app = await env.DB.prepare("SELECT * FROM apps WHERE id = ?").bind(job.app_id).first<AppRow>();
  if (!app) throw new HttpError(500, "app_missing");
  const repo = parseRepo(app.repo_full_name);

  // 取得用の短期トークン（GitHub App のインストールトークン）。Builder はビルド手順には渡さず、取得にだけ使う
  let authHeader: string | null = null;
  try {
    const token = await createGitHubTokenProvider(env).getToken(repo);
    if (token) authHeader = `Authorization: Basic ${btoa(`x-access-token:${token}`)}`;
  } catch (e) {
    if (e instanceof GitHubError && !e.retryable) {
      await failJob(env, job, { stage: "fetch", reason: e.message, retryable: false, needsHuman: true, log: null });
      return json({ error: "job_failed", reason: e.message }, 409);
    }
    // 一時的な失敗：指示を待ち行列に戻す（回数は数えない）
    await env.DB.prepare("UPDATE build_jobs SET status = 'queued', builder_id = NULL, lease_until = NULL, attempt = attempt - 1 WHERE id = ?").bind(job.id).run();
    return json({ error: "github_unavailable" }, 503, { "retry-after": "30" });
  }

  await recordOperation(env, {
    owner_id: job.owner_id,
    app_id: job.app_id,
    kind: "build",
    stage: "claimed",
    status: "ok",
    detail: { job_id: job.id, seq: job.seq, os: job.os, attempt: job.attempt, builder: builder.name },
  });
  const web = (env.GITHUB_WEB_BASE || "https://github.com").replace(/\/$/, "");
  return json({
    job: { id: job.id, app_id: app.id, app_name: app.name, kind: app.kind, seq: job.seq, commit_sha: job.commit_sha, os: job.os, attempt: job.attempt, lease_ms: LEASE_MS },
    source: { clone_url: `${web}/${repo.owner}/${repo.name}.git`, auth_header: authHeader },
    steps: buildSteps(app, job.os),
  });
}

export async function handleHeartbeat(req: Request, env: Env, id: string): Promise<Response> {
  const builder = await authenticateBuilder(req, env);
  const job = await ownJob(env, builder, id);
  const now = Date.now();
  if (job.status !== "claimed") return json({ continue: false, status: job.status, reason: job.reason });
  const body = await readJson(req).catch(() => ({}) as Record<string, unknown>);
  const stage = typeof body.stage === "string" ? body.stage.slice(0, 32) : job.stage;
  await env.DB.batch([
    env.DB.prepare("UPDATE build_jobs SET lease_until = ?, stage = ?, updated_at = ? WHERE id = ? AND status = 'claimed'").bind(now + LEASE_MS, stage, now, id),
    env.DB.prepare("UPDATE builders SET last_seen_at = ? WHERE id = ?").bind(now, builder.id),
  ]);
  return json({ continue: true, lease_until: now + LEASE_MS });
}

export async function handleArtifactUpload(req: Request, env: Env, id: string): Promise<Response> {
  const builder = await authenticateBuilder(req, env);
  const job = await ownJob(env, builder, id);
  if (job.status !== "claimed") throw new HttpError(409, "job_not_active", `この指示は ${job.status} です`);
  const sha = req.headers.get("x-upbeater-sha256");
  if (!sha) throw new HttpError(400, "sha256_required", "x-upbeater-sha256 が必要です");
  const release = await env.DB.prepare("SELECT * FROM releases WHERE id = ?").bind(job.release_id).first<ReleaseRow>();
  if (!release) throw new HttpError(404, "release_not_found");
  const stored = await storeArtifact(env, req, release, {
    expectedSha256: sha,
    extraStatements: () => [
      env.DB.prepare("UPDATE build_jobs SET status = 'succeeded', stage = 'done', lease_until = NULL, reason = NULL, log_tail = NULL, updated_at = ? WHERE id = ? AND status = 'claimed'").bind(
        Date.now(),
        id,
      ),
    ],
  });
  return json({ ok: true, release_id: release.id, sha256: stored.sha256, size: stored.size }, 201);
}

async function failJob(
  env: Env,
  job: BuildJobRow,
  f: { stage: string; reason: string; retryable: boolean; needsHuman: boolean; log: string | null },
): Promise<"requeued" | "failed"> {
  const now = Date.now();
  const log = f.log ? redactSecrets(f.log).slice(-MAX_LOG) : null;
  const requeue = f.retryable && job.attempt < MAX_ATTEMPTS;
  await env.DB.batch([
    env.DB.prepare(
      `UPDATE build_jobs SET status = ?, stage = ?, reason = ?, log_tail = ?, builder_id = ?, lease_until = NULL, updated_at = ? WHERE id = ? AND status = 'claimed'`,
    ).bind(requeue ? "queued" : "failed", f.stage, f.reason, log, requeue ? null : job.builder_id, now, job.id),
    // 配信はしない：成果物のない版は端末に届かないため、端末は現行版のまま
    ...(requeue ? [] : [env.DB.prepare("UPDATE releases SET status = 'failed', updated_at = ? WHERE id = ? AND status = 'pending'").bind(now, job.release_id)]),
    operationStatement(
      env,
      {
        owner_id: job.owner_id,
        app_id: job.app_id,
        kind: "build",
        stage: f.stage,
        status: requeue ? "retry" : "failed",
        reason: f.reason,
        retryable: f.retryable,
        needs_human: !requeue && f.needsHuman,
        detail: { job_id: job.id, seq: job.seq, os: job.os, attempt: job.attempt },
      },
      now,
    ),
  ]);
  return requeue ? "requeued" : "failed";
}

const STAGES = ["preflight", "fetch", "build", "artifact", "upload", "interrupted"] as const;

export async function handleFail(req: Request, env: Env, id: string): Promise<Response> {
  const builder = await authenticateBuilder(req, env);
  const job = await ownJob(env, builder, id);
  if (job.status !== "claimed") return json({ ok: true, status: job.status });
  const b = await readJson(req, 128 * 1024);
  const stage = str(b.stage, "stage", { max: 32 });
  if (!(STAGES as readonly string[]).includes(stage)) throw new HttpError(400, "invalid_stage");
  const reason = redactSecrets(str(b.reason, "reason", { max: 2000 }));
  const log = typeof b.log_tail === "string" ? b.log_tail : null;
  const retryable = b.retryable === true;
  // 道具の不足・ビルドの失敗は人の判断が要る。中断・一時的な失敗は自動で再試行する
  const outcome = await failJob(env, job, { stage, reason, retryable, needsHuman: !retryable, log });
  return json({ ok: true, status: outcome });
}

/** MCP の道具から使う：Builder の登録（トークンはこの時だけ返す） */
export async function createBuilder(env: Env, ownerId: string, name: string): Promise<{ builder_id: string; token: string }> {
  const id = crypto.randomUUID();
  const token = BUILDER_TOKEN_PREFIX + b64url(crypto.getRandomValues(new Uint8Array(32)));
  await env.DB.prepare("INSERT INTO builders (id, owner_id, name, token_hash, created_at) VALUES (?, ?, ?, ?, ?)")
    .bind(id, ownerId, name, await sha256Hex(token), Date.now())
    .run();
  return { builder_id: id, token };
}
