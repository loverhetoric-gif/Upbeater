import { env, runDurableObjectAlarm } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { CHECK_MAX_ATTEMPTS, flushChecks } from "../src/checks";
import { reconcile, runSchedules } from "../src/scheduled";
import { claim, commit, coordinatorStorage, coordinatorStub, finish, mock, push, pushAndRun, registerRepo, registerRunner, runs, scheduledHandler, webhook } from "./helpers";

const ONE = `on: { push: { branches: [main] } }\njobs:\n  build:\n    runs-on: linux\n    steps: [{ run: make }]\n`;

describe("GitHub への結果表示", () => {
  it("ジョブの状態をコミットの Checks に表示する（待ち → 実行中 → 完了）", async () => {
    await registerRepo();
    const t = await registerRunner(["linux"]);
    const { sha } = await pushAndRun("a", { ".upbeater/ci.yml": ONE });
    await finish(t, (await claim(t)).body);
    const [c] = await mock("checks");
    expect(c.created).toMatchObject({ name: ".upbeater/ci.yml / build", head_sha: sha, status: "queued" });
    expect(c.updates.map((u: any) => u.status)).toEqual(["in_progress", "completed"].slice(-c.updates.length));
    expect(c.updates.at(-1)).toMatchObject({ status: "completed", conclusion: "success" });
  });

  it("Checks の権限が無い（403）時は、コミットの状態で代わりに表示し、人の判断が要るものとして 1 度だけ記録する", async () => {
    await registerRepo();
    const t = await registerRunner(["linux"]);
    await mock("fail", { count: 100, status: 403, path: "/check-runs" });
    const { sha } = await pushAndRun("a", { ".upbeater/ci.yml": ONE });
    await finish(t, (await claim(t)).body);
    await flushChecks(env, { now: Date.now() + 60 * 60_000 });
    const st = await mock("statuses");
    expect(st.length).toBeGreaterThan(0);
    expect(st.at(-1)).toMatchObject({ sha, context: "Upbeater / .upbeater/ci.yml / build", state: "success" });
    expect(st[0].state).toBe("pending");
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM check_updates").first<{ n: number }>()).toMatchObject({ n: 0 });
    const ops = await env.DB.prepare("SELECT status, needs_human FROM operations WHERE kind = 'checks'").all<{ status: string; needs_human: number }>();
    expect(ops.results).toEqual([{ status: "ok", needs_human: 1 }]);
  });

  it("表示に失敗しても実行は止めず、間隔を広げて再試行し、最新の状態だけを送る", async () => {
    await registerRepo();
    const t = await registerRunner(["linux"]);
    await mock("fail", { count: 50, status: 503, path: "/check-runs" });
    await pushAndRun("a", { ".upbeater/ci.yml": ONE });
    const c = (await claim(t)).body;
    expect(c.job.job_key).toBe("build"); // 表示できなくても実行は進む
    await finish(t, c);
    expect((await runs())[0]).toMatchObject({ conclusion: "success" });
    const pending = await env.DB.prepare("SELECT attempts, next_at FROM check_updates").all<{ attempts: number; next_at: number }>();
    expect(pending.results).toHaveLength(1); // 古い表示は最新のもので置き換わっている
    expect(pending.results[0]!.next_at).toBeGreaterThan(Date.now());
    // GitHub が回復
    await env.GITHUB_API!.fetch("https://github-mock.test/__mock/reset", { method: "POST" });
    await env.GITHUB_API!.fetch("https://github-mock.test/__mock/app", { method: "POST", body: JSON.stringify({ app_id: env.GITHUB_APP_ID, public_jwk: JSON.parse(env.TEST_APP_PUBLIC_JWK) }) });
    expect(await flushChecks(env, { now: Date.now() + 60 * 60_000 })).toMatchObject({ sent: 1 });
    const [check] = await mock("checks");
    expect(check.created).toMatchObject({ status: "completed", conclusion: "success" });
    const retries = await env.DB.prepare("SELECT COUNT(*) AS n FROM operations WHERE kind = 'checks' AND status = 'retry'").first<{ n: number }>();
    expect(retries!.n).toBeGreaterThan(0);
  });

  it("上限まで失敗したら諦め、人の判断が要るものとして記録する", async () => {
    await registerRepo();
    await mock("fail", { count: 100, status: 502, path: "/check-runs" });
    await pushAndRun("a", { ".upbeater/ci.yml": ONE });
    let now = Date.now();
    for (let i = 0; i < CHECK_MAX_ATTEMPTS + 1; i++) {
      now += 2 * 60 * 60_000;
      await flushChecks(env, { now });
    }
    expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM check_updates").first<{ n: number }>())!.n).toBe(0);
    const op = await env.DB.prepare("SELECT needs_human FROM operations WHERE kind = 'checks' AND status = 'failed'").first();
    expect(op).toMatchObject({ needs_human: 1 });
  });
});

