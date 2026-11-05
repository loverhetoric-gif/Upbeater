import { createExecutionContext, createScheduledController, env, waitOnExecutionContext } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { backoffDelay, RETRY_BASE_MS } from "../src/coordinator";
import worker from "../src/index";
import { coordinatorState, createApp, mock, pushAndSync, pushPayload, runAlarm, sendWebhook, sha, versions } from "./helpers";

const REPO = "Example/Repo";

async function releases(appId: string) {
  const r = await env.DB.prepare("SELECT seq, os, status FROM releases WHERE app_id = ? ORDER BY seq, os").bind(appId).all<{
    seq: number;
    os: string;
    status: string;
  }>();
  return r.results;
}

async function ops(appId: string, status?: string) {
  const r = await env.DB.prepare(`SELECT * FROM operations WHERE app_id = ? AND kind = 'sync' ${status ? "AND status = ?" : ""} ORDER BY id`)
    .bind(...(status ? [appId, status] : [appId]))
    .all<{ status: string; reason: string; needs_human: number; retryable: number; detail: string }>();
  return r.results;
}

async function runCron() {
  const ctx = createExecutionContext();
  await worker.scheduled(createScheduledController({ cron: "*/15 * * * *" }), env, ctx);
  await waitOnExecutionContext(ctx);
}

describe("版の判定（到着順を信用しない）", () => {
  it("順序が逆転して届いても、GitHub の現在のコミットで判断する", async () => {
    await createApp();
    // 実際には A → B の順に push されたが、B の通知が先に届き、A の通知が後から届く
    await mock.setHead(REPO, "main", sha("B"));
    await sendWebhook(pushPayload(REPO, "main", sha("B")));
    const late = await sendWebhook(pushPayload(REPO, "main", sha("A")));
    expect(await late.json()).toMatchObject({ outcomes: { app1: "unchanged" } });
    expect(await versions("app1")).toEqual([{ seq: 1, commit_sha: sha("B"), source: "webhook" }]);
  });

  it("強制プッシュで過去の状態に戻っても、新しい通番の版になる", async () => {
    await createApp();
    await pushAndSync("app1", REPO, "main", sha("A"));
    await pushAndSync("app1", REPO, "main", sha("B"));
    await pushAndSync("app1", REPO, "main", sha("A")); // 強制プッシュで A に戻す
    const v = await versions("app1");
    expect(v.map((x) => [x.seq, x.commit_sha])).toEqual([
      [1, sha("A")],
      [2, sha("B")],
      [3, sha("A")],
    ]);
    const app = await env.DB.prepare("SELECT last_seq, current_sha FROM apps WHERE id = 'app1'").first();
    expect(app).toEqual({ last_seq: 3, current_sha: sha("A") });
  });

  it("連続した更新は 1 回の照合にまとめ、最新だけを扱う", async () => {
    await createApp();
    await mock.setHead(REPO, "main", sha("C"));
    await mock.delay(150); // 照合中に後続の通知が届く状況を作る
    const results = await Promise.all(
      ["A", "B", "C", "C2", "C3"].map((c) => sendWebhook(pushPayload(REPO, "main", sha(c)))),
    );
    for (const r of results) expect(r.status).toBe(202);
    const v = await versions("app1");
    expect(v).toHaveLength(1);
    expect(v[0]!.commit_sha).toBe(sha("C"));
    // 5 件の通知に対して、GitHub への照会は高々 2 回（実行中の 1 回＋まとめた再照合 1 回）
    expect(await mock.calls()).toBeLessThanOrEqual(2);
  });

  it("新しい版ができたら、進行中の古い版の配布物は取り消す", async () => {
    await createApp({ os: ["android"] });
    await pushAndSync("app1", REPO, "main", sha("A"));
    await pushAndSync("app1", REPO, "main", sha("B"));
    expect(await releases("app1")).toEqual([
      { seq: 1, os: "android", status: "cancelled" },
      { seq: 2, os: "android", status: "pending" },
    ]);
  });
});

describe("取りこぼし対策（Cron による巡回）", () => {
  it("Webhook が届かなくても、巡回で最新版に追いつく", async () => {
    await createApp({ id: "app1" });
    await createApp({ id: "app2", repo: "other/repo", branch: "release" });
    await mock.setHead(REPO, "main", sha("X"));
    await mock.setHead("other/repo", "release", sha("Y"));
    // Webhook は一度も届かない
    await runCron();
    expect((await versions("app1")).map((x) => x.commit_sha)).toEqual([sha("X")]);
    expect((await versions("app2")).map((x) => x.commit_sha)).toEqual([sha("Y")]);
    expect((await versions("app1"))[0]!.source).toBe("cron");
    // 変化がなければ巡回しても版は増えない（冪等）
    await runCron();
    expect(await versions("app1")).toHaveLength(1);
  });

  it("古い受信記録は巡回で削除する", async () => {
    await env.DB.prepare("INSERT INTO webhook_deliveries (delivery_id, owner_id, event, received_at) VALUES ('old', '', 'push', 0)").run();
    await runCron();
    const n = await env.DB.prepare("SELECT COUNT(*) AS n FROM webhook_deliveries WHERE delivery_id = 'old'").first<{ n: number }>();
    expect(n?.n).toBe(0);
  });
});

