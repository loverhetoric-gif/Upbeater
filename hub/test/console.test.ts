import { env, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { sha256Hex } from "../src/crypto";
import { admin, OWNER, ORIGIN } from "./helpers";
import { connect, rpc, tool } from "./mcp-helpers";

async function redeem(code: string) {
  const r = await SELF.fetch(`${ORIGIN}/v1/console/redeem`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ code }) });
  return { status: r.status, body: (await r.json()) as any };
}

describe("管理アプリの接続コード", () => {
  it("管理 API で発行したコードを引き換えると MCP で使える接続が返る", async () => {
    const issued = await admin("POST", "/v1/admin/console-codes", { owner_id: OWNER });
    expect(issued.status).toBe(201);
    const { code, expires_at } = (await issued.json()) as any;
    expect(code).toHaveLength(10);
    expect(expires_at).toBeGreaterThan(Date.now());
    // ハイフン入り・小文字でも引き換えられる（アプリの入力形式 XXXXX-XXXXX）
    const r = await redeem(`${code.slice(0, 5).toLowerCase()}-${code.slice(5)}`);
    expect(r.status).toBe(201);
    expect(r.body.name).toBe("console-app");
    expect(r.body.token).toMatch(/^upb_m_/);
    // 平文は保存されていない
    expect(JSON.stringify((await env.DB.prepare("SELECT * FROM mcp_tokens").all()).results)).not.toContain(r.body.token);
    // その接続で MCP が使える
    expect((await rpc(r.body.token, "ping")).status).toBe(200);
    expect((await rpc(r.body.token, "tools/list")).body.result.tools.length).toBeGreaterThan(10);
  });

  it("MCP の道具 create_console_code で発行したコードも引き換えられる", async () => {
    const me = await connect();
    const c = await tool(me.access, "create_console_code");
    expect(c.ok).toBe(true);
    expect(c.hub_url).toBe(ORIGIN);
    const r = await redeem(c.code);
    expect(r.status).toBe(201);
    const row = await env.DB.prepare("SELECT owner_id FROM mcp_tokens WHERE name = 'console-app'").first<any>();
    expect(row.owner_id).toBe(me.owner);
  });

  it("使用済みのコードは二度引き換えられない", async () => {
    const { code } = (await (await admin("POST", "/v1/admin/console-codes", { owner_id: OWNER })).json()) as any;
    expect((await redeem(code)).status).toBe(201);
    const again = await redeem(code);
    expect(again.status).toBe(400);
    expect(again.body.error).toBe("invalid_code");
  });

  it("期限切れのコードは引き換えられない", async () => {
    const code = "ZZZZZZZZZZ";
    const now = Date.now();
    await env.DB.prepare("INSERT INTO console_registration_codes (code_hash, owner_id, expires_at, created_at) VALUES (?, ?, ?, ?)")
      .bind(await sha256Hex("console." + code), OWNER, now - 1, now - 16 * 60_000)
      .run();
    const r = await redeem(code);
    expect(r.status).toBe(400);
    expect(r.body.error).toBe("invalid_code");
  });

  it("存在しないコードは引き換えられない", async () => {
    const r = await redeem("23456789AB");
    expect(r.status).toBe(400);
    expect(r.body.error).toBe("invalid_code");
  });

  it("引き換えし直すと前の接続は使えなくなる", async () => {
    const first = (await (await admin("POST", "/v1/admin/console-codes", { owner_id: OWNER })).json()) as any;
    const t1 = (await redeem(first.code)).body.token as string;
    expect((await rpc(t1, "ping")).status).toBe(200);
    const second = (await (await admin("POST", "/v1/admin/console-codes", { owner_id: OWNER })).json()) as any;
    const t2 = (await redeem(second.code)).body.token as string;
    expect((await rpc(t1, "ping")).status).toBe(401);
    expect((await rpc(t2, "ping")).status).toBe(200);
  });
});
