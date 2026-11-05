/**
 * 端末への配布（組み込み機能 distribute）
 * - Runner が distribute の手順で送ったファイルを「版」として記録し、ジョブが成功したら配布できる状態（ready）にする。
 *   配るのは既定ブランチの push・手動実行・定期実行だけ（PR やフォークの成果物は端末に届けない）
 * - 通知サービス（FCM・APNs）は使わない。端末が起動時・復帰時・定期的に照合する（費用 0 円）
 * - 照合には Ed25519 で署名したマニフェストを返し、端末は署名と SHA-256 を確かめてから導入する
 * - 同じ版が 2 台以上で失敗したら、その版の配布を自動で止める
 */
import { b64url, fromB64url, hmacSha256, normalizeCode, randomCode, randomToken, sha256Hex, timingSafeEqual } from "./crypto";
import type { Env, JobRow, JobSpec, RepoRow, RunRow } from "./env";
import { bearer, HttpError, int, json, readJson, str } from "./http";
import { parseRevoked, parseSigningKeys, publicKeys, signManifest } from "./manifest";
import { operationStatement, recordOperation } from "./operations";

export const DEVICE_TOKEN_PREFIX = "upb_d_";
export const PLATFORMS = ["android", "ios", "macos", "linux"] as const;
export const DISTRIBUTE_PREFIX = "distribute-";
/** 同じ版がこの台数で失敗したら配布を止める */
export const HALT_AFTER_FAILURES = 2;
const URL_TTL_MS = 10 * 60_000;

export interface ReleaseRow {
  id: string;
  owner_id: string;
  repo_id: string;
  run_id: string | null;
  job_id: string | null;
  platform: string;
  seq: number;
  commit_sha: string;
  r2_key: string | null;
  sha256: string | null;
  size: number | null;
  filename: string | null;
  install: string | null;
  status: "pending" | "ready" | "halted" | "discarded";
  created_at: number;
}

interface DeviceRow {
  id: string;
  owner_id: string;
  name: string;
  os: string;
  created_at: number;
}

interface DistSettings {
  paused: number;
  pinned_seq: number | null;
  staged: number;
  canary_device_id: string | null;
}

// ───────── 版の記録（Runner から） ─────────

/** distribute の手順のファイルを受け取った時：その実行の版の候補（pending）として記録する */
export async function recordPendingRelease(env: Env, job: JobRow, name: string, key: string, sha: string, size: number, filename: string): Promise<void> {
  const platform = name.slice(DISTRIBUTE_PREFIX.length);
  if (!(PLATFORMS as readonly string[]).includes(platform)) return;
  const run = await env.DB.prepare("SELECT sha FROM runs WHERE id = ?").bind(job.run_id).first<{ sha: string }>();
  const spec = JSON.parse(job.spec) as JobSpec;
  const step = (spec.steps as { kind?: string; platform?: string; install?: Record<string, string> }[]).find((s) => s.kind === "distribute" && s.platform === platform);
  const now = Date.now();
  await env.DB.batch([
    env.DB.prepare("DELETE FROM releases WHERE job_id = ? AND platform = ? AND status = 'pending'").bind(job.id, platform),
    env.DB.prepare(
      `INSERT INTO releases (id, owner_id, repo_id, run_id, job_id, platform, seq, commit_sha, r2_key, sha256, size, filename, install, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)`,
    ).bind(crypto.randomUUID(), job.owner_id, job.repo_id, job.run_id, job.id, platform, run?.sha ?? "", key, sha, size, filename || null, JSON.stringify(step?.install ?? {}), now, now),
  ]);
}

