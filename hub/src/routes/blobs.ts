/**
 * 成果物とキャッシュ（Runner 用 API。本体は R2）
 * - PUT/GET /v1/runners/jobs/:id/artifacts/:name  成果物。同じ実行（run）の中で受け渡す
 * - PUT/GET /v1/runners/jobs/:id/cache/:key        キャッシュ。同じリポジトリの中で使い回す。一度保存したら変えない
 * 送る時は x-upbeater-sha256 を付け、Hub（R2）が中身と照合してから保存する。取り出す時も同じ値を返し、Runner が照合する。
 * フォークからの PR はキャッシュを読めるが、書けない（他の実行への汚染を防ぐ）。
 */
import { sha256Hex } from "../crypto";
import type { Env, RunRow } from "../env";
import { HttpError, json } from "../http";
import { DISTRIBUTE_PREFIX, recordPendingRelease } from "../distribute";
import { authJob, authRunner } from "./runner";

/** 1 件の上限（Workers が受け取れる大きさに合わせる） */
export const MAX_BLOB_BYTES = 500 * 1024 * 1024;
const NAME = /^[A-Za-z0-9._-]{1,100}$/;

export async function handleBlob(req: Request, env: Env, id: string, kind: "artifacts" | "cache", rawName: string): Promise<Response> {
  const runner = await authRunner(req, env);
  let name: string;
  try {
    name = decodeURIComponent(rawName);
  } catch {
    throw new HttpError(400, "invalid_name");
  }
  if (kind === "artifacts" ? !NAME.test(name) : name.length < 1 || name.length > 512) {
    throw new HttpError(400, "invalid_name", kind === "artifacts" ? "成果物の名前は英数字と . _ - の 100 文字までです" : "キャッシュの key は 512 文字までです");
  }
  if (req.method === "GET") {
    const job = await authJob(req, env, runner, id);
    const key = kind === "artifacts" ? await artifactKey(env, job.owner_id, job.run_id, name) : await cacheKey(job.owner_id, job.repo_id, name);
    const obj = key ? await env.BLOBS.get(key) : null;
    if (!obj) throw new HttpError(404, "not_found");
    const m = obj.customMetadata ?? {};
    return new Response(obj.body, {
      headers: {
        "content-type": "application/octet-stream",
        "content-length": String(obj.size),
        "x-upbeater-sha256": m.sha256 ?? "",
        "x-upbeater-format": m.format ?? "tar.gz",
        "x-upbeater-filename": m.filename ?? "",
        "cache-control": "no-store",
      },
    });
  }
  if (req.method !== "PUT") throw new HttpError(405, "method_not_allowed");

  const job = await authJob(req, env, runner, id);
  const sha = (req.headers.get("x-upbeater-sha256") ?? "").toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(sha)) throw new HttpError(400, "invalid_sha256", "x-upbeater-sha256 に SHA-256（16 進 64 文字）を付けてください");
  const format = req.headers.get("x-upbeater-format") === "file" ? "file" : "tar.gz";
  const filename = (req.headers.get("x-upbeater-filename") ?? "").slice(0, 300);
  const len = Number(req.headers.get("content-length") ?? "NaN");
  if (!Number.isSafeInteger(len) || len < 0) throw new HttpError(411, "length_required");
  if (len > MAX_BLOB_BYTES) throw new HttpError(413, "payload_too_large", `1 件は ${MAX_BLOB_BYTES / 1024 / 1024} MB までです`);
  if (!req.body) throw new HttpError(400, "empty_body");

  let key: string;
  if (kind === "cache") {
    const run = await env.DB.prepare("SELECT is_fork FROM runs WHERE id = ?").bind(job.run_id).first<Pick<RunRow, "is_fork">>();
    if (run?.is_fork) throw new HttpError(403, "fork_cache_readonly", "フォークからの PR はキャッシュを保存できません");
    key = await cacheKey(job.owner_id, job.repo_id, name);
    if (await env.BLOBS.head(key)) throw new HttpError(409, "cache_exists", "このキャッシュは保存済みです");
  } else {
    const other = await env.DB.prepare(
      "SELECT a.job_id FROM artifacts a JOIN jobs j ON j.id = a.job_id WHERE j.run_id = ? AND a.owner_id = ? AND a.name = ? AND a.job_id != ? LIMIT 1",
    )
      .bind(job.run_id, job.owner_id, name, job.id)
      .first();
    if (other) throw new HttpError(409, "artifact_exists", `同じ実行に成果物「${name}」が既にあります`);
    key = `artifacts/${job.owner_id}/${job.run_id}/${name}`;
  }
  try {
    // R2 が中身の SHA-256 を照合し、合わなければ保存しない
    await env.BLOBS.put(key, req.body, { sha256: sha, customMetadata: { sha256: sha, format, filename, job_id: job.id } });
  } catch {
    throw new HttpError(400, "sha256_mismatch", "送られた中身が SHA-256 と一致しません");
  }
  if (kind === "artifacts") {
    const now = Date.now();
    await env.DB.batch([
      env.DB.prepare("DELETE FROM artifacts WHERE job_id = ? AND name = ?").bind(job.id, name),
      env.DB.prepare("INSERT INTO artifacts (id, owner_id, job_id, name, r2_key, size, sha256, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)").bind(crypto.randomUUID(), job.owner_id, job.id, name, key, len, sha, now),
    ]);
    // 端末への配布のファイル：版の候補として記録する（ジョブが成功したら配布できる状態にする）
    if (name.startsWith(DISTRIBUTE_PREFIX)) await recordPendingRelease(env, job, name, key, sha, len, filename);
  }
  return json({ ok: true, key: kind === "artifacts" ? name : undefined }, 201);
}

async function artifactKey(env: Env, owner: string, runId: string, name: string): Promise<string | null> {
  const row = await env.DB.prepare("SELECT a.r2_key FROM artifacts a JOIN jobs j ON j.id = a.job_id WHERE j.run_id = ? AND a.owner_id = ? AND a.name = ? ORDER BY a.created_at DESC LIMIT 1")
    .bind(runId, owner, name)
    .first<{ r2_key: string }>();
  return row?.r2_key ?? null;
}

async function cacheKey(owner: string, repo: string, key: string): Promise<string> {
  return `cache/${owner}/${repo}/${await sha256Hex(key)}`;
}
