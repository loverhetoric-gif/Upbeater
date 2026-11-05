/** 端末 API：登録・照合・結果報告 */
import { normalizeCode, randomToken, sha256Hex } from "../crypto";
import { SUPPORTED_OS, type AppRow, type DeviceOs, type DeviceRow, type Env, type ReleaseRow } from "../env";
import { bearer, HttpError, int, json, readJson, str } from "../http";
import { parseRevoked, parseSigningKeys, publicKeys, signManifest } from "../manifest";
import { operationStatement } from "../operations";
import { createDownloadToken } from "../tokens";

export const DEVICE_TOKEN_PREFIX = "upb_d_";

export async function authenticateDevice(req: Request, env: Env): Promise<DeviceRow> {
  const token = bearer(req);
  if (!token || !token.startsWith(DEVICE_TOKEN_PREFIX)) throw new HttpError(401, "unauthorized");
  const device = await env.DB.prepare("SELECT * FROM devices WHERE token_hash = ?").bind(await sha256Hex(token)).first<DeviceRow>();
  if (!device) throw new HttpError(401, "unauthorized");
  await env.DB.prepare("UPDATE devices SET last_seen_at = ? WHERE id = ?").bind(Date.now(), device.id).run();
  return device;
}

/** POST /v1/devices/register：一回限りの登録コードで端末トークンを発行する */
export async function handleRegister(req: Request, env: Env): Promise<Response> {
  const body = await readJson(req);
  const code = normalizeCode(str(body.code, "code", { max: 64 }));
  const name = str(body.name, "name", { max: 100 });
  const os = str(body.os, "os", { max: 16 }) as DeviceOs;
  if (!SUPPORTED_OS.includes(os)) throw new HttpError(400, "unsupported_os");
  const pushToken = str(body.push_token, "push_token", { max: 4096, optional: true }) || null;

  const now = Date.now();
  const codeHash = await sha256Hex("reg." + code);
  const deviceId = crypto.randomUUID();
  const token = randomToken(DEVICE_TOKEN_PREFIX);

  // 使用済みへの更新と端末の作成を一つのトランザクションで行う（同じコードの同時使用でも 1 台だけ。途中で失敗してもコードは消費されない）
  const tokenHash = await sha256Hex(token);
  const results = await env.DB.batch([
    env.DB.prepare(
      "UPDATE registration_codes SET used_at = ?, device_id = ? WHERE code_hash = ? AND used_at IS NULL AND expires_at > ?",
    ).bind(now, deviceId, codeHash, now),
    env.DB.prepare(
      `INSERT INTO devices (id, owner_id, name, os, push_token, token_hash, created_at, last_seen_at)
       SELECT ?, owner_id, ?, ?, ?, ?, ?, ? FROM registration_codes WHERE code_hash = ? AND device_id = ?`,
    ).bind(deviceId, name, os, pushToken, tokenHash, now, now, codeHash, deviceId),
    env.DB.prepare(
      `INSERT INTO operations (owner_id, device_id, kind, stage, status, retryable, needs_human, created_at)
       SELECT owner_id, ?, 'device', 'register', 'ok', 0, 0, ? FROM registration_codes WHERE code_hash = ? AND device_id = ?`,
    ).bind(deviceId, now, codeHash, deviceId),
  ]);
  if ((results[1]?.meta.changes ?? 0) !== 1) throw new HttpError(400, "invalid_code", "登録コードが無効か、期限切れか、使用済みです");
  const owner = await env.DB.prepare("SELECT owner_id FROM devices WHERE id = ?").bind(deviceId).first<{ owner_id: string }>();

  // トークンはこの応答でのみ渡す（Hub はハッシュだけを保存）
  return json({ device_id: deviceId, owner_id: owner?.owner_id, token }, 201);
}