/** ジョブが終わった時：成功なら版の候補を配布できる状態にし、通番を振る。失敗なら捨てる */
export async function settleReleases(env: Env, jobId: string, succeeded: boolean, now = Date.now()): Promise<void> {
  const pending = await env.DB.prepare("SELECT * FROM releases WHERE job_id = ? AND status = 'pending'").bind(jobId).all<ReleaseRow>();
  if (pending.results.length === 0) return;
  const job = await env.DB.prepare("SELECT run_id FROM jobs WHERE id = ?").bind(jobId).first<{ run_id: string }>();
  const run = job ? await env.DB.prepare("SELECT * FROM runs WHERE id = ?").bind(job.run_id).first<RunRow>() : null;
  const repo = run ? await env.DB.prepare("SELECT * FROM repos WHERE id = ?").bind(run.repo_id).first<RepoRow>() : null;
  // 端末に届けるのは既定ブランチの版だけ（PR・フォーク・ほかのブランチの成果物は届けない）
  const eligible = !!run && !!repo && !run.is_fork && ["push", "manual", "schedule"].includes(run.event) && run.branch === repo.default_branch;
  for (const r of pending.results) {
    if (!succeeded || !eligible) {
      await env.DB.batch([
        env.DB.prepare("UPDATE releases SET status = 'discarded', updated_at = ? WHERE id = ?").bind(now, r.id),
        operationStatement(env, {
          owner_id: r.owner_id,
          repo_id: r.repo_id,
          run_id: r.run_id,
          job_id: jobId,
          kind: "release",
          stage: "discarded",
          status: "ok",
          reason: !succeeded ? "ジョブが成功しなかったため配布しません" : "既定ブランチの push・手動・定期実行ではないため配布しません",
          detail: { platform: r.platform },
        }, now),
      ]);
      continue;
    }
    // 通番はリポジトリ × OS ごとに単調に増やす（UPDATE の中で決めるので、同時に来ても重ならない）
    await env.DB.prepare(
      `UPDATE releases SET status = 'ready', updated_at = ?,
         seq = (SELECT COALESCE(MAX(seq), 0) + 1 FROM releases WHERE repo_id = ? AND platform = ? AND status != 'pending' AND status != 'discarded')
       WHERE id = ? AND status = 'pending'`,
    )
      .bind(now, r.repo_id, r.platform, r.id)
      .run();
    const done = await env.DB.prepare("SELECT seq FROM releases WHERE id = ?").bind(r.id).first<{ seq: number }>();
    await recordOperation(env, { owner_id: r.owner_id, repo_id: r.repo_id, run_id: r.run_id, job_id: jobId, kind: "release", stage: "ready", status: "ok", detail: { platform: r.platform, seq: done?.seq, sha256: r.sha256 } });
  }
}

// ───────── 端末の登録 ─────────

export async function createDeviceCode(env: Env, owner: string, now = Date.now()): Promise<{ code: string; expires_at: number }> {
  const code = randomCode(10);
  const expiresAt = now + 15 * 60_000;
  await env.DB.prepare("INSERT INTO device_registration_codes (code_hash, owner_id, expires_at, created_at) VALUES (?, ?, ?, ?)").bind(await sha256Hex("device." + code), owner, expiresAt, now).run();
  return { code, expires_at: expiresAt };
}

async function authDevice(req: Request, env: Env): Promise<DeviceRow> {
  const t = bearer(req);
  if (!t || !t.startsWith(DEVICE_TOKEN_PREFIX)) throw new HttpError(401, "unauthorized");
  const d = await env.DB.prepare("SELECT id, owner_id, name, os, created_at FROM devices WHERE token_hash = ?").bind(await sha256Hex(t)).first<DeviceRow>();
  if (!d) throw new HttpError(401, "unauthorized");
  await env.DB.prepare("UPDATE devices SET last_seen_at = ? WHERE id = ?").bind(Date.now(), d.id).run();
  return d;
}

/** POST /v1/devices/register：一回限りのコードで端末トークンを発行する（Hub はハッシュだけを保存） */
async function handleRegister(req: Request, env: Env): Promise<Response> {
  const b = await readJson(req);
  const code = normalizeCode(str(b.code, "code", { max: 64 }));
  const name = str(b.name, "name", { max: 100 });
  const os = str(b.os, "os", { max: 16 });
  if (!(PLATFORMS as readonly string[]).includes(os)) throw new HttpError(400, "unsupported_os", "os は android・ios・macos・linux のどれかです");
  const now = Date.now();
  const id = crypto.randomUUID();
  const token = randomToken(DEVICE_TOKEN_PREFIX);
  const codeHash = await sha256Hex("device." + code);
  const r = await env.DB.batch([
    env.DB.prepare("UPDATE device_registration_codes SET used_at = ?, device_id = ? WHERE code_hash = ? AND used_at IS NULL AND expires_at > ?").bind(now, id, codeHash, now),
    env.DB.prepare(
      `INSERT INTO devices (id, owner_id, name, os, token_hash, created_at, last_seen_at) SELECT ?, owner_id, ?, ?, ?, ?, ? FROM device_registration_codes WHERE code_hash = ? AND device_id = ?`,
    ).bind(id, name, os, await sha256Hex(token), now, now, codeHash, id),
  ]);
  if ((r[1]?.meta.changes ?? 0) !== 1) throw new HttpError(400, "invalid_code", "登録コードが無効か、期限切れか、使用済みです");
  const owner = (await env.DB.prepare("SELECT owner_id FROM devices WHERE id = ?").bind(id).first<{ owner_id: string }>())!.owner_id;
  await recordOperation(env, { owner_id: owner, kind: "device", stage: "register", status: "ok", detail: { device_id: id, name, os } });
  return json({ device_id: id, token }, 201);
}

