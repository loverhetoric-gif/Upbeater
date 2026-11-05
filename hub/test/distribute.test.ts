import { env, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { toHex } from "../src/crypto";
import { parseSigningKeys, verifyManifest } from "../src/manifest";
import { admin, claim, commit, finish, OWNER, ORIGIN, pullRequest, pushAndRun, registerRepo, registerRunner, webhook } from "./helpers";

const WF = `on: { push: {}, pull_request: {} }\njobs:\n  app:\n    runs-on: linux\n    steps:\n      - run: make\n      - distribute: { platform: android, file: app.apk, install: { package: com.example.app } }\n`;
const bytes = (s: string) => new TextEncoder().encode(s);
const hash = async (d: Uint8Array) => toHex(await crypto.subtle.digest("SHA-256", d));

/** ジョブを受け取り、配布のファイルを送って終える */
async function build(t: string, content: string, conclusion: "success" | "failure" = "success") {
  const c = (await claim(t)).body;
  const data = bytes(content);
  const r = await SELF.fetch(`${ORIGIN}/v1/runners/jobs/${c.job.id}/artifacts/distribute-android`, {
    method: "PUT",
    headers: { authorization: `Bearer ${t}`, "x-upbeater-job-token": c.job_token, "content-length": String(data.length), "x-upbeater-sha256": await hash(data), "x-upbeater-format": "file", "x-upbeater-filename": "app.apk" },
    body: data,
  });
  expect(r.status).toBe(201);
  await finish(t, c, conclusion);
  return data;
}

async function device(name: string, os = "android") {
  const { code } = (await (await admin("POST", "/v1/admin/device-codes", { owner_id: OWNER })).json()) as any;
  const r = await SELF.fetch(`${ORIGIN}/v1/devices/register`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ code, name, os }) });
  expect(r.status).toBe(201);
  return ((await r.json()) as any).token as string;
}

