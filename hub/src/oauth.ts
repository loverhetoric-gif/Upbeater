/**
 * OAuth 2.1（claude.ai のコネクタ向け）
 * - 動的クライアント登録（RFC 7591）、認可コード＋PKCE（S256 のみ）、リフレッシュトークンの回転
 * - 利用者の確認は GitHub でのログイン（GitHub App のユーザー認証）。ALLOWED_GITHUB_USERS に載ったアカウントだけを通す
 * - コード・トークンはハッシュのみ保存。コードの再使用を検知したら、そのコードから出たトークンをすべて失効させる
 */
import { b64url, randomToken, sha256Hex, timingSafeEqual } from "./crypto";
import type { Env } from "./env";
import { githubFetch } from "./github";
import { HttpError, json } from "./http";
import { consentPage, errorPage, htmlResponse } from "./pages";

export const ACCESS_TTL_MS = 60 * 60_000;
export const REFRESH_TTL_MS = 30 * 24 * 3600_000;
const CODE_TTL_MS = 2 * 60_000;
const REQUEST_TTL_MS = 10 * 60_000;
const COOKIE = "__Host-upb_oauth";
export const SCOPE = "upbeater";
/** 事前の許可を使える戻り先（claude.ai のコネクタ） */
const PREAPPROVE_HOSTS = ["claude.ai", "claude.com"];

export function resourceUrl(origin: string): string {
  return `${origin}/mcp`;
}

export function protectedResourceMetadata(origin: string): Response {
  return json(
    { resource: resourceUrl(origin), authorization_servers: [origin], bearer_methods_supported: ["header"], scopes_supported: [SCOPE] },
    200,
    cors(),
  );
}

export function authorizationServerMetadata(origin: string): Response {
  return json(
    {
      issuer: origin,
      authorization_endpoint: `${origin}/oauth/authorize`,
      token_endpoint: `${origin}/oauth/token`,
      registration_endpoint: `${origin}/oauth/register`,
      revocation_endpoint: `${origin}/oauth/revoke`,
      response_types_supported: ["code"],
      grant_types_supported: ["authorization_code", "refresh_token"],
      code_challenge_methods_supported: ["S256"],
      token_endpoint_auth_methods_supported: ["none"],
      scopes_supported: [SCOPE],
    },
    200,
    cors(),
  );
}

export function cors(): Record<string, string> {
  return {
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "GET, POST, OPTIONS",
    "access-control-allow-headers": "authorization, content-type, mcp-protocol-version, mcp-session-id",
    "access-control-expose-headers": "www-authenticate, mcp-session-id",
  };
}

function oauthError(error: string, description: string, status = 400): Response {
  return json({ error, error_description: description }, status, cors());
}

function validRedirect(uri: string): boolean {
  try {
    const u = new URL(uri);
    if (u.hash) return false;
    if (u.protocol === "https:") return true;
    // ローカルの道具（MCP Inspector など）のみ http を許す
    return u.protocol === "http:" && (u.hostname === "localhost" || u.hostname === "127.0.0.1" || u.hostname === "[::1]");
  } catch {
    return false;
  }
}

/** POST /oauth/register */
export async function handleRegisterClient(req: Request, env: Env): Promise<Response> {
  let body: { redirect_uris?: unknown; client_name?: unknown; token_endpoint_auth_method?: unknown };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return oauthError("invalid_client_metadata", "JSON ではありません");
  }
  const uris = body.redirect_uris;
  if (!Array.isArray(uris) || uris.length === 0 || uris.length > 5 || !uris.every((u) => typeof u === "string" && u.length <= 500 && validRedirect(u))) {
    return oauthError("invalid_redirect_uri", "redirect_uris は https の URL を 1〜5 件指定してください");
  }
  if (body.token_endpoint_auth_method !== undefined && body.token_endpoint_auth_method !== "none") {
    return oauthError("invalid_client_metadata", "token_endpoint_auth_method は none のみ対応しています");
  }
  const name = typeof body.client_name === "string" && body.client_name.trim() ? body.client_name.trim().slice(0, 100) : "名前のないアプリ";
  const clientId = randomToken("upb_c_", 18);
  const now = Date.now();
  await env.DB.prepare("INSERT INTO oauth_clients (client_id, client_name, redirect_uris, created_at) VALUES (?, ?, ?, ?)")
    .bind(clientId, name, JSON.stringify(uris), now)
    .run();
  return json(
    {
      client_id: clientId,
      client_id_issued_at: Math.floor(now / 1000),
      client_name: name,
      redirect_uris: uris,
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    },
    201,
    cors(),
  );
}