/** GET /v1/devices/apps：この端末の OS に配る版のあるリポジトリ（app_id はリポジトリの ID） */
async function handleApps(req: Request, env: Env): Promise<Response> {
  const d = await authDevice(req, env);
  const r = await env.DB.prepare(
    `SELECT r.id AS app_id, r.full_name AS name, MAX(x.seq) AS ready_seq FROM releases x JOIN repos r ON r.id = x.repo_id
     WHERE x.owner_id = ? AND x.platform = ? AND x.status = 'ready' GROUP BY r.id ORDER BY r.full_name`,
  )
    .bind(d.owner_id, d.os)
    .all();
  return json({ device_id: d.id, os: d.os, apps: r.results });
}

async function settingsOf(env: Env, repoId: string, platform: string): Promise<DistSettings> {
  return (
    (await env.DB.prepare("SELECT paused, pinned_seq, staged, canary_device_id FROM dist_settings WHERE repo_id = ? AND platform = ?").bind(repoId, platform).first<DistSettings>()) ?? {
      paused: 0,
      pinned_seq: null,
      staged: 0,
      canary_device_id: null,
    }
  );
}

/** 段階配信：この版をまだ誰も入れ終えていなければ、先行する 1 台にだけ配る */
async function allowedByStage(env: Env, s: DistSettings, d: DeviceRow, rel: ReleaseRow): Promise<boolean> {
  if (!s.staged) return true;
  const ok = await env.DB.prepare("SELECT 1 FROM installs WHERE repo_id = ? AND platform = ? AND seq = ? AND status = 'installed' LIMIT 1").bind(rel.repo_id, rel.platform, rel.seq).first();
  if (ok) return true;
  const canary =
    s.canary_device_id ??
    (await env.DB.prepare("SELECT id FROM devices WHERE owner_id = ? AND os = ? ORDER BY created_at, id LIMIT 1").bind(d.owner_id, d.os).first<{ id: string }>())?.id;
  return canary === d.id;
}

/** POST /v1/devices/check：現在の版を受け取り、入れるべき版の署名つきマニフェストを返す（途中の版は飛ばす） */
async function handleCheck(req: Request, env: Env, origin: string): Promise<Response> {
  const d = await authDevice(req, env);
  const b = await readJson(req);
  const repoId = str(b.app_id, "app_id", { max: 64 });
  const current = int(b.current_seq ?? 0, "current_seq");
  const repo = await env.DB.prepare("SELECT id FROM repos WHERE id = ? AND owner_id = ?").bind(repoId, d.owner_id).first();
  if (!repo) throw new HttpError(404, "app_not_found");
  const s = await settingsOf(env, repoId, d.os);
  const latest = await env.DB.prepare("SELECT MAX(seq) AS seq FROM releases WHERE repo_id = ? AND platform = ? AND status = 'ready'").bind(repoId, d.os).first<{ seq: number | null }>();
  if (s.paused) return json({ update: false, latest_seq: latest?.seq ?? 0, paused: true });

  let rel: ReleaseRow | null;
  let rollback: { to_seq: number; reason: string } | undefined;
  if (s.pinned_seq !== null) {
    rel = await env.DB.prepare("SELECT * FROM releases WHERE repo_id = ? AND platform = ? AND seq = ? AND status = 'ready'").bind(repoId, d.os, s.pinned_seq).first<ReleaseRow>();
    if (rel && rel.seq < current) rollback = { to_seq: rel.seq, reason: "pinned" };
  } else {
    rel = await env.DB.prepare("SELECT * FROM releases WHERE repo_id = ? AND platform = ? AND status = 'ready' ORDER BY seq DESC LIMIT 1").bind(repoId, d.os).first<ReleaseRow>();
  }
  if (!rel || (rel.seq <= current && !rollback)) return json({ update: false, latest_seq: latest?.seq ?? 0 });
  if (!(await allowedByStage(env, s, d, rel))) return json({ update: false, latest_seq: latest?.seq ?? 0, staged: true });
  if (!env.MANIFEST_SIGNING_KEYS || !env.SECRETS_KEY) throw new HttpError(503, "signing_not_configured");

  const now = Date.now();
  const expiresAt = now + URL_TTL_MS;
  const token = await downloadToken(env, { r: rel.id, d: d.id, e: expiresAt });
  const keys = parseSigningKeys(env.MANIFEST_SIGNING_KEYS);
  const revoked = parseRevoked(env.MANIFEST_REVOKED_GENERATIONS);
  const manifest = await signManifest(
    {
      app_id: repoId,
      os: d.os,
      seq: rel.seq,
      commit_sha: rel.commit_sha,
      release_id: rel.id,
      sha256: rel.sha256!,
      size: rel.size!,
      url: `${origin}/v1/artifacts/${rel.id}?t=${encodeURIComponent(token)}`,
      issued_at: now,
      expires_at: expiresAt,
      ...(rollback ? { rollback } : {}),
      install: JSON.parse(rel.install ?? "{}") as Record<string, unknown>,
    },
    keys,
    revoked,
  );
  return json({ update: true, latest_seq: latest?.seq ?? rel.seq, manifest, public_keys: publicKeys(keys, revoked) });
}