describe("定期実行と取りこぼし", () => {
  const NIGHTLY = `on:\n  schedule: ["0 3 * * *"]\n  push: { branches: [main] }\njobs:\n  nightly:\n    runs-on: linux\n    steps: [{ run: nightly }]\n`;

  it("schedule を評価して実行し、抜けた回は何回分抜けても一度だけ補う", async () => {
    await registerRepo();
    const t0 = Date.UTC(2026, 10, 5, 2, 0);
    await commit("a", { ".upbeater/nightly.yml": NIGHTLY });
    await webhook("push", push((await import("./helpers")).sha("a")));
    const pushRuns = (await runs()).length;
    // 書かれた時点より前の回は補わない
    const { syncWorkflows, getRepo } = await import("../src/coordinator");
    const repo = (await getRepo(env, (await env.DB.prepare("SELECT id FROM repos").first<{ id: string }>())!.id))!;
    await env.DB.prepare("DELETE FROM schedules").run();
    await syncWorkflows(env, repo, "x", [{ path: ".upbeater/nightly.yml", text: NIGHTLY }], t0);
    expect(await runSchedules(env, t0 + 30 * 60_000)).toBe(0);
    // 3:00 を過ぎた
    expect(await runSchedules(env, Date.UTC(2026, 10, 5, 3, 0, 20))).toBe(1);
    expect(await runSchedules(env, Date.UTC(2026, 10, 5, 3, 1))).toBe(0); // 同じ回は二度実行しない
    // Hub が 3 日止まっていた：抜けた 3 回分を一度だけ補う
    expect(await runSchedules(env, Date.UTC(2026, 10, 8, 5, 0))).toBe(1);
    expect(await runSchedules(env, Date.UTC(2026, 10, 8, 5, 1))).toBe(0);
    const sched = (await runs()).filter((r) => r.event === "schedule");
    expect(sched).toHaveLength(2);
    expect((await runs()).length).toBe(pushRuns + 2);
  });

  it("Hub の停止中に届かなかった Webhook は、定期照合で回復する", async () => {
    await registerRepo();
    const s = await commit("missed", { ".upbeater/ci.yml": ONE });
    // Webhook は一度も届かない
    expect(await reconcile(env)).toBe(1);
    expect((await runs())[0]).toMatchObject({ sha: s, event: "push", actor: "reconcile" });
    expect(await reconcile(env, { now: Date.now() + 11 * 60_000 })).toBe(0); // 冪等
  });

  it("定期の処理（runCron）は、既定では GitHub を読む照合をしない", async () => {
    await registerRepo();
    await commit("missed", { ".upbeater/ci.yml": ONE });
    const { runCron } = await import("../src/scheduled");
    await runCron(env);
    expect((await runs()).filter((r) => r.actor === "reconcile")).toHaveLength(0);
  });

  it("GitHub の障害で定義ファイルを取れない時は、合図を待ち行列に残して再試行する", async () => {
    const repoId = await registerRepo();
    const s = await commit("a", { ".upbeater/ci.yml": ONE });
    await mock("fail", { count: 1, status: 503, path: "/contents/" });
    const r = await webhook("push", push(s));
    expect(Object.values(((await r.json()) as any).outcomes)).toEqual(["queued_retry"]);
    expect(await runs()).toHaveLength(0);
    const st = await coordinatorStorage(repoId);
    expect(st.pending).toHaveLength(1);
    expect(st.alarm! - Date.now()).toBeGreaterThan(20_000);
    expect(await runDurableObjectAlarm(coordinatorStub(repoId))).toBe(true);
    expect(await runs()).toHaveLength(1);
  });

  it("Cron の入口は、一つの処理の失敗で他を止めない", async () => {
    await registerRepo();
    await mock("fail", { count: 5, status: 500 });
    await scheduledHandler(); // 例外を出さずに終わる
  });
});