interface ClientRow {
  client_id: string;
  client_name: string;
  redirect_uris: string;
}

async function getClient(env: Env, id: string): Promise<ClientRow | null> {
  return env.DB.prepare("SELECT client_id, client_name, redirect_uris FROM oauth_clients WHERE client_id = ?").bind(id).first<ClientRow>();
}

function readCookie(req: Request, name: string): string | null {
  const h = req.headers.get("cookie") ?? "";
  for (const part of h.split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === name) return v.join("=");
  }
  return null;
}

function redirectWith(uri: string, params: Record<string, string | undefined>, extraHeaders: HeadersInit = {}): Response {
  const u = new URL(uri);
  for (const [k, v] of Object.entries(params)) if (v !== undefined) u.searchParams.set(k, v);
  return new Response(null, { status: 302, headers: { location: u.toString(), "cache-control": "no-store", ...extraHeaders } });
}

/** GET /oauth/authorize */
export async function handleAuthorize(req: Request, env: Env, origin: string): Promise<Response> {
  const q = new URL(req.url).searchParams;
  const clientId = q.get("client_id") ?? "";
  const redirectUri = q.get("redirect_uri") ?? "";
  const client = clientId ? await getClient(env, clientId) : null;
  // クライアントと戻り先が確かめられない間は、戻り先へは返さず画面で知らせる
  if (!client) return htmlResponse(errorPage("登録されていないアプリです。"), 400);
  const registered = JSON.parse(client.redirect_uris) as string[];
  if (!registered.includes(redirectUri)) return htmlResponse(errorPage("戻り先が登録と一致しません。"), 400);

  const state = q.get("state") ?? undefined;
  const back = (error: string, description: string) => redirectWith(redirectUri, { error, error_description: description, state, iss: origin });
  if (q.get("response_type") !== "code") return back("unsupported_response_type", "response_type は code のみです");
  const challenge = q.get("code_challenge") ?? "";
  if (q.get("code_challenge_method") !== "S256" || !/^[A-Za-z0-9_-]{43}$/.test(challenge)) {
    return back("invalid_request", "PKCE（S256）が必要です");
  }
  const resource = q.get("resource");
  if (resource && resource.replace(/\/$/, "") !== resourceUrl(origin) && resource.replace(/\/$/, "") !== origin) {
    return back("invalid_target", "resource が Upbeater ではありません");
  }
  // 事前の許可：管理者が出した「次の 1 回」を、claude.ai からの接続に限って使う（GitHub でのログインを省く）
  if (PREAPPROVE_HOSTS.includes(new URL(redirectUri).hostname)) {
    const now = Date.now();
    const pre = await env.DB.prepare(
      "UPDATE oauth_preapprovals SET used_at = ?, client_id = ? WHERE id = (SELECT id FROM oauth_preapprovals WHERE used_at IS NULL AND expires_at > ? ORDER BY created_at DESC LIMIT 1) AND used_at IS NULL RETURNING owner_id",
    )
      .bind(now, clientId, now)
      .first<{ owner_id: string }>();
    if (pre) {
      const code = randomToken("upb_ac_", 32);
      await env.DB.prepare(
        `INSERT INTO oauth_codes (code_hash, owner_id, grant_id, client_id, redirect_uri, code_challenge, scope, resource, expires_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
        .bind(await sha256Hex(code), pre.owner_id, crypto.randomUUID(), clientId, redirectUri, challenge, q.get("scope") ?? SCOPE, resource ?? resourceUrl(origin), now + CODE_TTL_MS, now)
        .run();
      return redirectWith(redirectUri, { code, state, iss: origin });
    }
  }
  if (!env.GITHUB_APP_CLIENT_ID || !env.GITHUB_APP_CLIENT_SECRET) {
    return htmlResponse(errorPage("接続の許可がまだ出ていません。Upbeater の管理者が許可を出してから、もう一度つないでください。"), 403);
  }

  const id = randomToken("", 24);
  const now = Date.now();
  await env.DB.prepare(
    `INSERT INTO oauth_requests (id, client_id, redirect_uri, state, code_challenge, scope, resource, expires_at, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(id, clientId, redirectUri, state ?? null, challenge, q.get("scope") ?? SCOPE, resource ?? resourceUrl(origin), now + REQUEST_TTL_MS, now)
    .run();

  // GitHub でログインしてもらう。state は推測できない値で、同じブラウザの Cookie と照合する（ログインのすり替え対策）
  const gh = new URL(`${(env.GITHUB_WEB_BASE || "https://github.com").replace(/\/$/, "")}/login/oauth/authorize`);
  gh.searchParams.set("client_id", env.GITHUB_APP_CLIENT_ID);
  gh.searchParams.set("redirect_uri", `${origin}/oauth/github/callback`);
  gh.searchParams.set("state", id);
  gh.searchParams.set("allow_signup", "false");
  return new Response(null, {
    status: 302,
    headers: {
      location: gh.toString(),
      "cache-control": "no-store",
      "set-cookie": `${COOKIE}=${id}; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=${REQUEST_TTL_MS / 1000}`,
    },
  });
}

interface PendingRow {
  id: string;
  owner_id: string;
  client_id: string;
  redirect_uri: string;
  state: string | null;
  code_challenge: string;
  scope: string | null;
  resource: string | null;
  csrf_hash: string | null;
  expires_at: number;
}

function isAllowedUser(env: Env, user: { id: number; login: string }): boolean {
  const list = (env.ALLOWED_GITHUB_USERS ?? "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  return list.includes(String(user.id)) || list.includes(user.login.toLowerCase());
}

/** GET /oauth/github/callback */
export async function handleGitHubCallback(req: Request, env: Env, origin: string): Promise<Response> {
  const q = new URL(req.url).searchParams;
  const id = q.get("state") ?? "";
  const cookie = readCookie(req, COOKIE);
  if (!id || !cookie || !timingSafeEqual(id, cookie)) return htmlResponse(errorPage("ログインの確認に失敗しました（別のブラウザで開いた可能性）。"), 400);
  const pending = await env.DB.prepare("SELECT * FROM oauth_requests WHERE id = ?").bind(id).first<PendingRow>();
  if (!pending || pending.expires_at <= Date.now()) return htmlResponse(errorPage("時間切れです。"), 400);
  const code = q.get("code");
  if (!code) return htmlResponse(errorPage("GitHub でのログインが取り消されました。"), 400);

  const f = githubFetch(env);
  let user: { id: number; login: string };
  try {
    const tokenRes = await f(`${(env.GITHUB_WEB_BASE || "https://github.com").replace(/\/$/, "")}/login/oauth/access_token`, {
      method: "POST",
      headers: { accept: "application/json", "content-type": "application/json", "user-agent": "upbeater-hub" },
      body: JSON.stringify({
        client_id: env.GITHUB_APP_CLIENT_ID,
        client_secret: env.GITHUB_APP_CLIENT_SECRET,
        code,
        redirect_uri: `${origin}/oauth/github/callback`,
      }),
    });
    const t = (await tokenRes.json()) as { access_token?: string };
    if (!tokenRes.ok || !t.access_token) throw new Error("token");
    const userRes = await f(`${(env.GITHUB_API_BASE || "https://api.github.com").replace(/\/$/, "")}/user`, {
      headers: { authorization: `Bearer ${t.access_token}`, accept: "application/vnd.github+json", "user-agent": "upbeater-hub" },
    });
    const u = (await userRes.json()) as { id?: unknown; login?: unknown };
    if (!userRes.ok || typeof u.id !== "number" || typeof u.login !== "string") throw new Error("user");
    user = { id: u.id, login: u.login };
    // GitHub のユーザートークンは本人確認にだけ使い、保存しない
  } catch {
    return htmlResponse(errorPage("GitHub でのログインを確認できませんでした。時間をおいてやり直してください。"), 502);
  }
  if (!isAllowedUser(env, user)) return htmlResponse(errorPage(`GitHub アカウント「${user.login}」は Upbeater の利用を許可されていません。`), 403);

  const ownerId = `gh:${user.id}`;
  const now = Date.now();
  const csrf = randomToken("", 24);
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO owners (id, owner_id, github_user_id, github_login, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT (id) DO UPDATE SET github_login = excluded.github_login, updated_at = excluded.updated_at`,
    ).bind(ownerId, ownerId, user.id, user.login, now, now),
    env.DB.prepare("UPDATE oauth_requests SET owner_id = ?, csrf_hash = ? WHERE id = ?").bind(ownerId, await sha256Hex(csrf), id),
  ]);
  const client = await getClient(env, pending.client_id);
  return htmlResponse(
    consentPage({
      clientName: client?.client_name ?? "不明なアプリ",
      redirectHost: new URL(pending.redirect_uri).host,
      login: user.login,
      requestId: id,
      csrf,
    }),
    200,
    {},
    new URL(pending.redirect_uri).origin,
  );
}

/** POST /oauth/consent */
export async function handleConsent(req: Request, env: Env, origin: string): Promise<Response> {
  const form = await req.formData();
  const id = String(form.get("request_id") ?? "");
  const csrf = String(form.get("csrf") ?? "");
  const cookie = readCookie(req, COOKIE);
  if (!id || !cookie || !timingSafeEqual(id, cookie)) return htmlResponse(errorPage("確認に失敗しました。"), 400);
  const pending = await env.DB.prepare("SELECT * FROM oauth_requests WHERE id = ?").bind(id).first<PendingRow>();
  if (!pending || pending.expires_at <= Date.now() || !pending.owner_id || !pending.csrf_hash) return htmlResponse(errorPage("時間切れです。"), 400);
  if (!timingSafeEqual(await sha256Hex(csrf), pending.csrf_hash)) return htmlResponse(errorPage("確認に失敗しました。"), 400);

  // 途中経過は一度だけ使う
  const del = await env.DB.prepare("DELETE FROM oauth_requests WHERE id = ?").bind(id).run();
  if ((del.meta.changes ?? 0) !== 1) return htmlResponse(errorPage("この確認は使用済みです。"), 400);
  const clearCookie = { "set-cookie": `${COOKIE}=; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=0` };
  const state = pending.state ?? undefined;
  if (form.get("decision") !== "approve") {
    return redirectWith(pending.redirect_uri, { error: "access_denied", error_description: "利用者が許可しませんでした", state, iss: origin }, clearCookie);
  }
  const code = randomToken("upb_ac_", 32);
  const now = Date.now();
  await env.DB.prepare(
    `INSERT INTO oauth_codes (code_hash, owner_id, grant_id, client_id, redirect_uri, code_challenge, scope, resource, expires_at, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      await sha256Hex(code),
      pending.owner_id,
      crypto.randomUUID(),
      pending.client_id,
      pending.redirect_uri,
      pending.code_challenge,
      pending.scope,
      pending.resource,
      now + CODE_TTL_MS,
      now,
    )
    .run();
  return redirectWith(pending.redirect_uri, { code, state, iss: origin }, clearCookie);
}

async function issueTokens(env: Env, p: { owner_id: string; grant_id: string; client_id: string; scope: string | null }) {
  const access = randomToken("upb_at_", 32);
  const refresh = randomToken("upb_rt_", 32);
  const now = Date.now();
  const ins = "INSERT INTO oauth_tokens (token_hash, owner_id, grant_id, client_id, kind, scope, expires_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)";
  await env.DB.batch([
    env.DB.prepare(ins).bind(await sha256Hex(access), p.owner_id, p.grant_id, p.client_id, "access", p.scope, now + ACCESS_TTL_MS, now),
    env.DB.prepare(ins).bind(await sha256Hex(refresh), p.owner_id, p.grant_id, p.client_id, "refresh", p.scope, now + REFRESH_TTL_MS, now),
  ]);
  return json(
    { access_token: access, token_type: "Bearer", expires_in: ACCESS_TTL_MS / 1000, refresh_token: refresh, scope: p.scope ?? SCOPE },
    200,
    { ...cors(), pragma: "no-cache" },
  );
}

/** POST /oauth/token */
export async function handleToken(req: Request, env: Env): Promise<Response> {
  let form: URLSearchParams;
  const type = req.headers.get("content-type") ?? "";
  if (type.includes("application/json")) {
    const b = (await req.json().catch(() => ({}))) as Record<string, unknown>;
    form = new URLSearchParams(Object.entries(b).map(([k, v]) => [k, String(v)]));
  } else {
    form = new URLSearchParams(new TextDecoder().decode(await req.arrayBuffer()));
  }
  const grant = form.get("grant_type");
  const clientId = form.get("client_id") ?? "";
  const now = Date.now();

  if (grant === "authorization_code") {
    const code = form.get("code") ?? "";
    const verifier = form.get("code_verifier") ?? "";
    const codeHash = await sha256Hex(code);
    // 一回限り：使用済みへの更新に成功した 1 件だけが進める
    const row = await env.DB.prepare(
      "UPDATE oauth_codes SET used_at = ? WHERE code_hash = ? AND used_at IS NULL AND expires_at > ? RETURNING *",
    )
      .bind(now, codeHash, now)
      .first<{ owner_id: string; grant_id: string; client_id: string; redirect_uri: string; code_challenge: string; scope: string | null }>();
    if (!row) {
      // 再使用：そのコードから出たトークンをすべて失効させる
      const used = await env.DB.prepare("SELECT grant_id FROM oauth_codes WHERE code_hash = ?").bind(codeHash).first<{ grant_id: string }>();
      if (used) await env.DB.prepare("UPDATE oauth_tokens SET revoked_at = ? WHERE grant_id = ? AND revoked_at IS NULL").bind(now, used.grant_id).run();
      return oauthError("invalid_grant", "認可コードが無効か、期限切れか、使用済みです");
    }
    if (row.client_id !== clientId) return oauthError("invalid_grant", "client_id が一致しません");
    if ((form.get("redirect_uri") ?? row.redirect_uri) !== row.redirect_uri) return oauthError("invalid_grant", "redirect_uri が一致しません");
    if (!/^[A-Za-z0-9._~-]{43,128}$/.test(verifier)) return oauthError("invalid_grant", "code_verifier の形式が正しくありません");
    const challenge = b64url(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)));
    if (!timingSafeEqual(challenge, row.code_challenge)) return oauthError("invalid_grant", "PKCE の検証に失敗しました");
    return issueTokens(env, row);
  }

  if (grant === "refresh_token") {
    const token = form.get("refresh_token") ?? "";
    // 回転：古いリフレッシュトークンは使った時点で失効させる
    const row = await env.DB.prepare(
      "UPDATE oauth_tokens SET revoked_at = ? WHERE token_hash = ? AND kind = 'refresh' AND revoked_at IS NULL AND expires_at > ? RETURNING owner_id, grant_id, client_id, scope",
    )
      .bind(now, await sha256Hex(token), now)
      .first<{ owner_id: string; grant_id: string; client_id: string; scope: string | null }>();
    if (!row) {
      // 失効済みのリフレッシュトークンの再使用は漏えいの兆候：同じ認可のトークンをすべて失効させる
      const old = await env.DB.prepare("SELECT grant_id FROM oauth_tokens WHERE token_hash = ? AND kind = 'refresh'")
        .bind(await sha256Hex(token))
        .first<{ grant_id: string }>();
      if (old) await env.DB.prepare("UPDATE oauth_tokens SET revoked_at = ? WHERE grant_id = ? AND revoked_at IS NULL").bind(now, old.grant_id).run();
      return oauthError("invalid_grant", "リフレッシュトークンが無効です");
    }
    if (row.client_id !== clientId) return oauthError("invalid_grant", "client_id が一致しません");
    return issueTokens(env, row);
  }
  return oauthError("unsupported_grant_type", "grant_type が対応していません");
}

/** POST /oauth/revoke（RFC 7009。結果に関わらず 200 を返す） */
export async function handleRevoke(req: Request, env: Env): Promise<Response> {
  const form = new URLSearchParams(new TextDecoder().decode(await req.arrayBuffer()));
  const token = form.get("token");
  if (token) {
    await env.DB.prepare("UPDATE oauth_tokens SET revoked_at = ? WHERE token_hash = ? AND revoked_at IS NULL").bind(Date.now(), await sha256Hex(token)).run();
  }
  return new Response(null, { status: 200, headers: cors() });
}

/** MCP の Bearer トークンを確かめ、利用者を返す */
export async function authenticateMcp(req: Request, env: Env): Promise<string> {
  const h = req.headers.get("authorization") ?? "";
  // 直接登録した接続用トークン（Claude Code など）
  const direct = /^Bearer\s+(upb_m_[A-Za-z0-9_-]+)$/.exec(h);
  if (direct) {
    const hash = await sha256Hex(direct[1]!);
    const row = await env.DB.prepare("SELECT owner_id FROM mcp_tokens WHERE token_hash = ? AND revoked_at IS NULL").bind(hash).first<{ owner_id: string }>();
    if (!row) throw new HttpError(401, "invalid_token");
    await env.DB.prepare("UPDATE mcp_tokens SET last_used_at = ? WHERE token_hash = ?").bind(Date.now(), hash).run();
    return row.owner_id;
  }
  const m = /^Bearer\s+(upb_at_[A-Za-z0-9_-]+)$/.exec(h);
  if (!m) throw new HttpError(401, "unauthorized");
  const row = await env.DB.prepare(
    "SELECT owner_id FROM oauth_tokens WHERE token_hash = ? AND kind = 'access' AND revoked_at IS NULL AND expires_at > ?",
  )
    .bind(await sha256Hex(m[1]!), Date.now())
    .first<{ owner_id: string }>();
  if (!row) throw new HttpError(401, "invalid_token");
  return row.owner_id;
}