/** POST /v1/devices/check：現在の版を受け取り、適用すべき最新版のマニフェストを返す（途中の版は飛ばす） */
export async function handleCheck(req: Request, env: Env, origin: string): Promise<Response> {
  const device = await authenticateDevice(req, env);
  const body = await readJson(req);
  const appId = str(body.app_id, "app_id", { max: 64 });
  const currentSeq = int(body.current_seq ?? 0, "current_seq");

  const app = await env.DB.prepare("SELECT * FROM apps WHERE id = ? AND owner_id = ?").bind(appId, device.owner_id).first<AppRow>();
  if (!app) throw new HttpError(404, "app_not_found");

  let release: ReleaseRow | null;
  let rollback: { to_seq: number; reason: string } | undefined;
  if (app.pinned_seq !== null) {
    // 明示的な巻き戻し（指定の版に固定）
    release = await env.DB.prepare("SELECT * FROM releases WHERE app_id = ? AND os = ? AND seq = ? AND status = 'ready'")
      .bind(app.id, device.os, app.pinned_seq)
      .first<ReleaseRow>();
    if (release && release.seq < currentSeq) rollback = { to_seq: release.seq, reason: "pinned" };
  } else {
    release = await env.DB.prepare(
      "SELECT * FROM releases WHERE app_id = ? AND os = ? AND status = 'ready' ORDER BY seq DESC LIMIT 1",
    )
      .bind(app.id, device.os)
      .first<ReleaseRow>();
  }

  if (!release || (release.seq <= currentSeq && !rollback)) {
    return json({ update: false, latest_seq: release?.seq ?? 0 });
  }
  if (!release.sha256 || release.size === null) throw new HttpError(500, "release_incomplete");

  if (!env.DOWNLOAD_TOKEN_SECRET || !env.MANIFEST_SIGNING_KEYS) throw new HttpError(503, "signing_not_configured");
  const now = Date.now();
  const ttl = Math.max(60, Number(env.ARTIFACT_URL_TTL_SECONDS ?? "600") || 600) * 1000;
  const expiresAt = now + ttl;
  const token = await createDownloadToken(env.DOWNLOAD_TOKEN_SECRET, { r: release.id, d: device.id, e: expiresAt });
  const keys = parseSigningKeys(env.MANIFEST_SIGNING_KEYS);
  const revoked = parseRevoked(env.MANIFEST_REVOKED_GENERATIONS);
  const manifest = await signManifest(
    {
      app_id: app.id,
      os: device.os,
      seq: release.seq,
      commit_sha: release.commit_sha,
      release_id: release.id,
      sha256: release.sha256,
      size: release.size,
      url: `${origin}/v1/artifacts/${release.id}?t=${encodeURIComponent(token)}`,
      issued_at: now,
      expires_at: expiresAt,
      ...(rollback ? { rollback } : {}),
      install: installConfig(app, device.os),
    },
    keys,
    revoked,
  );
  return json({ update: true, manifest, public_keys: publicKeys(keys, revoked) });
}

/** アプリの install_steps[os].install（導入先などの設定）。無ければ空 */
function installConfig(app: AppRow, os: string): Record<string, unknown> {
  try {
    const all = JSON.parse(app.install_steps) as Record<string, { install?: unknown }>;
    const v = all[os]?.install;
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/** GET /v1/devices/apps：この端末の OS を対象とするアプリの一覧 */
export async function handleDeviceApps(req: Request, env: Env): Promise<Response> {
  const device = await authenticateDevice(req, env);
  const r = await env.DB.prepare(
    `SELECT a.id AS app_id, a.name, a.kind, a.pinned_seq,
            (SELECT MAX(seq) FROM releases r WHERE r.app_id = a.id AND r.os = ? AND r.status = 'ready') AS ready_seq
     FROM apps a WHERE a.owner_id = ? AND a.target_os LIKE '%"' || ? || '"%' ORDER BY a.name`,
  )
    .bind(device.os, device.owner_id, device.os)
    .all();
  return json({ device_id: device.id, os: device.os, apps: r.results });
}

const INSTALL_STATUSES = ["downloading", "verifying", "installing", "installed", "failed", "rolled_back", "deferred"] as const;

/** POST /v1/devices/report：導入結果を installs と operations に記録する */
export async function handleReport(req: Request, env: Env): Promise<Response> {
  const device = await authenticateDevice(req, env);
  const body = await readJson(req);
  const appId = str(body.app_id, "app_id", { max: 64 });
  const seq = int(body.seq, "seq");
  const status = str(body.status, "status", { max: 32 });
  if (!(INSTALL_STATUSES as readonly string[]).includes(status)) throw new HttpError(400, "invalid_status");
  const message = str(body.message, "message", { max: 2000, optional: true }) || null;
  const stage = str(body.stage, "stage", { max: 64, optional: true }) || status;

  const app = await env.DB.prepare("SELECT id FROM apps WHERE id = ? AND owner_id = ?").bind(appId, device.owner_id).first();
  if (!app) throw new HttpError(404, "app_not_found");
  const version = await env.DB.prepare("SELECT commit_sha FROM app_versions WHERE app_id = ? AND seq = ?")
    .bind(appId, seq)
    .first<{ commit_sha: string }>();
  if (seq > 0 && !version) throw new HttpError(404, "version_not_found");

  const now = Date.now();
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO installs (owner_id, device_id, app_id, seq, commit_sha, status, message, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (device_id, app_id) DO UPDATE SET seq = excluded.seq, commit_sha = excluded.commit_sha,
         status = excluded.status, message = excluded.message, updated_at = excluded.updated_at`,
    ).bind(device.owner_id, device.id, appId, seq, version?.commit_sha ?? null, status, message, now),
    operationStatement(
      env,
      {
        owner_id: device.owner_id,
        app_id: appId,
        device_id: device.id,
        kind: "install",
        stage,
        status: status === "failed" ? "failed" : "ok",
        reason: message,
        detail: { seq, status },
      },
      now,
    ),
  ]);
  return json({ ok: true });
}
