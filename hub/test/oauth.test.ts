import { env, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { ORIGIN } from "./helpers";
import { authorize, connect, pkce, REDIRECT, registerClient, rpc, token } from "./mcp-helpers";

describe("OAuth（claude.ai のコネクタ）", () => {
  it("認証なしの MCP は 401 で、メタデータの場所を知らせる", async () => {
    const r = await rpc(null, "initialize", {});
    expect(r.status).toBe(401);
    expect(r.headers.get("www-authenticate")).toContain(`resource_metadata="${ORIGIN}/.well-known/oauth-protected-resource/mcp"`);
    const prm = (await (await SELF.fetch(`${ORIGIN}/.well-known/oauth-protected-resource/mcp`)).json()) as any;
    expect(prm).toMatchObject({ resource: `${ORIGIN}/mcp`, authorization_servers: [ORIGIN] });
    const asm = (await (await SELF.fetch(`${ORIGIN}/.well-known/oauth-authorization-server`)).json()) as any;
    expect(asm).toMatchObject({ issuer: ORIGIN, code_challenge_methods_supported: ["S256"], registration_endpoint: `${ORIGIN}/oauth/register` });
  });

  it("登録 → GitHub でログイン → 同意 → トークン → MCP の順につながる", async () => {
    const a = await authorize();
    expect(a.html).toContain("許可しますか");
    expect(a.html).toContain("Claude");
    expect(a.html).toContain("allowed-user");
    expect(a.location!.origin + a.location!.pathname).toBe(REDIRECT);
    expect(a.location!.searchParams.get("state")).toBe("st-123");
    expect(a.location!.searchParams.get("iss")).toBe(ORIGIN);
    const t = await token({ grant_type: "authorization_code", code: a.code!, client_id: a.clientId, redirect_uri: REDIRECT, code_verifier: a.verifier });
    expect(t.status).toBe(200);
    expect(t.body).toMatchObject({ token_type: "Bearer", expires_in: 3600 });
    const init = await rpc(t.body.access_token, "initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "1" } });
    expect(init.body.result.serverInfo.name).toBe("upbeater");
    // トークンはハッシュだけを保存する
    const dump = JSON.stringify((await env.DB.prepare("SELECT * FROM oauth_tokens").all()).results);
    expect(dump).not.toContain(t.body.access_token);
    expect(dump).not.toContain(t.body.refresh_token);
  });

  it("PKCE の検証に失敗したコードは使えない", async () => {
    const a = await authorize();
    const other = await pkce();
    const t = await token({ grant_type: "authorization_code", code: a.code!, client_id: a.clientId, redirect_uri: REDIRECT, code_verifier: other.verifier });
    expect(t.body.error).toBe("invalid_grant");
  });

  it("認可コードの再使用を検知し、そのコードから出たトークンを失効させる", async () => {
    const a = await authorize();
    const p = { grant_type: "authorization_code", code: a.code!, client_id: a.clientId, redirect_uri: REDIRECT, code_verifier: a.verifier };
    const first = await token(p);
    expect((await rpc(first.body.access_token, "ping")).status).toBe(200);
    const second = await token(p);
    expect(second.body.error).toBe("invalid_grant");
    expect((await rpc(first.body.access_token, "ping")).status).toBe(401);
  });

  it("リフレッシュトークンは回転し、古いものの再使用で同じ認可を失効させる", async () => {
    const c = await connect();
    const r1 = await token({ grant_type: "refresh_token", refresh_token: c.refresh, client_id: c.clientId });
    expect(r1.status).toBe(200);
    expect((await rpc(r1.body.access_token, "ping")).status).toBe(200);
    const reuse = await token({ grant_type: "refresh_token", refresh_token: c.refresh, client_id: c.clientId });
    expect(reuse.body.error).toBe("invalid_grant");
    expect((await rpc(r1.body.access_token, "ping")).status).toBe(401);
  });

  it("許可されていない GitHub アカウントは拒否する", async () => {
    const a = await authorize({ login: "stranger", id: 9 });
    expect(a.status).toBe(403);
    expect(a.html).toContain("stranger");
    // 数値 ID での許可も効く
    const b = await authorize({ login: "renamed", id: 424242 });
    expect(b.status).toBe(302);
  });

  it("同意しなければ access_denied を返す", async () => {
    const a = await authorize({ decision: "deny" });
    expect(a.location!.searchParams.get("error")).toBe("access_denied");
    expect(a.code).toBeNull();
  });

  it("登録と違う戻り先・PKCE なし・別のブラウザからのログイン完了は拒否する", async () => {
    const clientId = await registerClient();
    const { challenge } = await pkce();
    const base = { response_type: "code", client_id: clientId, code_challenge: challenge, code_challenge_method: "S256", state: "s" };
    const bad = await SELF.fetch(`${ORIGIN}/oauth/authorize?${new URLSearchParams({ ...base, redirect_uri: "https://evil.example/cb" })}`, { redirect: "manual" });
    expect(bad.status).toBe(400); // 戻り先へは返さない
    const noPkce = await SELF.fetch(`${ORIGIN}/oauth/authorize?${new URLSearchParams({ ...base, redirect_uri: REDIRECT, code_challenge_method: "plain" })}`, {
      redirect: "manual",
    });
    expect(new URL(noPkce.headers.get("location")!).searchParams.get("error")).toBe("invalid_request");

    const ok = await SELF.fetch(`${ORIGIN}/oauth/authorize?${new URLSearchParams({ ...base, redirect_uri: REDIRECT })}`, { redirect: "manual" });
    const state = new URL(ok.headers.get("location")!).searchParams.get("state");
    const noCookie = await SELF.fetch(`${ORIGIN}/oauth/github/callback?code=x&state=${state}`, { redirect: "manual" });
    expect(noCookie.status).toBe(400);
  });

  it("http の戻り先は localhost だけを許す", async () => {
    const r = await SELF.fetch(`${ORIGIN}/oauth/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ redirect_uris: ["http://example.com/cb"] }),
    });
    expect(r.status).toBe(400);
  });
});
