import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { canonicalJson, FORMAT, MAX_ATTEMPTS, runHubOut, signEnvelope } from "../src/hubout";
import type { Env } from "../src/env";
import { claim, finish, pushAndRun, registerRepo, registerRunner } from "./helpers";

// テスト専用の使い捨ての鍵（32 バイトの base64url）
const KEY = btoa(String.fromCharCode(...new Uint8Array(32).fill(7))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const ONE = `on: { push: { branches: [main] } }\njobs:\n  build:\n    runs-on: linux\n    steps: [{ run: make }]\n`;
const wired = (): Env => ({ ...env, HUB_KEY_LOVERHETORIC: KEY, HUB_WORLDRULERS_URL: "https://relay.test/" }) as Env;

const reply = (status: number, code?: string) => new Response(JSON.stringify(code ? { ok: false, code } : { ok: true }), { status });

async function failedRun(conclusion: "failure" | "success" = "failure") {
  await registerRepo();
  const t = await registerRunner(["linux"]);
  await pushAndRun("a", { ".upbeater/ci.yml": ONE });
  await finish(t, (await claim(t)).body, conclusion);
}

describe("LOVE connect HUB への失敗の知らせ", () => {
  it("鍵か送り先が無い間は何もしない", async () => {
    expect(await runHubOut({ ...env, HUB_WORLDRULERS_URL: "https://relay.test" } as Env)).toBeNull();
    expect(await runHubOut({ ...env, HUB_KEY_LOVERHETORIC: KEY } as Env)).toBeNull();
  });

  it("最初の 1 回は位置を決めるだけで、過去の失敗は送らない", async () => {
    await failedRun();
    const calls: string[] = [];
    const r = await runHubOut(wired(), Date.now() + 1000, async (u) => (calls.push(u), reply(200)));
    expect(r).toEqual({ queued: 0, sent: 0, dead: 0, retry: 0 });
    expect(calls).toEqual([]);
  });

  it("失敗した実行を、署名した event の封筒で送る（本文は最小）。成功した実行は送らない", async () => {
    const e = wired();
    await runHubOut(e, Date.now() - 10_000, async () => reply(200)); // 位置を決める
    await failedRun();
    const sent: { url: string; body: any }[] = [];
    const r = await runHubOut(e, Date.now() + 1000, async (url, init) => (sent.push({ url, body: JSON.parse(String(init.body)) }), reply(200)));
    expect(r).toMatchObject({ queued: 1, sent: 1, dead: 0 });
    expect(sent).toHaveLength(1);
    const { url, body } = sent[0]!;
    expect(url).toBe("https://relay.test/hub");
    const { sig, ...rest } = body;
    expect(Object.keys(rest).sort()).toEqual(["at", "b", "by", "c", "co", "f", "id", "l", "v"]);
    expect(rest).toMatchObject({ v: 1, l: "event", f: FORMAT, co: "loverhetoric", by: "upbeater", c: 1 });
    expect(Object.keys(rest.b).sort()).toEqual(["at", "reason", "repo", "run", "workflow"]);
    expect(rest.b).toMatchObject({ repo: "acme/widget", workflow: ".upbeater/ci.yml", run: 1 });
    expect(rest.id).toMatch(/^[A-Za-z0-9_-]{8,64}$/);
    expect(sig).toBe(await signEnvelope(KEY, rest));
    // もう一度回しても、同じ失敗は送らない
    expect(await runHubOut(e, Date.now() + 2000, async () => reply(200))).toMatchObject({ queued: 0, sent: 0 });
  });

  it("成功した実行は送らない", async () => {
    const e = wired();
    await runHubOut(e, Date.now() - 10_000);
    await failedRun("success");
    const calls: string[] = [];
    await runHubOut(e, Date.now() + 1000, async (u) => (calls.push(u), reply(200)));
    expect(calls).toEqual([]);
  });

  it("通信の失敗・5xx は同じ封筒で送り直し、DUPLICATE は届いたとみなす", async () => {
    const e = wired();
    await runHubOut(e, Date.now() - 10_000);
    await failedRun();
    const now = Date.now() + 1000;
    const bodies: string[] = [];
    const down = async (_u: string, init: RequestInit) => (bodies.push(String(init.body)), reply(503));
    expect(await runHubOut(e, now, down)).toMatchObject({ sent: 0, retry: 1 });
    // 間隔が空くまでは送らない
    expect(await runHubOut(e, now + 1000, down)).toMatchObject({ sent: 0, retry: 0 });
    const net = async (_u: string, init: RequestInit) => (bodies.push(String(init.body)), Promise.reject(new Error("offline")));
    expect(await runHubOut(e, now + 6 * 60_000, net)).toMatchObject({ retry: 1 });
    const dup = async (_u: string, init: RequestInit) => (bodies.push(String(init.body)), reply(409, "DUPLICATE"));
    expect(await runHubOut(e, now + 20 * 60_000, dup)).toMatchObject({ sent: 1 });
    expect(new Set(bodies).size).toBe(1); // 番号・時刻・署名が同じ封筒のまま
  });

  it("鍵の誤り・許可されていない（4xx）は送り直さず、理由の符号だけ残す", async () => {
    const e = wired();
    await runHubOut(e, Date.now() - 10_000);
    await failedRun();
    expect(await runHubOut(e, Date.now() + 1000, async () => reply(401, "BAD_SIGNATURE"))).toMatchObject({ dead: 1, retry: 0 });
    const row = await env.DB.prepare("SELECT dead_reason, envelope FROM hub_outbox").first<{ dead_reason: string; envelope: string }>();
    expect(row!.dead_reason).toBe("401 BAD_SIGNATURE");
    expect(await runHubOut(e, Date.now() + 3_600_000, async () => reply(200))).toMatchObject({ sent: 0 });
  });

  it("送り直しの上限を超えたら諦める", async () => {
    const e = wired();
    await runHubOut(e, Date.now() - 10_000);
    await failedRun();
    let now = Date.now() + 1000;
    let last: any;
    for (let i = 0; i < MAX_ATTEMPTS; i++) {
      last = await runHubOut(e, now, async () => reply(500));
      now += 2 * 3_600_000;
    }
    expect(last).toMatchObject({ dead: 1 });
  });

  it("鍵が読めない（短すぎる）間は、位置を進めず何も預けない", async () => {
    const e = { ...wired(), HUB_KEY_LOVERHETORIC: "short" } as Env;
    await runHubOut(e, Date.now() - 10_000);
    await failedRun();
    expect(await runHubOut(e, Date.now() + 1000, async () => reply(200))).toMatchObject({ queued: 0 });
    // 鍵が置かれたら、その間の失敗も送る
    expect(await runHubOut(wired(), Date.now() + 2000, async () => reply(200))).toMatchObject({ queued: 1, sent: 1 });
  });

  it("canonicalJson は項目名を並べ替える（受け口と同じ規則）", () => {
    expect(canonicalJson({ b: 1, a: { d: [1, undefined], c: "x" } })).toBe('{"a":{"c":"x","d":[1,null]},"b":1}');
  });
});
