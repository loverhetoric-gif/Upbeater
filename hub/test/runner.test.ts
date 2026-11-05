import { env, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { MAX_ATTEMPTS } from "../src/routes/runner";
import { noticeWaitingJobs, sweepJobs } from "../src/scheduled";
import { claim, finish, jobCall, jobsOf, ORIGIN, pushAndRun, registerRepo, registerRunner } from "./helpers";

const one = (extra = "") => `on: { push: { branches: [main] } }\njobs:\n  build:\n    runs-on: linux\n${extra}    steps: [{ run: make }]\n`;

describe("Runner の登録と受け取り", () => {
  it("登録コードは一回限りで、Hub はトークンのハッシュだけを保存する", async () => {
    const { admin } = await import("./helpers");
    const { code } = (await (await admin("POST", "/v1/admin/runner-codes", { owner_id: "owner1" })).json()) as { code: string };
    const reg = (body: unknown) => SELF.fetch(`${ORIGIN}/v1/runners/register`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    const r = await reg({ code, name: "mac", labels: ["macos"] });
    expect(r.status).toBe(201);
    const { token } = (await r.json()) as { token: string };
    expect((await reg({ code, name: "again", labels: ["macos"] })).status).toBe(400);
    const dump = JSON.stringify((await env.DB.prepare("SELECT * FROM runners").all()).results);
    expect(dump).not.toContain(token);
  });

  it("同じジョブを二重に渡さない（同時に取りに来ても 1 台だけ）", async () => {
    await registerRepo();
    const runners = await Promise.all([1, 2, 3, 4, 5].map((i) => registerRunner(["linux"], `r${i}`)));
    await pushAndRun("a", { ".upbeater/ci.yml": one() });
    const results = await Promise.all(runners.map((t) => claim(t)));
    expect(results.filter((r) => r.status === 200)).toHaveLength(1);
    expect(results.filter((r) => r.status === 204)).toHaveLength(4);
  });

  it("ラベルに合うジョブだけを渡す", async () => {
    await registerRepo();
    const mac = await registerRunner(["macos"]);
    const linux = await registerRunner(["linux", "large"]);
    await pushAndRun("a", { ".upbeater/ci.yml": `on: push\njobs:\n  ios:\n    runs-on: macos\n    steps: [{run: x}]\n  big:\n    runs-on: [linux, large]\n    steps: [{run: x}]\n` });
    expect((await claim(mac)).body.job.job_key).toBe("ios");
    expect((await claim(mac)).status).toBe(204);
    expect((await claim(linux)).body.job.job_key).toBe("big");
  });

  it("受け取った Runner 以外・古い実行からの報告は受け付けない（二重実行の防止）", async () => {
    await registerRepo();
    const t = await registerRunner(["linux"]);
    const other = await registerRunner(["linux"], "other");
    await pushAndRun("a", { ".upbeater/ci.yml": one() });
    const c = (await claim(t)).body;
    expect((await jobCall(other, c.job.id, c.job_token, "complete", { conclusion: "success" })).status).toBe(409);
    expect((await jobCall(t, c.job.id, "upb_j_wrong", "complete", { conclusion: "success" })).status).toBe(409);
    expect((await finish(t, c)).status).toBe(200);
  });
});

describe("心拍の途絶と時間超過", () => {
  it("心拍が途絶えたら失敗として扱って再実行し、古い実行の報告は拒否する", async () => {
    await registerRepo();
    const t = await registerRunner(["linux"]);
    await pushAndRun("a", { ".upbeater/ci.yml": one() });
    const first = (await claim(t)).body;
    expect(first.job.attempt).toBe(1);
    // Runner が落ちた：心拍が 2 分以上来ない
    expect(await sweepJobs(env, Date.now() + 3 * 60_000)).toEqual({ lost: 1, timedOut: 0 });
    expect((await jobsOf())[0]).toMatchObject({ status: "queued" });
    const second = (await claim(t)).body;
    expect(second.job.attempt).toBe(2);
    // 落ちたはずの古い実行が戻ってきても、報告は受け付けない
    expect((await jobCall(t, first.job.id, first.job_token, "heartbeat")).status).toBe(409);
    expect((await jobCall(t, first.job.id, first.job_token, "complete", { conclusion: "success" })).status).toBe(409);
    expect((await finish(t, second)).status).toBe(200);
    expect((await jobsOf())[0].status).toBe("succeeded");
  });

  it("再実行しない設定（rerun: false）のジョブ・上限に達したジョブは失敗にする", async () => {
    await registerRepo();
    const t = await registerRunner(["linux"]);
    await pushAndRun("a", { ".upbeater/ci.yml": one("    rerun: false\n") });
    await claim(t);
    await sweepJobs(env, Date.now() + 3 * 60_000);
    expect((await jobsOf())[0]).toMatchObject({ status: "failed", reason: expect.stringContaining("再実行しない設定") });

    await pushAndRun("b", { ".upbeater/ci.yml": one() });
    let now = Date.now();
    for (let i = 0; i < MAX_ATTEMPTS; i++) {
      await claim(t);
      now += 3 * 60_000;
      await sweepJobs(env, now);
    }
    expect((await jobsOf())[1]).toMatchObject({ status: "failed", attempt: MAX_ATTEMPTS });
  });

  it("時間超過は打ち切り、Runner に中断を指示する（子プロセスまで止めさせる）", async () => {
    await registerRepo();
    const t = await registerRunner(["linux"]);
    await pushAndRun("a", { ".upbeater/ci.yml": one("    timeout: 5\n") });
    const c = (await claim(t)).body;
    expect(c.job.timeout_minutes).toBe(5);
    await jobCall(t, c.job.id, c.job_token, "heartbeat");
    // 心拍は続いているが、5 分＋猶予を超えた
    await env.DB.prepare("UPDATE jobs SET heartbeat_at = ?").bind(Date.now() + 7 * 60_000).run();
    expect(await sweepJobs(env, Date.now() + 7 * 60_000)).toEqual({ lost: 0, timedOut: 1 });
    expect((await jobsOf())[0]).toMatchObject({ status: "failed", reason: "時間超過（5 分）" });
    const hb = await jobCall(t, c.job.id, c.job_token, "heartbeat");
    expect(hb.body).toMatchObject({ continue: false, status: "failed" });
  });

  it("Runner が停止中でもジョブは待ち行列に残り、一定時間を超えたら一度だけ通知する", async () => {
    await registerRepo();
    await pushAndRun("a", { ".upbeater/ci.yml": `on: push\njobs:\n  ios:\n    runs-on: macos\n    steps: [{run: x}]\n` });
    expect(await noticeWaitingJobs(env, Date.now() + 31 * 60_000)).toBe(1);
    expect(await noticeWaitingJobs(env, Date.now() + 62 * 60_000)).toBe(0);
    const op = await env.DB.prepare("SELECT reason, needs_human FROM operations WHERE stage = 'no_runner'").first();
    expect(op).toMatchObject({ needs_human: 1, reason: expect.stringContaining("macos") });
    const mac = await registerRunner(["macos"]);
    expect((await claim(mac)).status).toBe(200); // 復帰したら受け取れる
  });
});
