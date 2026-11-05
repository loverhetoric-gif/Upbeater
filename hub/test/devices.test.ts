import { env, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { sha256Hex } from "../src/crypto";
import { acceptManifest, type SignedManifest } from "../src/manifest";
import { admin, createApp, deviceCall, ORIGIN, pushAndSync, registerDevice, sha, upload } from "./helpers";

const REPO = "Example/Repo";

async function register(code: string) {
  return SELF.fetch(`${ORIGIN}/v1/devices/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ code, name: "端末", os: "android" }),
  });
}

describe("端末の登録", () => {
  it("登録コードは一回限り。Hub はトークンのハッシュだけを保存する", async () => {
    const { code } = (await (await admin("POST", "/v1/admin/registration-codes", { owner_id: "owner1" })).json()) as { code: string };
    const first = await register(code.toLowerCase().replace(/(.{5})/, "$1-")); // 入力の揺れを許す
    expect(first.status).toBe(201);
    const { token, device_id } = (await first.json()) as { token: string; device_id: string };
    expect((await register(code)).status).toBe(400);

    const row = await env.DB.prepare("SELECT token_hash FROM devices WHERE id = ?").bind(device_id).first<{ token_hash: string }>();
    expect(row?.token_hash).toBe(await sha256Hex(token));
    const dump = JSON.stringify((await env.DB.prepare("SELECT * FROM devices").all()).results);
    expect(dump).not.toContain(token);
    const codes = JSON.stringify((await env.DB.prepare("SELECT * FROM registration_codes").all()).results);
    expect(codes).not.toContain(code);
  });

  it("同じ登録コードを同時に使っても 1 台しか登録されない", async () => {
    const { code } = (await (await admin("POST", "/v1/admin/registration-codes", { owner_id: "owner1" })).json()) as { code: string };
    const results = await Promise.all(Array.from({ length: 5 }, () => register(code)));
    expect(results.filter((r) => r.status === 201)).toHaveLength(1);
    const n = await env.DB.prepare("SELECT COUNT(*) AS n FROM devices").first<{ n: number }>();
    expect(n?.n).toBe(1);
  });

  it("期限切れの登録コードは使えない", async () => {
    const { code } = (await (await admin("POST", "/v1/admin/registration-codes", { owner_id: "owner1" })).json()) as { code: string };
    await env.DB.prepare("UPDATE registration_codes SET expires_at = 0").run();
    expect((await register(code)).status).toBe(400);
  });

  it("管理 API はトークンが無ければ拒否する", async () => {
    const res = await admin("POST", "/v1/admin/registration-codes", { owner_id: "owner1" }, { authorization: "Bearer wrong" });
    expect(res.status).toBe(401);
  });
});

describe("照合と結果報告", () => {
  it("長期間オフラインの端末には、途中の版を飛ばして最新版を返す", async () => {
    await createApp({ os: ["android", "linux"] });
    const dev = await registerDevice();
    for (const c of ["A", "B", "C"]) await pushAndSync("app1", REPO, "main", sha(c));
    // 1 と 2 は取り消し済み、3 だけ成果物が揃った
    await upload("app1", 3, "android", new Uint8Array([3, 3, 3]));

    const res = await deviceCall(dev.token, "/v1/devices/check", { app_id: "app1", current_seq: 0 });
    const v = (await res.json()) as { update: boolean; manifest: SignedManifest; public_keys: { gen: number; jwk: JsonWebKey }[] };
    expect(v.update).toBe(true);
    const keys = new Map(v.public_keys.map((k) => [k.gen, k.jwk]));
    const accepted = await acceptManifest(v.manifest, keys, new Set(), { app_id: "app1", os: "android", current_seq: 0, now: Date.now() });
    expect(accepted).toMatchObject({ ok: true, action: "update", body: { seq: 3, commit_sha: sha("C"), size: 3 } });

    // 最新版を使っていれば更新なし
    const same = await deviceCall(dev.token, "/v1/devices/check", { app_id: "app1", current_seq: 3 });
    expect(await same.json()).toEqual({ update: false, latest_seq: 3 });
  });

  it("成果物の揃っていない新しい版は返さず、揃った最新版を返す", async () => {
    await createApp({ os: ["android"] });
    const dev = await registerDevice();
    await pushAndSync("app1", REPO, "main", sha("A"));
    await upload("app1", 1, "android", new Uint8Array([1]));
    await pushAndSync("app1", REPO, "main", sha("B")); // ビルド中
    const res = await deviceCall(dev.token, "/v1/devices/check", { app_id: "app1", current_seq: 1 });
    expect(await res.json()).toEqual({ update: false, latest_seq: 1 });
  });

  it("取り消された古い版の成果物は登録できない", async () => {
    await createApp({ os: ["android"] });
    await pushAndSync("app1", REPO, "main", sha("A"));
    await pushAndSync("app1", REPO, "main", sha("B"));
    const res = await admin("PUT", "/v1/admin/apps/app1/versions/1/artifacts/android", new Uint8Array([1]));
    expect(res.status).toBe(409);
  });

  it("結果報告を installs と operations に記録する", async () => {
    await createApp({ os: ["android"] });
    const dev = await registerDevice();
    await pushAndSync("app1", REPO, "main", sha("A"));
    expect((await deviceCall(dev.token, "/v1/devices/report", { app_id: "app1", seq: 1, status: "failed", message: "容量不足" })).status).toBe(200);
    expect((await deviceCall(dev.token, "/v1/devices/report", { app_id: "app1", seq: 1, status: "installed" })).status).toBe(200);

    const inst = await env.DB.prepare("SELECT owner_id, seq, commit_sha, status FROM installs WHERE device_id = ?").bind(dev.device_id).all();
    expect(inst.results).toEqual([{ owner_id: "owner1", seq: 1, commit_sha: sha("A"), status: "installed" }]);
    const ops = await env.DB.prepare("SELECT status, reason FROM operations WHERE device_id = ? AND kind = 'install' ORDER BY id")
      .bind(dev.device_id)
      .all();
    expect(ops.results).toEqual([
      { status: "failed", reason: "容量不足" },
      { status: "ok", reason: null },
    ]);
    expect((await deviceCall(dev.token, "/v1/devices/report", { app_id: "app1", seq: 1, status: "unknown" })).status).toBe(400);
  });

  it("他の利用者のアプリは見えず、無効なトークンは拒否する", async () => {
    await createApp({ owner: "owner2" });
    const dev = await registerDevice("owner1");
    expect((await deviceCall(dev.token, "/v1/devices/check", { app_id: "app1", current_seq: 0 })).status).toBe(404);
    expect((await deviceCall("upb_d_invalid", "/v1/devices/check", { app_id: "app1", current_seq: 0 })).status).toBe(401);
  });
});
