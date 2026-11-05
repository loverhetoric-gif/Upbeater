import { env, SELF } from "cloudflare:test";
import { b64url } from "../src/crypto";
import { ORIGIN } from "./helpers";

const MOCK = "https://github-mock.test";
export const REDIRECT = "https://claude.ai/api/mcp/auth_callback";

export async function mockCall(path: string, body: unknown = {}) {
  const r = await env.GITHUB_API!.fetch(`${MOCK}/__mock/${path}`, { method: "POST", body: JSON.stringify(body) });
  return r.json() as Promise<any>;
}

export async function pkce() {
  const verifier = b64url(crypto.getRandomValues(new Uint8Array(32)));
  const challenge = b64url(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)));
  return { verifier, challenge };
}

export async function registerClient(redirect = REDIRECT) {
  const r = await SELF.fetch(`${ORIGIN}/oauth/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ client_name: "Claude", redirect_uris: [redirect], token_endpoint_auth_method: "none" }),
  });
  return ((await r.json()) as { client_id: string }).client_id;
}

/** 認可の画面の流れを最後まで進め、認可コードを得る */
export async function authorize(opts: { login?: string; id?: number; decision?: "approve" | "deny"; clientId?: string } = {}) {
  const clientId = opts.clientId ?? (await registerClient());
  const { verifier, challenge } = await pkce();
  const q = new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    redirect_uri: REDIRECT,
    code_challenge: challenge,
    code_challenge_method: "S256",
    state: "st-123",
    scope: "upbeater",
    resource: `${ORIGIN}/mcp`,
  });
  const a = await SELF.fetch(`${ORIGIN}/oauth/authorize?${q}`, { redirect: "manual" });
  if (a.status !== 302) throw new Error(`authorize：${a.status}`);
  const gh = new URL(a.headers.get("location")!);
  const cookie = a.headers.get("set-cookie")!.split(";")[0]!;
  const ghCode = "ghcode-" + crypto.randomUUID();
  await mockCall("oauth-user", { code: ghCode, id: opts.id ?? 1001, login: opts.login ?? "allowed-user" });
  const cb = await SELF.fetch(`${ORIGIN}/oauth/github/callback?code=${ghCode}&state=${gh.searchParams.get("state")}`, {
    headers: { cookie },
    redirect: "manual",
  });
  const html = await cb.text();
  if (cb.status !== 200) return { status: cb.status, html, clientId, verifier };
  const csrf = /name="csrf" value="([^"]+)"/.exec(html)![1]!;
  const rid = /name="request_id" value="([^"]+)"/.exec(html)![1]!;
  const form = new URLSearchParams({ request_id: rid, csrf, decision: opts.decision ?? "approve" });
  const c = await SELF.fetch(`${ORIGIN}/oauth/consent`, {
    method: "POST",
    headers: { cookie, "content-type": "application/x-www-form-urlencoded" },
    body: form,
    redirect: "manual",
  });
  const loc = new URL(c.headers.get("location")!);
  return { status: c.status, html, clientId, verifier, location: loc, code: loc.searchParams.get("code") };
}

export async function token(params: Record<string, string>) {
  const r = await SELF.fetch(`${ORIGIN}/oauth/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(params),
  });
  return { status: r.status, body: (await r.json()) as any };
}

export async function connect(opts: { login?: string; id?: number } = {}) {
  const a = await authorize(opts);
  const t = await token({ grant_type: "authorization_code", code: a.code!, client_id: a.clientId, redirect_uri: REDIRECT, code_verifier: a.verifier });
  return { access: t.body.access_token as string, refresh: t.body.refresh_token as string, clientId: a.clientId, owner: `gh:${opts.id ?? 1001}` };
}

let rpcId = 0;
export async function rpc(tokenValue: string | null, method: string, params?: unknown, headers: Record<string, string> = {}) {
  const r = await SELF.fetch(`${ORIGIN}/mcp`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...(tokenValue ? { authorization: `Bearer ${tokenValue}` } : {}), ...headers },
    body: JSON.stringify({ jsonrpc: "2.0", id: ++rpcId, method, ...(params !== undefined ? { params } : {}) }),
  });
  return { status: r.status, headers: r.headers, body: r.status === 202 ? null : ((await r.json()) as any) };
}

export async function tool(tokenValue: string, name: string, args: Record<string, unknown> = {}) {
  const r = await rpc(tokenValue, "tools/call", { name, arguments: args });
  if (r.body.error) throw new Error(`tools/call ${name}：${r.body.error.message}`);
  return r.body.result.structuredContent as any;
}
