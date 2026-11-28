/**
 * 管理アプリ（コンソール）の接続
 * - 利用者はアプリの接続画面で、Hub の URL と一回限りの接続コード（15 分）を入れるだけ。
 *   コードは Claude（MCP の create_console_code）か管理 API で発行する
 * - 引き換えで MCP の接続用トークン（upb_m_、名前は console-app）を発行する。
 *   発行の処理は管理 API の POST /v1/admin/mcp-tokens と同じ（同じ名前の前のトークンは取り消す）
 * - コードもトークンも、Hub はハッシュだけを保存する
 */
import { normalizeCode, randomCode, randomToken, sha256Hex } from "./crypto";
import type { Env } from "./env";
import { HttpError, json, readJson, str } from "./http";

export const CONSOLE_TOKEN_NAME = "console-app";

export async function createConsoleCode(env: Env, owner: string, now = Date.now()): Promise<{ code: string; expires_at: number }> {
  const code = randomCode(10);
  const expiresAt = now + 15 * 60_000;
  await env.DB.prepare("INSERT INTO console_registration_codes (code_hash, owner_id, expires_at, created_at) VALUES (?, ?, ?, ?)").bind(await sha256Hex("console." + code), owner, expiresAt, now).run();
  return { code, expires_at: expiresAt };
}

/** POST /v1/console/redeem：一回限りの接続コードで接続用トークンを発行する（認証なし。コード自体が資格） */
export async function handleConsoleRedeem(req: Request, env: Env): Promise<Response> {
  const b = await readJson(req);
  const code = normalizeCode(str(b.code, "code", { max: 64 }));
  const now = Date.now();
  const codeHash = await sha256Hex("console." + code);
  const row = await env.DB.prepare("SELECT owner_id FROM console_registration_codes WHERE code_hash = ? AND used_at IS NULL AND expires_at > ?").bind(codeHash, now).first<{ owner_id: string }>();
  if (!row) throw new HttpError(400, "invalid_code", "接続コードが無効か、期限切れか、使用済みです");
  const token = randomToken("upb_m_");
  const r = await env.DB.batch([
    env.DB.prepare("UPDATE console_registration_codes SET used_at = ? WHERE code_hash = ? AND used_at IS NULL AND expires_at > ?").bind(now, codeHash, now),
    env.DB.prepare("UPDATE mcp_tokens SET revoked_at = ? WHERE owner_id = ? AND name = ? AND revoked_at IS NULL").bind(now, row.owner_id, CONSOLE_TOKEN_NAME),
    env.DB.prepare("INSERT INTO mcp_tokens (token_hash, owner_id, name, created_at) VALUES (?, ?, ?, ?)").bind(await sha256Hex(token), row.owner_id, CONSOLE_TOKEN_NAME, now),
  ]);
  if ((r[0]?.meta.changes ?? 0) !== 1) throw new HttpError(400, "invalid_code", "接続コードが無効か、期限切れか、使用済みです");
  return json({ token, name: CONSOLE_TOKEN_NAME }, 201);
}
