import { env, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { deviceCall, ORIGIN, sha, upload } from "./helpers";
import { connect, mockCall, rpc, tool } from "./mcp-helpers";

const REPO = "acme/widget";

describe("MCP サーバー", () => {
  it("プロトコルの版の交渉・道具の一覧・誤りの扱い", async () => {
    const { access } = await connect();
    const init = await rpc(access, "initialize", { protocolVersion: "2025-03-26" });
    expect(init.body.result.protocolVersion).toBe("2025-03-26");
    const unknownVer = await rpc(access, "initialize", { protocolVersion: "1999-01-01" });
    expect(unknownVer.body.result.protocolVersion).toBe("2025-11-25");

    const list = await rpc(access, "tools/list");
    const names = list.body.result.tools.map((t: any) => t.name);
    for (const n of ["list_apps", "get_app", "register_app", "push_update", "rollback", "list_devices", "get_install_status", "create_branch", "commit_files", "open_pr", "merge_pr", "ship_change"]) {
      expect(names).toContain(n);
    }
    expect((await rpc(access, "nope")).body.error.code).toBe(-32601);
    expect((await rpc(access, "tools/call", { name: "get_app", arguments: {} })).body.error.code).toBe(-32602);
    expect((await rpc(access, "tools/call", { name: "get_app", arguments: { app_id: "x", extra: 1 } })).body.error.code).toBe(-32602);

    const note = await SELF.fetch(`${ORIGIN}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${access}` },
      body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
    });
    expect(note.status).toBe(202);
    const bad = await rpc(access, "ping", undefined, { origin: "https://evil.example" });
    expect(bad.status).toBe(403);
    expect((await rpc(access, "ping", undefined, { "mcp-protocol-version": "1999-01-01" })).status).toBe(400);
  });

  it("アプリの登録 → 一覧 → 配信 → 巻き戻し、利用者ごとに分離される", async () => {
    const me = await connect();
    const other = await connect({ login: "renamed", id: 424242 });
    await mockCall("seed", { repo: REPO, branch: "main", files: { "a.txt": "1" }, default: true });

    const reg = await tool(me.access, "register_app", { name: "Widget", repo: "Acme/Widget", kind: "build", target_os: ["android"] });
    expect(reg).toMatchObject({ ok: true, repo: REPO, branch: "main", first_sync: "created" });
    const again = await tool(me.access, "register_app", { name: "Widget", repo: REPO, kind: "build", target_os: ["android"] });
    expect(again).toMatchObject({ ok: true, already_registered: true, app_id: reg.app_id });

    expect((await tool(me.access, "list_apps")).apps).toHaveLength(1);
    expect((await tool(other.access, "list_apps")).apps).toHaveLength(0);
    expect(await tool(other.access, "get_app", { app_id: reg.app_id })).toMatchObject({ ok: false, code: "app_not_found" });

    // 版 1 と版 2 を用意する
    await upload(reg.app_id, 1, "android", new Uint8Array([1]));
    await mockCall("seed", { repo: REPO, branch: "main", files: { "a.txt": "2" } });
    const pushed = await tool(me.access, "push_update", { app_id: reg.app_id });
    expect(pushed).toMatchObject({ ok: true, sync: "created", latest_seq: 2 });
    await upload(reg.app_id, 2, "android", new Uint8Array([2]));

    // 端末の登録は MCP で発行したコードで行う
    const { code } = await tool(me.access, "create_registration_code");
    const regRes = await SELF.fetch(`${ORIGIN}/v1/devices/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code, name: "Pixel", os: "android" }),
    });
    const dev = (await regRes.json()) as { token: string; device_id: string };
    await deviceCall(dev.token, "/v1/devices/report", { app_id: reg.app_id, seq: 2, status: "installed" });

    const rb = await tool(me.access, "rollback", { app_id: reg.app_id, seq: 1 });
    expect(rb).toMatchObject({ ok: true, target_seq: 1, pinned: true });
    const status = await tool(me.access, "get_install_status", { app_id: reg.app_id });
    expect(status.items[0]).toMatchObject({ installed_seq: 2, target_seq: 1, pending_update: true });
    const check = (await (await deviceCall(dev.token, "/v1/devices/check", { app_id: reg.app_id, current_seq: 2 })).json()) as any;
    expect(check.update).toBe(true);

    expect(await tool(me.access, "rollback", { app_id: reg.app_id, seq: 9 })).toMatchObject({ ok: false, code: "invalid_input" });
    const unpin = await tool(me.access, "push_update", { app_id: reg.app_id });
    expect(unpin.ok).toBe(true);
    const app = await env.DB.prepare("SELECT pinned_seq FROM apps WHERE id = ?").bind(reg.app_id).first();
    expect(app).toEqual({ pinned_seq: null });

    const devices = await tool(me.access, "list_devices");
    expect(devices.devices.map((d: any) => d.name)).toEqual(["Pixel"]);
    const ops = await tool(me.access, "list_operations", { app_id: reg.app_id });
    expect(ops.operations.length).toBeGreaterThan(0);
    void sha;
  });

  it("GitHub App が入っていないリポジトリは登録できず、人の判断が要るものとして返す", async () => {
    const { access } = await connect();
    await mockCall("repo", { repo: REPO, uninstalled: true });
    const r = await tool(access, "register_app", { name: "W", repo: REPO, kind: "direct", target_os: ["linux"] });
    expect(r).toMatchObject({ ok: false, needs_human: true });
    expect(r.reason).toContain("インストールされていません");
  });
});
