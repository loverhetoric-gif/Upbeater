import { env, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { b64url, normalizeCode, sha256Hex } from "../src/crypto";
import { admin, ORIGIN } from "./helpers";
import { connectWithRepo, tool } from "./mcp-helpers";
import { SPEC_VERSION, isTaskId, newTaskId, pairingMessage } from "../src/vendor/love-connect-hub.mjs";

const REPO = "acme/widget";

async function register(owner: string, name: string, os = "android", extra: Record<string, unknown> = {}) {
  const { code } = (await (await admin("POST", "/v1/admin/device-codes", { owner_id: owner })).json()) as any;
  const r = await SELF.fetch(`${ORIGIN}/v1/devices/register`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ code, name, os, ...extra }) });
  const body = (await r.json()) as any;
  return { status: r.status, body, code, token: body.token as string, id: body.device_id as string };
}

const call = async (token: string, path: string, body?: unknown) => {
  const r = await SELF.fetch(`${ORIGIN}${path}`, { method: body === undefined ? "GET" : "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: r.status, body: (await r.json()) as any };
};

/** 配布できる版（ready）を直接入れる */
async function release(owner: string, repoId: string, seq: number, platform = "android") {
  await env.DB.prepare("INSERT INTO releases (id, owner_id, repo_id, platform, seq, commit_sha, sha256, size, status, install, created_at) VALUES (?, ?, ?, ?, ?, 'x', ?, 3, 'ready', '{}', 1)")
    .bind(crypto.randomUUID(), owner, repoId, platform, seq, "ab".repeat(32))
    .run();
}

async function setup() {
  const me = await connectWithRepo(REPO);
  const repoId = (await env.DB.prepare("SELECT id FROM repos").first<{ id: string }>())!.id;
  const set = (args: Record<string, unknown>) => tool(me.access, "set_distribution", { repo: REPO, platform: "android", ...args });
  const status = () => tool(me.access, "get_install_status", { repo: REPO });
  return { me, repoId, set, status };
}

const apps = async (t: string) => ((await call(t, "/v1/devices/apps")).body.apps as any[]).map((a) => a.ready_seq);
const check = (t: string, repoId: string, current = 0) => call(t, "/v1/devices/check", { app_id: repoId, current_seq: current });

describe("配布先の端末の指定", () => {
  it("指定が無ければ今まで通り全台。指定すると、その端末だけに届き、ほかの端末には 200 で「更新なし」を返す", async () => {
    const { me, repoId, set } = await setup();
    await release(me.owner, repoId, 1);
    const a = await register(me.owner, "pixel-a");
    const b = await register(me.owner, "pixel-b");
    expect(await apps(a.token)).toEqual([1]);
    expect((await check(b.token, repoId)).body.update).toBe(true);

    expect(await set({ devices: ["pixel-a"] })).toMatchObject({ ok: true, devices: ["pixel-a"] });
    expect(await apps(a.token)).toEqual([1]);
    expect((await check(a.token, repoId)).body.update).toBe(true);
    // 配布先でない端末：一覧に出ず、照合は 200 で更新なし（版の有無も知らせない）
    expect(await apps(b.token)).toEqual([]);
    const cb = await check(b.token, repoId, 0);
    expect(cb.status).toBe(200);
    expect(cb.body).toEqual({ update: false, latest_seq: 0, targeted: false });
    // 別の OS の配布には影響しない
    await release(me.owner, repoId, 1, "ios");
    const ios = await register(me.owner, "iphone", "ios");
    expect(await apps(ios.token)).toEqual([1]);
  });

  it("devices: [] で解除して全台に戻る。省くと今のまま。1 台でも違えば何も変えない（置き換えは一括）", async () => {
    const { me, repoId, set, status } = await setup();
    await release(me.owner, repoId, 1);
    const a = await register(me.owner, "pixel-a");
    const b = await register(me.owner, "pixel-b");
    await set({ devices: ["pixel-a"] });
    // devices を省いた設定の変更では、指定は変わらない
    await set({ paused: false, staged: false });
    expect(await apps(b.token)).toEqual([]);
    // 1 台でも存在しなければ、全部を断り、前の指定のまま
    const bad = await set({ devices: ["pixel-b", "nothing"] });
    expect(bad).toMatchObject({ ok: false, code: "device_not_found" });
    expect(JSON.stringify(bad)).toContain("nothing");
    expect((await status()).targets).toEqual([{ platform: "android", devices: [{ id: a.id, name: "pixel-a" }] }]);
    // 入れ替え
    await set({ devices: ["pixel-b", "pixel-b"] });
    expect(await apps(a.token)).toEqual([]);
    expect(await apps(b.token)).toEqual([1]);
    // 解除
    expect(await set({ devices: [] })).toMatchObject({ ok: true, devices: [] });
    expect(await apps(a.token)).toEqual([1]);
    expect((await status()).targets).toEqual([]);
    expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM dist_targets").first<{ n: number }>())!.n).toBe(0);
  });

  it("端末名の誤り：無い・OS が違う・名前が重複・他の利用者の端末は分かりやすい日本語で断る", async () => {
    const { me, repoId, set } = await setup();
    await release(me.owner, repoId, 1);
    const dup1 = await register(me.owner, "same");
    const dup2 = await register(me.owner, "same");
    await register(me.owner, "iphone", "ios");
    const other = await register("gh:9999", "their-pixel");
    const none = await set({ devices: ["ghost"] });
    expect(none).toMatchObject({ ok: false, code: "device_not_found" });
    expect(JSON.stringify(none)).toContain("端末「ghost」は登録されていません");
    const os = await set({ devices: ["iphone"] });
    expect(os).toMatchObject({ ok: false, code: "device_os_mismatch" });
    expect(JSON.stringify(os)).toContain("端末「iphone」は ios の端末です。android の配布先には指定できません");
    const dup = await set({ devices: ["same"] });
    expect(dup).toMatchObject({ ok: false, code: "device_name_ambiguous" });
    expect(JSON.stringify(dup)).toContain("id で指定");
    // id なら指定できる
    expect(await set({ devices: [dup2.id] })).toMatchObject({ ok: true, devices: ["same"] });
    expect(await apps(dup1.token)).toEqual([]);
    expect(await apps(dup2.token)).toEqual([1]);
    // 他の利用者の端末は、名前でも id でも、無いものとして扱う（あるかどうかも分からない）
    for (const ref of ["their-pixel", other.id]) {
      const r = await set({ devices: [ref] });
      expect(r).toMatchObject({ ok: false, code: "device_not_found" });
    }
    expect(await apps(other.token)).toEqual([]);
  });

  it("先行する端末（カナリア）：配布先の中から選ぶ。外れたら断り、既定は配布先の中で最初に登録した端末", async () => {
    const { me, repoId, set } = await setup();
    await release(me.owner, repoId, 1);
    const first = await register(me.owner, "first");
    const second = await register(me.owner, "second");
    const third = await register(me.owner, "third");
    await env.DB.prepare("UPDATE devices SET created_at = CASE name WHEN 'first' THEN 1 WHEN 'second' THEN 2 ELSE 3 END").run();
    // 配布先の外の端末は先行にできない
    expect(await set({ devices: ["second", "third"], canary_device: "first" })).toMatchObject({ ok: false, code: "canary_not_in_targets" });
    // 先行を決めないとき、既定は配布先（second・third）の最初＝second（全体の最初の first ではない）
    await set({ devices: ["second", "third"], staged: true });
    expect((await check(third.token, repoId)).body).toMatchObject({ update: false, staged: true });
    expect((await check(second.token, repoId)).body.update).toBe(true);
    expect((await check(first.token, repoId)).body.targeted).toBe(false);
    // 指定すると third が先行になる。今の指定の外を後から指定しても断る
    await set({ canary_device: "third" });
    expect((await check(third.token, repoId)).body.update).toBe(true);
    expect((await check(second.token, repoId)).body.staged).toBe(true);
    expect(await set({ canary_device: "first" })).toMatchObject({ ok: false, code: "canary_not_in_targets" });
    // 配布先を入れ替えて third が外れたら、先行の指定は外れ、配布先の最初（first）になる
    await set({ devices: ["first", "second"] });
    expect((await env.DB.prepare("SELECT canary_device_id FROM dist_settings").first<any>()).canary_device_id).toBeNull();
    expect((await check(first.token, repoId)).body.update).toBe(true);
    expect((await check(second.token, repoId)).body.staged).toBe(true);
    // 先行が入れ終えたら残りの配布先にも届く
    await call(first.token, "/v1/devices/report", { app_id: repoId, seq: 1, status: "installed" });
    expect((await check(second.token, repoId)).body.update).toBe(true);
  });

  it("失敗で止める台数：配布先が 1 台ならその 1 台の失敗で止まる。配布先でない端末の失敗は数えない", async () => {
    const { me, repoId, set } = await setup();
    await release(me.owner, repoId, 1);
    const a = await register(me.owner, "a");
    const b = await register(me.owner, "b");
    const c = await register(me.owner, "c");
    const state = async () => (await env.DB.prepare("SELECT status FROM releases WHERE seq = 1 AND platform = 'android'").first<{ status: string }>())!.status;
    const fail = (t: string) => call(t, "/v1/devices/report", { app_id: repoId, seq: 1, status: "failed", message: "失敗" });
    // 配布先が 1 台だけ：その 1 台で止まる（しきい値 2 だと永久に止まらない）
    await set({ devices: ["a"] });
    expect((await fail(a.token)).status).toBe(200);
    expect(await state()).toBe("halted");
    await env.DB.prepare("UPDATE releases SET status = 'ready'").run();
    await env.DB.prepare("DELETE FROM installs").run();
    // 配布先 a・b、配布先でない c の失敗は記録するが数えない
    await set({ devices: ["a", "b"] });
    await fail(c.token);
    await fail(a.token);
    expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM installs WHERE status = 'failed'").first<{ n: number }>())!.n).toBe(2);
    expect(await state()).toBe("ready");
    await fail(b.token);
    expect(await state()).toBe("halted");
    // 指定が無ければ従来どおり 2 台
    await env.DB.prepare("UPDATE releases SET status = 'ready'").run();
    await env.DB.prepare("DELETE FROM installs").run();
    await set({ devices: [] });
    await fail(a.token);
    expect(await state()).toBe("ready");
    await fail(c.token);
    expect(await state()).toBe("halted");
  });

  it("配布先でない端末には巻き戻しの指示も出さない", async () => {
    const { me, repoId, set } = await setup();
    await release(me.owner, repoId, 1);
    await release(me.owner, repoId, 2);
    const a = await register(me.owner, "a");
    const b = await register(me.owner, "b");
    await set({ devices: ["a"] });
    await tool(me.access, "rollback", { repo: REPO, platform: "android", seq: 1 });
    const rb = await check(a.token, repoId, 2);
    expect(rb.body.update).toBe(true);
    expect(rb.body.manifest).toBeTruthy();
    const nb = await check(b.token, repoId, 2);
    expect(nb.status).toBe(200);
    expect(nb.body).toEqual({ update: false, latest_seq: 2, targeted: false });
  });

  it("配布先の端末が無くなっても、全台には戻らず、誰にも配らない。状況には名前が出る", async () => {
    const { me, repoId, set, status } = await setup();
    await release(me.owner, repoId, 1);
    const a = await register(me.owner, "a");
    const b = await register(me.owner, "b");
    await set({ devices: ["a"] });
    await env.DB.prepare("DELETE FROM devices WHERE id = ?").bind(a.id).run();
    expect(await apps(b.token)).toEqual([]);
    expect((await check(b.token, repoId)).body).toMatchObject({ update: false, targeted: false });
    expect((await status()).targets).toEqual([{ platform: "android", devices: [] }]);
    // 失敗の報告でも止まらない（配布先は 0 台）
    await call(b.token, "/v1/devices/report", { app_id: repoId, seq: 1, status: "failed" });
    expect((await env.DB.prepare("SELECT status FROM releases").first<any>()).status).toBe("ready");
    // 解除すれば全台に戻る
    await set({ devices: [] });
    expect(await apps(b.token)).toEqual([1]);
  });

  it("get_install_status：OS ごとの配布先の名前と、端末ごとの targeted が出る。list_devices は id と端末の鍵の指紋を出す", async () => {
    const { me, repoId, set, status } = await setup();
    await release(me.owner, repoId, 1);
    const a = await register(me.owner, "a");
    const b = await register(me.owner, "b");
    for (const d of [a, b]) await call(d.token, "/v1/devices/report", { app_id: repoId, seq: 1, status: "installed" });
    expect((await status()).devices.map((d: any) => [d.device, d.targeted])).toEqual([["a", true], ["b", true]]);
    await set({ devices: ["b"] });
    const s = await status();
    expect(s.targets).toEqual([{ platform: "android", devices: [{ id: b.id, name: "b" }] }]);
    expect(s.devices.map((d: any) => [d.device, d.targeted])).toEqual([["a", false], ["b", true]]);
    const list = await tool(me.access, "list_devices");
    expect(list.devices.map((d: any) => [d.name, d.id, d.device_key])).toEqual([["a", a.id, null], ["b", b.id, null]]);
    expect(JSON.stringify(list)).not.toContain("token");
  });
});

describe("端末の鍵（LOVE connect HUB 規格 第21章）", () => {
  async function keyPair() {
    const pair = (await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"])) as CryptoKeyPair;
    const pub = b64url(new Uint8Array((await crypto.subtle.exportKey("raw", pair.publicKey)) as ArrayBuffer));
    return { pair, pub };
  }
  const sign = async (k: CryptoKeyPair, msg: string) => b64url(new Uint8Array(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, k.privateKey, new TextEncoder().encode(msg))));

  it("端末の鍵を添えた登録は署名を確かめて鍵を保存し、list_devices に指紋を出す。署名が合わなければ登録せず、コードも使わない", async () => {
    const { me } = await setup();
    const { pair, pub } = await keyPair();
    const { code } = (await (await admin("POST", "/v1/admin/device-codes", { owner_id: me.owner })).json()) as any;
    const post = (body: Record<string, unknown>) => SELF.fetch(`${ORIGIN}/v1/devices/register`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ code, name: "keyed", os: "android", ...body }) });
    const codeHash = await sha256Hex(normalizeCode(code));
    const msg = pairingMessage({ co: me.owner, by: "keyed", use: "device", pub, codeHash });
    // 別の端末名向けの署名・署名なし・別の鍵の署名は断る
    const other = await keyPair();
    expect((await post({ pub, sig: await sign(pair, pairingMessage({ co: me.owner, by: "other-name", use: "device", pub, codeHash })) })).status).toBe(401);
    expect((await post({ pub })).status).toBe(401);
    const forged = await post({ pub, sig: await sign(other.pair, msg) });
    expect(forged.status).toBe(401);
    expect(((await forged.json()) as any).error).toBe("PAIR_BAD_PROOF");
    expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM devices").first<{ n: number }>())!.n).toBe(0);
    // 正しい署名なら登録できる（断られてもコードは使われていない）
    const ok = await post({ pub, sig: await sign(pair, msg) });
    expect(ok.status).toBe(201);
    expect((await env.DB.prepare("SELECT pub FROM devices").first<any>()).pub).toBe(pub);
    const list = await tool(me.access, "list_devices");
    expect(list.devices[0].device_key).toBe((await sha256Hex(pub)).slice(0, 16));
    expect(JSON.stringify(list)).not.toContain(pub);
  });

  it("端末の鍵は任意：添えなくても今まで通り登録できる", async () => {
    const { me } = await setup();
    const r = await register(me.owner, "plain");
    expect(r.status).toBe(201);
    expect((await env.DB.prepare("SELECT pub FROM devices").first<any>()).pub).toBeNull();
  });
});

describe("取り込んだ LOVE connect HUB 本体", () => {
  it("Workers の中で動く（作業 ID・規格の版）", () => {
    expect(SPEC_VERSION).toBe(2);
    const id = newTaskId();
    expect(isTaskId(id)).toBe(true);
    expect(isTaskId("w-bad")).toBe(false);
  });
});
