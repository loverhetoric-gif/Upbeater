/**
 * 管理 API（暫定）。開発順序2で MCP（OAuth）に置き換える。
 * - POST /v1/admin/apps                                  アプリの登録
 * - POST /v1/admin/registration-codes                    一回限りの登録コードの発行
 * - PUT  /v1/admin/apps/:app_id/versions/:seq/artifacts/:os  成果物の登録（Builder の完了報告の代わり）
 */
import { randomCode, sha256Hex, timingSafeEqual } from "../crypto";
import { APP_KINDS, SUPPORTED_OS, type AppRow, type Env, type ReleaseRow } from "../env";
import { bearer, HttpError, int, json, readJson, str } from "../http";
import { storeArtifact } from "../artifact-store";
import { operationStatement } from "../operations";

const ID = /^[A-Za-z0-9_-]{1,64}$/;
const REPO = /^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/;
const BRANCH = /^(?!\/)(?!.*\.\.)(?!.*\/\/)[A-Za-z0-9._\/-]{1,200}(?<!\/)$/;

export async function requireAdmin(req: Request, env: Env): Promise<void> {
  const token = bearer(req);
  if (!env.ADMIN_TOKEN || !token) throw new HttpError(401, "unauthorized");
  // ハッシュ同士を比べ、長さの違いも漏らさない
  if (!timingSafeEqual(await sha256Hex(token), await sha256Hex(env.ADMIN_TOKEN))) throw new HttpError(401, "unauthorized");
}

export async function handleCreateApp(req: Request, env: Env): Promise<Response> {
  const b = await readJson(req);
  const owner = str(b.owner_id, "owner_id", { pattern: ID });
  const name = str(b.name, "name", { max: 100 });
  const repo = str(b.repo, "repo", { pattern: REPO }).toLowerCase();
  const branch = str(b.branch ?? "main", "branch", { pattern: BRANCH });
  const kind = str(b.kind, "kind", { max: 16 });
  if (!(APP_KINDS as readonly string[]).includes(kind)) throw new HttpError(400, "invalid_kind");
  const os = b.target_os;
  if (!Array.isArray(os) || os.length === 0 || os.some((x) => !(SUPPORTED_OS as readonly string[]).includes(x as string))) {
    throw new HttpError(400, "invalid_target_os");
  }
  const steps = b.install_steps ?? {};
  if (typeof steps !== "object" || Array.isArray(steps)) throw new HttpError(400, "invalid_install_steps");

  const id = b.id === undefined ? crypto.randomUUID() : str(b.id, "id", { pattern: ID });
  const now = Date.now();
  try {
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO apps (id, owner_id, name, repo_full_name, branch, kind, target_os, install_steps, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).bind(id, owner, name, repo, branch, kind, JSON.stringify([...new Set(os)]), JSON.stringify(steps), now, now),
      env.DB.prepare("INSERT OR IGNORE INTO repo_allowlist (owner_id, repo_full_name, created_at) VALUES (?, ?, ?)").bind(owner, repo, now),
      operationStatement(env, { owner_id: owner, app_id: id, kind: "app", stage: "register", status: "ok" }, now),
    ]);
  } catch (e) {
    if (e instanceof Error && /UNIQUE/i.test(e.message)) throw new HttpError(409, "app_exists");
    throw e;
  }
  return json({ id }, 201);
}

export async function handleCreateRegistrationCode(req: Request, env: Env): Promise<Response> {
  const b = await readJson(req);
  const owner = str(b.owner_id, "owner_id", { pattern: ID });
  const ttl = Math.min(int(b.ttl_seconds ?? 900, "ttl_seconds", 60), 24 * 3600);
  const code = randomCode(10);
  const now = Date.now();
  const expiresAt = now + ttl * 1000;
  await env.DB.prepare("INSERT INTO registration_codes (code_hash, owner_id, expires_at, created_at) VALUES (?, ?, ?, ?)")
    .bind(await sha256Hex("reg." + code), owner, expiresAt, now)
    .run();
  return json({ code, expires_at: expiresAt }, 201);
}

export async function handlePutArtifact(req: Request, env: Env, appId: string, seqText: string, os: string): Promise<Response> {
  const seq = Number(seqText);
  if (!Number.isSafeInteger(seq) || seq < 1) throw new HttpError(400, "invalid_seq");
  const app = await env.DB.prepare("SELECT * FROM apps WHERE id = ?").bind(appId).first<AppRow>();
  if (!app) throw new HttpError(404, "app_not_found");
  const release = await env.DB.prepare("SELECT * FROM releases WHERE app_id = ? AND seq = ? AND os = ?")
    .bind(appId, seq, os)
    .first<ReleaseRow>();
  if (!release) throw new HttpError(404, "release_not_found");
  if (release.status === "ready") return json({ id: release.id, status: "ready", sha256: release.sha256, size: release.size });

  const stored = await storeArtifact(env, req, release, { expectedSha256: req.headers.get("x-upbeater-sha256") });
  return json({ id: release.id, status: "ready", sha256: stored.sha256, size: stored.size }, 201);
}
