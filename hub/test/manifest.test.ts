import { env, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { b64url, fromB64url } from "../src/crypto";
import {
  acceptManifest,
  evaluateManifest,
  parseSigningKeys,
  publicKeys,
  signManifest,
  verifyManifest,
  type ManifestBody,
  type SignedManifest,
  type SigningKeySet,
} from "../src/manifest";
import { createApp, deviceCall, ORIGIN, pushAndSync, registerDevice, sha, upload } from "./helpers";

const ALL = JSON.parse(env.TEST_ALL_SIGNING_KEYS) as SigningKeySet["keys"];
const NOW = Date.now();

function body(seq: number, extra: Partial<ManifestBody> = {}): Omit<ManifestBody, "v" | "key_generation"> {
  return {
    app_id: "app1",
    os: "android",
    seq,
    commit_sha: sha(seq),
    release_id: "r",
    sha256: "0".repeat(64),
    size: 1,
    url: "https://hub.test/x",
    issued_at: NOW,
    expires_at: NOW + 600_000,
    ...extra,
  };
}

function trusted(gens: number[]): Map<number, JsonWebKey> {
  return new Map(ALL.filter((k) => gens.includes(k.gen)).map((k) => [k.gen, { kty: "OKP", crv: "Ed25519", x: k.jwk.x }]));
}

const ctx = (current_seq: number) => ({ app_id: "app1", os: "android", current_seq, now: NOW });

describe("マニフェスト署名", () => {
  it("署名した中身は検証でき、1 バイトでも改ざんすれば拒否する", async () => {
    const set = { active: 1, keys: ALL };
    const signed = await signManifest(body(5), set, new Set());
    const ok = await verifyManifest(signed, trusted([1]), new Set());
    expect(ok.ok).toBe(true);

    const payload = fromB64url(signed.payload);
    payload[10] = payload[10]! ^ 1;
    const bad = await verifyManifest({ ...signed, payload: b64url(payload) }, trusted([1]), new Set());
    expect(bad).toEqual({ ok: false, reason: "bad_signature" });

    // 外側の世代番号だけを書き換えても通らない
    const swapped = await verifyManifest({ ...signed, key_generation: 2 }, trusted([1, 2]), new Set());
    expect(swapped.ok).toBe(false);
  });

  it("公開鍵の一覧に秘密成分を含めない", async () => {
    const res = await SELF.fetch(`${ORIGIN}/v1/keys`);
    const text = await res.text();
    expect(text).not.toContain('"d"');
    const v = JSON.parse(text) as { active: number; keys: { gen: number; status: string }[] };
    expect(v.active).toBe(2);
    expect(v.keys.map((k) => [k.gen, k.status])).toEqual([
      [1, "valid"],
      [2, "active"],
    ]);
  });
});

describe("鍵の世代交代", () => {
  it("複数世代の公開鍵を受け入れ、失効した世代は拒否する", async () => {
    const gen1 = await signManifest(body(5), { active: 1, keys: ALL }, new Set());
    const gen2 = await signManifest(body(6), { active: 2, keys: ALL }, new Set());
    const keys = trusted([1, 2]);

    // 交代の途中：旧世代・新世代のどちらで署名されたものも通る
    expect((await verifyManifest(gen1, keys, new Set())).ok).toBe(true);
    expect((await verifyManifest(gen2, keys, new Set())).ok).toBe(true);

    // 旧世代を失効（漏えい時）：旧世代の署名は拒否、新世代は通る
    expect(await verifyManifest(gen1, keys, new Set([1]))).toEqual({ ok: false, reason: "revoked_key" });
    expect((await verifyManifest(gen2, keys, new Set([1]))).ok).toBe(true);

    // 端末が知らない世代は拒否
    const gen3 = await signManifest(body(7), { active: 3, keys: ALL }, new Set());
    expect(await verifyManifest(gen3, keys, new Set())).toEqual({ ok: false, reason: "unknown_key" });

    // 失効した世代では署名しない
    await expect(signManifest(body(8), { active: 1, keys: ALL }, new Set([1]))).rejects.toThrow();
  });

  it("失効の設定は公開鍵の一覧に反映される", () => {
    const set = parseSigningKeys(JSON.stringify({ active: 3, keys: ALL }));
    expect(publicKeys(set, new Set([1])).map((k) => k.status)).toEqual(["revoked", "valid", "active"]);
    expect(() => parseSigningKeys(JSON.stringify({ active: 9, keys: ALL }))).toThrow();
    expect(() => parseSigningKeys(undefined)).toThrow();
  });
});

describe("古い版へのすり替えの拒否", () => {
  it("通番が現行より小さい版は、巻き戻し指示がない限り無効", async () => {
    const set = { active: 2, keys: ALL };
    const old = await signManifest(body(3), set, new Set());
    // 正しく署名された過去のマニフェストを再送されても、現行が 5 なら拒否
    expect(await acceptManifest(old, trusted([2]), new Set(), ctx(5))).toEqual({ ok: false, reason: "downgrade" });
    expect(await acceptManifest(old, trusted([2]), new Set(), ctx(3))).toEqual({ ok: false, reason: "same_version" });
    expect((await acceptManifest(old, trusted([2]), new Set(), ctx(2))).ok).toBe(true);

    // 署名付きの明示的な巻き戻し指示があれば受け入れる
    const rb = await signManifest(body(3, { rollback: { to_seq: 3 } }), set, new Set());
    expect(await acceptManifest(rb, trusted([2]), new Set(), ctx(5))).toMatchObject({ ok: true, action: "rollback" });

    // 指示の対象が別の通番なら無効
    const mismatch = await signManifest(body(3, { rollback: { to_seq: 2 } }), set, new Set());
    expect(await acceptManifest(mismatch, trusted([2]), new Set(), ctx(5))).toEqual({ ok: false, reason: "downgrade" });
  });

  it("署名の外で巻き戻し指示を付け足しても通らない", async () => {
    const set = { active: 2, keys: ALL };
    const old = await signManifest(body(3), set, new Set());
    const decoded = JSON.parse(new TextDecoder().decode(fromB64url(old.payload))) as ManifestBody;
    const forged: SignedManifest = { ...old, payload: b64url(JSON.stringify({ ...decoded, rollback: { to_seq: 3 } })) };
    expect(await acceptManifest(forged, trusted([2]), new Set(), ctx(5))).toEqual({ ok: false, reason: "bad_signature" });
  });

  it("期限切れ・別アプリ・別 OS のマニフェストは無効", async () => {
    const b = { v: 1, key_generation: 2, ...body(9) } as ManifestBody;
    expect(evaluateManifest({ ...b, expires_at: NOW - 1 }, ctx(1))).toEqual({ ok: false, reason: "expired" });
    expect(evaluateManifest({ ...b, app_id: "x" }, ctx(1))).toEqual({ ok: false, reason: "wrong_app" });
    expect(evaluateManifest({ ...b, os: "ios" }, ctx(1))).toEqual({ ok: false, reason: "wrong_os" });
  });

  it("Hub は巻き戻し先に固定されたアプリについて、署名付きの巻き戻し指示を出す", async () => {
    await createApp({ os: ["android"] });
    const dev = await registerDevice();
    await pushAndSync("app1", "Example/Repo", "main", sha("A"));
    await upload("app1", 1, "android", new Uint8Array([1]));
    await pushAndSync("app1", "Example/Repo", "main", sha("B"));
    await upload("app1", 2, "android", new Uint8Array([2]));
    await env.DB.prepare("UPDATE apps SET pinned_seq = 1 WHERE id = 'app1'").run();

    const res = await deviceCall(dev.token, "/v1/devices/check", { app_id: "app1", current_seq: 2 });
    const { manifest, public_keys } = (await res.json()) as {
      manifest: SignedManifest;
      public_keys: { gen: number; status: string; jwk: JsonWebKey }[];
    };
    const keys = new Map(public_keys.map((k) => [k.gen, k.jwk]));
    const r = await acceptManifest(manifest, keys, new Set(), { app_id: "app1", os: "android", current_seq: 2, now: Date.now() });
    expect(r).toMatchObject({ ok: true, action: "rollback", body: { seq: 1, rollback: { to_seq: 1 } } });
  });
});