const call = async (token: string, path: string, body?: unknown) => {
  const r = await SELF.fetch(`${ORIGIN}${path}`, { method: body === undefined ? "GET" : "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: r.status, body: (await r.json()) as any };
};

async function setup() {
  const repoId = await registerRepo();
  const t = await registerRunner(["linux"]);
  return { repoId, t };
}

describe("端末への配布", () => {
  it("既定ブランチのジョブが成功したら版にし、署名つきのマニフェストで届け、続きから取得できる", async () => {
    const { repoId, t } = await setup();
    await pushAndRun("a", { ".upbeater/ci.yml": WF });
    const data = await build(t, "APK の中身 1");
    const d = await device("pixel");
    const apps = await call(d, "/v1/devices/apps");
    expect(apps.body.apps).toEqual([{ app_id: repoId, name: "acme/widget", ready_seq: 1 }]);
    const c = await call(d, "/v1/devices/check", { app_id: repoId, current_seq: 0 });
    expect(c.body.update).toBe(true);
    const keys = parseSigningKeys(env.MANIFEST_SIGNING_KEYS);
    const trusted = new Map(keys.keys.map((k) => [k.gen, { kty: "OKP", crv: "Ed25519", x: k.jwk.x } as JsonWebKey]));
    const v = await verifyManifest(c.body.manifest, trusted, new Set());
    expect(v.ok).toBe(true);
    const body = (v as any).body;
    expect(body).toMatchObject({ app_id: repoId, os: "android", seq: 1, sha256: await hash(data), size: data.length, install: { package: "com.example.app" } });
    // 続きから（Range）
    const part = await SELF.fetch(body.url, { headers: { range: "bytes=4-" } });
    expect(part.status).toBe(206);
    expect(new Uint8Array(await part.arrayBuffer())).toEqual(data.slice(4));
    expect((await SELF.fetch(body.url.replace(/t=[^&]+/, "t=bad"))).status).toBe(403);
    // 入れ終えた版より新しい版が無ければ何もしない
    expect((await call(d, "/v1/devices/check", { app_id: repoId, current_seq: 1 })).body.update).toBe(false);
  });

  it("PR の実行・失敗したジョブの成果物は端末に届けない", async () => {
    const { repoId, t } = await setup();
    const s = await commit("pr", { ".upbeater/ci.yml": WF }, { branch: null });
    await webhook("pull_request", pullRequest(s));
    await build(t, "PR の APK");
    await pushAndRun("b", { ".upbeater/ci.yml": WF });
    await build(t, "失敗した APK", "failure");
    const d = await device("pixel");
    expect((await call(d, "/v1/devices/check", { app_id: repoId, current_seq: 0 })).body.update).toBe(false);
    const st = (await env.DB.prepare("SELECT status FROM releases").all()).results.map((r: any) => r.status);
    expect(st).toEqual(["discarded", "discarded"]);
  });

  it("途中の版は飛ばして最新を届け、同じ版が 2 台で失敗したら配布を止めて前の版に戻す", async () => {
    const { repoId, t } = await setup();
    await pushAndRun("a", { ".upbeater/ci.yml": WF });
    await build(t, "版 1");
    await pushAndRun("b", { ".upbeater/ci.yml": WF });
    await build(t, "版 2");
    await pushAndRun("c", { ".upbeater/ci.yml": WF });
    await build(t, "版 3");
    const d1 = await device("a");
    const d2 = await device("b");
    expect((await call(d1, "/v1/devices/check", { app_id: repoId, current_seq: 0 })).body.latest_seq).toBe(3);
    await call(d1, "/v1/devices/report", { app_id: repoId, seq: 3, status: "failed", message: "導入に失敗" });
    expect((await env.DB.prepare("SELECT status FROM releases WHERE seq = 3").first<any>()).status).toBe("ready");
    await call(d2, "/v1/devices/report", { app_id: repoId, seq: 3, status: "rolled_back" });
    expect((await env.DB.prepare("SELECT status FROM releases WHERE seq = 3").first<any>()).status).toBe("halted");
    const ops = (await env.DB.prepare("SELECT needs_human FROM operations WHERE kind = 'release' AND stage = 'halted'").all()).results;
    expect(ops).toEqual([{ needs_human: 1 }]);
    const v = await verifyManifest((await call(d1, "/v1/devices/check", { app_id: repoId, current_seq: 0 })).body.manifest, new Map(parseSigningKeys(env.MANIFEST_SIGNING_KEYS).keys.map((k) => [k.gen, { kty: "OKP", crv: "Ed25519", x: k.jwk.x } as JsonWebKey])), new Set());
    expect((v as any).body.seq).toBe(2);
  });

  it("一時停止・巻き戻し・段階配信（先行する 1 台で入れ終えてから残り全台）", async () => {
    const { repoId, t } = await setup();
    await pushAndRun("a", { ".upbeater/ci.yml": WF });
    await build(t, "版 1");
    await pushAndRun("b", { ".upbeater/ci.yml": WF });
    await build(t, "版 2");
    const first = await device("first");
    const second = await device("second");
    const now = Date.now();
    await env.DB.prepare("INSERT INTO dist_settings (owner_id, repo_id, platform, paused, updated_at) VALUES (?, ?, 'android', 1, ?)").bind(OWNER, repoId, now).run();
    expect((await call(first, "/v1/devices/check", { app_id: repoId, current_seq: 1 })).body).toMatchObject({ update: false, paused: true });
    // 巻き戻し：新しい版を入れた端末にも、署名つきの巻き戻しの指示を出す
    await env.DB.prepare("UPDATE dist_settings SET paused = 0, pinned_seq = 1").run();
    const rb = await call(first, "/v1/devices/check", { app_id: repoId, current_seq: 2 });
    expect(JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(rb.body.manifest.payload.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0))))).toMatchObject({ seq: 1, rollback: { to_seq: 1 } });
    // 段階配信
    await env.DB.prepare("UPDATE dist_settings SET pinned_seq = NULL, staged = 1").run();
    expect((await call(second, "/v1/devices/check", { app_id: repoId, current_seq: 1 })).body).toMatchObject({ update: false, staged: true });
    expect((await call(first, "/v1/devices/check", { app_id: repoId, current_seq: 1 })).body.update).toBe(true);
    await call(first, "/v1/devices/report", { app_id: repoId, seq: 2, status: "installed" });
    expect((await call(second, "/v1/devices/check", { app_id: repoId, current_seq: 1 })).body.update).toBe(true);
  });

  it("登録コードは一回限りで、別の利用者のリポジトリは見えない", async () => {
    const { repoId } = await setup();
    const { code } = (await (await admin("POST", "/v1/admin/device-codes", { owner_id: OWNER })).json()) as any;
    const reg = () => SELF.fetch(`${ORIGIN}/v1/devices/register`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ code, name: "x", os: "android" }) });
    expect((await reg()).status).toBe(201);
    expect((await reg()).status).toBe(400);
    const { code: other } = (await (await admin("POST", "/v1/admin/device-codes", { owner_id: "someone" })).json()) as any;
    const r = await SELF.fetch(`${ORIGIN}/v1/devices/register`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ code: other, name: "y", os: "android" }) });
    const tok = ((await r.json()) as any).token;
    expect((await call(tok, "/v1/devices/check", { app_id: repoId, current_seq: 0 })).status).toBe(404);
  });
});