describe("GitHub の障害・回数制限", () => {
  it("障害時は待ち行列に残し、間隔を広げて再試行し、回復後に追いつく", async () => {
    await createApp();
    await mock.setHead(REPO, "main", sha("A"));
    await mock.fail(2, 503);

    const t0 = Date.now();
    const res = await sendWebhook(pushPayload(REPO, "main", sha("A")));
    expect(res.status).toBe(202); // GitHub が落ちていても受け付ける
    expect(await res.json()).toMatchObject({ outcomes: { app1: "retry_scheduled" } });
    const s1 = await coordinatorState("app1");
    expect(s1.attempt).toBe(1);
    expect(s1.dirty).toBe(true);
    const d1 = s1.alarm! - t0;
    expect(d1).toBeGreaterThanOrEqual(RETRY_BASE_MS - 1000);

    // 待機中に届いた通知は GitHub に問い合わせず、待ち行列に残す
    const callsBefore = await mock.calls();
    const queued = await sendWebhook(pushPayload(REPO, "main", sha("A")));
    expect(await queued.json()).toMatchObject({ outcomes: { app1: "queued" } });
    expect(await mock.calls()).toBe(callsBefore);

    // 2 回目も失敗 → 間隔が広がる
    const t1 = Date.now();
    expect(await runAlarm("app1")).toBe(true);
    const s2 = await coordinatorState("app1");
    expect(s2.attempt).toBe(2);
    expect(s2.alarm! - t1).toBeGreaterThan(d1);

    // 回復
    expect(await runAlarm("app1")).toBe(true);
    expect((await versions("app1")).map((x) => [x.seq, x.commit_sha, x.source])).toEqual([[1, sha("A"), "retry"]]);
    const s3 = await coordinatorState("app1");
    expect(s3).toMatchObject({ attempt: 0, dirty: false, alarm: null });

    const retries = await ops("app1", "retry");
    expect(retries).toHaveLength(2);
    expect(retries.every((r) => r.retryable === 1)).toBe(true);
  });

  it("回数制限では GitHub が指定した時間まで待つ", async () => {
    await createApp();
    await mock.setHead(REPO, "main", sha("A"));
    await mock.fail(1, 429, { "retry-after": "1800" });
    const t0 = Date.now();
    await sendWebhook(pushPayload(REPO, "main", sha("A")));
    const s = await coordinatorState("app1");
    expect(s.alarm! - t0).toBeGreaterThanOrEqual(1800_000 - 1000);

    await mock.fail(1, 403, { "x-ratelimit-remaining": "0", "x-ratelimit-reset": String(Math.floor(Date.now() / 1000) + 7200) });
    await runAlarm("app1");
    const s2 = await coordinatorState("app1");
    expect(s2.attempt).toBe(2);
    expect(s2.alarm! - Date.now()).toBeGreaterThan(7000_000);

    await runAlarm("app1");
    expect(await versions("app1")).toHaveLength(1);
  });

  it("GitHub に接続できない場合も再試行する", async () => {
    await createApp();
    await mock.fail(1, 502);
    await mock.setHead(REPO, "main", sha("A"));
    await sendWebhook(pushPayload(REPO, "main", sha("A")));
    expect((await coordinatorState("app1")).attempt).toBe(1);
    await runAlarm("app1");
    expect(await versions("app1")).toHaveLength(1);
  });

  it("権限の失効は再試行せず、人の判断が要るものとして記録する", async () => {
    await createApp();
    await mock.setHead(REPO, "main", sha("A"));
    await mock.fail(3, 401);
    const res = await sendWebhook(pushPayload(REPO, "main", sha("A")));
    expect(await res.json()).toMatchObject({ outcomes: { app1: "failed" } });
    const failed = await ops("app1", "failed");
    expect(failed).toHaveLength(1);
    expect(failed[0]!.needs_human).toBe(1);
    expect(await coordinatorState("app1")).toMatchObject({ alarm: null, dirty: false });
  });

  it("ブランチが削除されたら版を作らず、記録する", async () => {
    await createApp();
    await pushAndSync("app1", REPO, "main", sha("A"));
    await mock.setHead(REPO, "main", null);
    const res = await sendWebhook(pushPayload(REPO, "main", "0".repeat(40)));
    expect(await res.json()).toMatchObject({ outcomes: { app1: "branch_missing" } });
    expect(await versions("app1")).toHaveLength(1);
  });

  it("再試行の間隔は倍々に広がり、上限で止まる", () => {
    const r = () => 0;
    expect(backoffDelay(1, undefined, r)).toBe(30_000);
    expect(backoffDelay(2, undefined, r)).toBe(60_000);
    expect(backoffDelay(3, undefined, r)).toBe(120_000);
    expect(backoffDelay(50, undefined, r)).toBe(3_600_000);
    expect(backoffDelay(1, 90_000, r)).toBe(90_000);
  });
});
