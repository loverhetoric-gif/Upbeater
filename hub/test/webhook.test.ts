import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { createApp, mock, pushPayload, sendWebhook, sha, versions } from "./helpers";

const REPO = "Example/Repo";

describe("Webhook の受信と検証", () => {
  it("署名不一致は 401 で拒否し、何も記録しない", async () => {
    await createApp();
    await mock.setHead(REPO, "main", sha(1));
    const payload = pushPayload(REPO, "main", sha(1));

    expect((await sendWebhook(payload, { secret: "wrong-secret" })).status).toBe(401);
    expect((await sendWebhook(payload, { signature: null })).status).toBe(401);
    expect((await sendWebhook(payload, { signature: "sha256=" + "0".repeat(64) })).status).toBe(401);
    expect((await sendWebhook(payload, { signature: "sha256=abc" })).status).toBe(401);
    // 署名後に本文を書き換えたもの
    const good = await sendWebhook(payload, { delivery: "x" , signature: undefined });
    expect(good.status).toBe(202);
    const tampered = await sendWebhook(
      { ...payload, ref: "refs/heads/evil" },
      { signature: "sha256=" + "a".repeat(64), delivery: "tampered" },
    );
    expect(tampered.status).toBe(401);

    const rows = await env.DB.prepare("SELECT COUNT(*) AS n FROM webhook_deliveries").first<{ n: number }>();
    expect(rows?.n).toBe(1); // 正しい 1 件だけ
  });

  it("Webhook のシークレットが未設定なら受け付けない（安全側）", async () => {
    const { default: worker } = await import("../src/index");
    const res = await worker.fetch(
      new Request("https://hub.test/webhook/github", { method: "POST", body: "{}" }),
      { ...env, WEBHOOK_SECRET: undefined },
    );
    expect(res.status).toBe(503);
  });

  it("同じ配信 ID の重複は捨てる", async () => {
    await createApp();
    await mock.setHead(REPO, "main", sha(1));
    const payload = pushPayload(REPO, "main", sha(1));
    const first = await sendWebhook(payload, { delivery: "dup-1" });
    expect(first.status).toBe(202);
    const second = await sendWebhook(payload, { delivery: "dup-1" });
    expect(second.status).toBe(200);
    expect(await second.json()).toMatchObject({ duplicate: true });
    expect(await mock.calls()).toBe(1);
    expect(await versions("app1")).toHaveLength(1);
  });

  it("登録済みアプリの対象ブランチだけを扱う", async () => {
    await createApp({ branch: "main" });
    await mock.setHead(REPO, "feature/x", sha(9));
    const other = await sendWebhook(pushPayload(REPO, "feature/x", sha(9)));
    expect(await other.json()).toMatchObject({ ignored: "not_registered" });
    const unknown = await sendWebhook(pushPayload("someone/else", "main", sha(9)));
    expect(await unknown.json()).toMatchObject({ ignored: "not_registered" });
    const tag = await sendWebhook({ ref: "refs/tags/v1", repository: { full_name: REPO } });
    expect(await tag.json()).toMatchObject({ ignored: "ref" });
    const issue = await sendWebhook({ repository: { full_name: REPO } }, { event: "issues" });
    expect(await issue.json()).toMatchObject({ ignored: "event" });
    const ping = await sendWebhook({ zen: "x" }, { event: "ping" });
    expect(ping.status).toBe(200);
    expect(await mock.calls()).toBe(0);
    expect(await versions("app1")).toHaveLength(0);
  });

  it("リポジトリ名の大文字・小文字の違いを同一とみなす", async () => {
    await createApp({ repo: "Example/Repo" });
    await mock.setHead(REPO, "main", sha(1));
    const res = await sendWebhook(pushPayload("example/REPO", "main", sha(1)));
    expect(await res.json()).toMatchObject({ outcomes: { app1: "created" } });
  });
});
