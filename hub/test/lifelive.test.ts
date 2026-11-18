import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { forwardToLifelive } from "../src/lifelive";

function recorder(status = 200) {
  const got: { url: string; headers: Record<string, string>; body: string }[] = [];
  const fetcher = {
    fetch: async (url: string, init: RequestInit) => {
      got.push({ url, headers: Object.fromEntries(new Headers(init.headers).entries()), body: new TextDecoder().decode(init.body as Uint8Array) });
      return new Response("{}", { status });
    },
  } as unknown as Fetcher;
  return { got, fetcher };
}

describe("LIFElive への受け渡し", () => {
  const raw = new TextEncoder().encode('{"ref":"refs/heads/main"}');

  it("push・PR・削除・作成を、GitHub の署名を付けたまま渡す", async () => {
    const { got, fetcher } = recorder();
    const e = { ...env, LIFELIVE_EVENTS_URL: "https://lifelive.test/github-events", LIFELIVE_API: fetcher };
    for (const ev of ["push", "pull_request", "delete", "create"]) expect(await forwardToLifelive(e, ev, `d-${ev}`, raw, "sha256=abc")).toBe(true);
    expect(got).toHaveLength(4);
    expect(got[0]).toMatchObject({ url: "https://lifelive.test/github-events", body: '{"ref":"refs/heads/main"}' });
    expect(got[0]!.headers).toMatchObject({ "x-github-event": "push", "x-github-delivery": "d-push", "x-hub-signature-256": "sha256=abc" });
  });

  it("送り先が無い・扱わない合図は渡さない。失敗しても止まらない", async () => {
    const { got, fetcher } = recorder(500);
    expect(await forwardToLifelive({ ...env, LIFELIVE_EVENTS_URL: "", LIFELIVE_API: fetcher }, "push", "d", raw, "s")).toBe(false);
    const e = { ...env, LIFELIVE_EVENTS_URL: "https://lifelive.test/github-events", LIFELIVE_API: fetcher };
    expect(await forwardToLifelive(e, "ping", "d", raw, "s")).toBe(false);
    expect(got).toHaveLength(0);
    expect(await forwardToLifelive(e, "push", "d", raw, "s")).toBe(false);
    const broken = { fetch: async () => { throw new Error("down"); } } as unknown as Fetcher;
    expect(await forwardToLifelive({ ...e, LIFELIVE_API: broken }, "push", "d", raw, "s")).toBe(false);
  });
});
