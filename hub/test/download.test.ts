import { SELF, env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { sha256Hex } from "../src/crypto";
import { parseRange } from "../src/routes/artifacts";
import { createDownloadToken } from "../src/tokens";
import { createApp, deviceCall, pushAndSync, registerDevice, sha, upload } from "./helpers";

async function prepare(size = 200_000) {
  await createApp({ os: ["android"] });
  const dev = await registerDevice();
  await pushAndSync("app1", "Example/Repo", "main", sha("A"));
  const data = new Uint8Array(size);
  for (let i = 0; i < size; i++) data[i] = (i * 31 + 7) & 255;
  const rel = await upload("app1", 1, "android", data);
  const res = await deviceCall(dev.token, "/v1/devices/check", { app_id: "app1", current_seq: 0 });
  const { manifest } = (await res.json()) as { manifest: { payload: string } };
  const body = JSON.parse(atob(manifest.payload.replace(/-/g, "+").replace(/_/g, "/"))) as { url: string; sha256: string };
  return { data, rel, url: body.url, sha256: body.sha256, dev };
}

describe("成果物の取得", () => {
  it("中断したダウンロードを続きから再開でき、つないだ結果の SHA-256 が一致する", async () => {
    const { data, url, sha256 } = await prepare();
    expect(sha256).toBe(await sha256Hex(data));

    // 1 回目：途中（60,000 バイト）で中断したとみなす
    const part1 = await SELF.fetch(url, { headers: { range: "bytes=0-59999" } });
    expect(part1.status).toBe(206);
    expect(part1.headers.get("content-range")).toBe(`bytes 0-59999/${data.length}`);
    const a = new Uint8Array(await part1.arrayBuffer());
    expect(a.length).toBe(60_000);

    // 2 回目：続きから最後まで（If-Range で中身が変わっていないことを確かめる）
    const etag = part1.headers.get("etag")!;
    const part2 = await SELF.fetch(url, { headers: { range: `bytes=${a.length}-`, "if-range": etag } });
    expect(part2.status).toBe(206);
    const b = new Uint8Array(await part2.arrayBuffer());
    const joined = new Uint8Array(a.length + b.length);
    joined.set(a);
    joined.set(b, a.length);
    expect(joined.length).toBe(data.length);
    expect(await sha256Hex(joined)).toBe(sha256);

    // 全体の取得
    const full = await SELF.fetch(url);
    expect(full.status).toBe(200);
    expect(full.headers.get("accept-ranges")).toBe("bytes");
    expect(await sha256Hex(await full.arrayBuffer())).toBe(sha256);
  });

  it("中身が変わっていれば（If-Range 不一致）全体を返し、継ぎはぎさせない", async () => {
    const { url, data } = await prepare(1000);
    const res = await SELF.fetch(url, { headers: { range: "bytes=500-", "if-range": '"different"' } });
    expect(res.status).toBe(200);
    expect((await res.arrayBuffer()).byteLength).toBe(data.length);
  });

  it("範囲外の指定は 416", async () => {
    const { url, data } = await prepare(1000);
    const res = await SELF.fetch(url, { headers: { range: `bytes=${data.length}-` } });
    expect(res.status).toBe(416);
    expect(res.headers.get("content-range")).toBe(`bytes */${data.length}`);
  });

  it("トークンが無い・改ざん・期限切れ・別の成果物用なら拒否する", async () => {
    const { url, rel, dev } = await prepare(10);
    const u = new URL(url);
    expect((await SELF.fetch(u.origin + u.pathname)).status).toBe(403);
    expect((await SELF.fetch(url.slice(0, -2) + "xx")).status).toBe(403);
    const expired = await createDownloadToken("test-download-secret", { r: rel.id, d: dev.device_id, e: Date.now() - 1 });
    expect((await SELF.fetch(`${u.origin}${u.pathname}?t=${expired}`)).status).toBe(403);
    const other = await createDownloadToken("test-download-secret", { r: crypto.randomUUID(), d: dev.device_id, e: Date.now() + 60_000 });
    expect((await SELF.fetch(`${u.origin}${u.pathname}?t=${other}`)).status).toBe(403);
  });

  it("配信停止にした版は取得できない", async () => {
    const { url, rel } = await prepare(10);
    await env.DB.prepare("UPDATE releases SET status = 'halted' WHERE id = ?").bind(rel.id).run();
    expect((await SELF.fetch(url)).status).toBe(410);
  });

  it("Range の解釈", () => {
    expect(parseRange("bytes=0-9", 100)).toEqual({ offset: 0, length: 10 });
    expect(parseRange("bytes=90-", 100)).toEqual({ offset: 90, length: 10 });
    expect(parseRange("bytes=-10", 100)).toEqual({ offset: 90, length: 10 });
    expect(parseRange("bytes=95-200", 100)).toEqual({ offset: 95, length: 5 });
    expect(parseRange("bytes=100-", 100)).toBe("unsatisfiable");
    expect(parseRange("bytes=0-1,5-6", 100)).toBeNull();
    expect(parseRange("items=0-1", 100)).toBeNull();
    expect(parseRange(null, 100)).toBeNull();
  });
});