const INSTALL_STATUSES = ["downloading", "verifying", "installing", "installed", "failed", "rolled_back", "deferred"];

/** POST /v1/devices/report：導入の結果を記録する。同じ版が複数台で失敗したら配布を止める */
async function handleReport(req: Request, env: Env): Promise<Response> {
  const d = await authDevice(req, env);
  const b = await readJson(req);
  const repoId = str(b.app_id, "app_id", { max: 64 });
  const seq = int(b.seq, "seq");
  const status = str(b.status, "status", { max: 32 });
  if (!INSTALL_STATUSES.includes(status)) throw new HttpError(400, "invalid_status");
  const message = str(b.message, "message", { max: 2000, optional: true }) || null;
  const repo = await env.DB.prepare("SELECT id FROM repos WHERE id = ? AND owner_id = ?").bind(repoId, d.owner_id).first();
  if (!repo) throw new HttpError(404, "app_not_found");
  const now = Date.now();
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO installs (owner_id, device_id, repo_id, platform, seq, status, message, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (device_id, repo_id, platform) DO UPDATE SET seq = excluded.seq, status = excluded.status, message = excluded.message, updated_at = excluded.updated_at`,
    ).bind(d.owner_id, d.id, repoId, d.os, seq, status, message, now),
    operationStatement(env, { owner_id: d.owner_id, repo_id: repoId, kind: "install", stage: str(b.stage, "stage", { max: 64, optional: true }) || status, status: status === "failed" || status === "rolled_back" ? "failed" : "ok", reason: message, detail: { device: d.name, seq, status } }, now),
  ]);
  if (status === "failed" || status === "rolled_back") {
    // 失敗の連鎖を止める：同じ版が HALT_AFTER_FAILURES 台以上で失敗したら、その版の配布を止める
    const devices = await env.DB.prepare("SELECT COUNT(*) AS n FROM installs WHERE repo_id = ? AND platform = ? AND seq = ? AND status IN ('failed', 'rolled_back')").bind(repoId, d.os, seq).first<{ n: number }>();
    if ((devices?.n ?? 0) >= HALT_AFTER_FAILURES) {
      const r = await env.DB.prepare("UPDATE releases SET status = 'halted', updated_at = ? WHERE repo_id = ? AND platform = ? AND seq = ? AND status = 'ready'").bind(now, repoId, d.os, seq).run();
      if ((r.meta.changes ?? 0) > 0) {
        await recordOperation(env, { owner_id: d.owner_id, repo_id: repoId, kind: "release", stage: "halted", status: "failed", reason: `版 ${seq}（${d.os}）が ${devices?.n} 台で失敗したため、配布を止めました`, needs_human: true, detail: { platform: d.os, seq } });
      }
    }
  }
  return json({ ok: true });
}

// ───────── 取得（短期限の URL・Range 対応） ─────────

interface DownloadClaims {
  r: string;
  d: string;
  e: number;
}

/** 取得用の鍵は SECRETS_KEY から導く（新しい Secret を増やさない） */
const dlSecret = (env: Env) => "download." + env.SECRETS_KEY;

async function downloadToken(env: Env, c: DownloadClaims): Promise<string> {
  const body = b64url(JSON.stringify(c));
  return `${body}.${b64url(await hmacSha256(dlSecret(env), "dl." + body))}`;
}

async function verifyDownloadToken(env: Env, token: string, now = Date.now()): Promise<DownloadClaims | null> {
  const [body, sig, ...rest] = token.split(".");
  if (!body || !sig || rest.length || !env.SECRETS_KEY) return null;
  if (!timingSafeEqual(b64url(await hmacSha256(dlSecret(env), "dl." + body)), sig)) return null;
  try {
    const c = JSON.parse(new TextDecoder().decode(fromB64url(body))) as DownloadClaims;
    return typeof c.r === "string" && typeof c.e === "number" && c.e > now ? c : null;
  } catch {
    return null;
  }
}

export function parseRange(header: string | null, size: number): { offset: number; length: number } | "unsatisfiable" | null {
  if (!header) return null;
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!m) return null;
  const [, a, b] = m;
  if (a === "" && b === "") return null;
  if (a === "") {
    const suffix = Number(b);
    if (suffix === 0) return "unsatisfiable";
    const len = Math.min(suffix, size);
    return { offset: size - len, length: len };
  }
  const start = Number(a);
  if (start >= size) return "unsatisfiable";
  const end = b === "" ? size - 1 : Math.min(Number(b), size - 1);
  if (end < start) return null;
  return { offset: start, length: end - start + 1 };
}

/** GET/HEAD /v1/artifacts/:release_id?t=… */
async function handleArtifact(req: Request, env: Env, id: string): Promise<Response> {
  const claims = await verifyDownloadToken(env, new URL(req.url).searchParams.get("t") ?? "");
  if (!claims || claims.r !== id) return json({ error: "invalid_or_expired_token" }, 403);
  const rel = await env.DB.prepare("SELECT * FROM releases WHERE id = ?").bind(id).first<ReleaseRow>();
  if (!rel || !rel.r2_key) return json({ error: "not_found" }, 404);
  if (rel.status !== "ready") return json({ error: "release_unavailable", status: rel.status }, 410);
  const head = await env.BLOBS.head(rel.r2_key);
  if (!head) return json({ error: "not_found" }, 404);
  const size = head.size;
  const etag = `"${rel.sha256}"`;
  // If-Range が今の中身と合わなければ全体を返す（途中で中身が変わった時に継ぎはぎしない）
  const ifRange = req.headers.get("if-range");
  const range = ifRange && ifRange !== etag ? null : parseRange(req.headers.get("range"), size);
  const headers = new Headers({ "content-type": "application/octet-stream", "accept-ranges": "bytes", etag, "cache-control": "private, no-store", "x-upbeater-sha256": rel.sha256 ?? "" });
  if (rel.filename) headers.set("content-disposition", `attachment; filename="${rel.filename.replace(/[^A-Za-z0-9._-]/g, "_")}"`);
  if (range === "unsatisfiable") {
    headers.set("content-range", `bytes */${size}`);
    return new Response(null, { status: 416, headers });
  }
  if (range) headers.set("content-range", `bytes ${range.offset}-${range.offset + range.length - 1}/${size}`);
  headers.set("content-length", String(range ? range.length : size));
  if (req.method === "HEAD") return new Response(null, { status: range ? 206 : 200, headers });
  const obj = await env.BLOBS.get(rel.r2_key, range ? { range } : undefined);
  if (!obj) return json({ error: "not_found" }, 404);
  return new Response(obj.body, { status: range ? 206 : 200, headers });
}

export async function handleDevices(req: Request, env: Env, p: string, origin: string): Promise<Response | null> {
  const m = req.method;
  if (p === "/v1/devices/register" && m === "POST") return handleRegister(req, env);
  if (p === "/v1/devices/apps" && m === "GET") return handleApps(req, env);
  if (p === "/v1/devices/check" && m === "POST") return handleCheck(req, env, origin);
  if (p === "/v1/devices/report" && m === "POST") return handleReport(req, env);
  const a = /^\/v1\/artifacts\/([0-9a-f-]{36})$/.exec(p);
  if (a && (m === "GET" || m === "HEAD")) return handleArtifact(req, env, a[1]!);
  return null;
}
