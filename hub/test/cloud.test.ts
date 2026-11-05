import { env, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { CLOUD_REDISPATCH_MS, CLOUD_RUNNER_DELAY_MS, clearCloudTokenCache, dispatchCloudRunners } from "../src/cloud";
import { claim, finish, jobsOf, mock, ORIGIN, pushAndRun, registerRepo, registerRunner } from "./helpers";

const HUB = "https://hub.test";
const wf = `on: push\njobs:\n  test:\n    runs-on: linux\n    steps: [{ run: make }]\n  ios:\n    runs-on: macos\n    steps: [{ run: make }]\n`;
const later = () => Date.now() + CLOUD_RUNNER_DELAY_MS + 1000;

async function setup() {
  clearCloudTokenCache();
  await registerRepo();
  await pushAndRun("a", { ".upbeater/ci.yml": wf });
}

/** クラウド Runner が受け取った時の環境変数 */
const envOf = (run: any) => Object.fromEntries(run.body.overrides.containerOverrides[0].env.map((e: any) => [e.name, e.value]));

describe("クラウド Runner（Runner が停止中の Linux のジョブ）", () => {
  it("待っている Linux のジョブだけにクラウド Runner を起動し、そのジョブだけを受け取らせる", async () => {
    await setup();
    expect(await dispatchCloudRunners(env, HUB)).toBe(0); // まだ待ち時間に達していない
    expect(await dispatchCloudRunners(env, HUB, later())).toBe(1);
    expect(await dispatchCloudRunners(env, HUB, later())).toBe(0); // 二重に起動しない
    const runs = await mock("gcp-runs");
    expect(runs).toHaveLength(1);
    expect(runs[0].path).toBe("/v2/projects/test-project/locations/asia-northeast1/jobs/upbeater-runner:run");
    expect(runs[0].auth).toBe("Bearer ya29.test");
    const e = envOf(runs[0]);
    expect(e.UPBEATER_HUB_URL).toBe(HUB);
    // Hub にはトークンのハッシュだけ
    expect(JSON.stringify((await env.DB.prepare("SELECT * FROM runners").all()).results)).not.toContain(e.UPBEATER_RUNNER_TOKEN);

    // 使い捨ての Runner は、起動のもとになったジョブだけを受け取れる
    const c = await claim(e.UPBEATER_RUNNER_TOKEN, ["linux", "macos"]);
    expect(c.body.job.job_key).toBe("test");
    expect((await claim(e.UPBEATER_RUNNER_TOKEN, ["linux", "macos"])).status).toBe(204);
    expect((await finish(e.UPBEATER_RUNNER_TOKEN, c.body)).status).toBe(200);
  });

  it("手元の Runner が動いていればクラウドは起動しない", async () => {
    await setup();
    await registerRunner(["linux"]);
    expect(await dispatchCloudRunners(env, HUB, later())).toBe(0);
  });

  it("起動に失敗したら次の回にもう一度試し、受け取られないまま時間が経てば起動し直す", async () => {
    await setup();
    await mock("gcp-fail", { count: 1 });
    expect(await dispatchCloudRunners(env, HUB, later())).toBe(0);
    const ops = (await env.DB.prepare("SELECT stage, status FROM operations WHERE stage = 'cloud_dispatch'").all()).results;
    expect(ops).toEqual([{ stage: "cloud_dispatch", status: "retry" }]);
    expect(await dispatchCloudRunners(env, HUB, later())).toBe(1);
    expect(await dispatchCloudRunners(env, HUB, later() + CLOUD_REDISPATCH_MS + 1000)).toBe(1);
  });

  it("使い捨ての Runner は期限を過ぎると使えない", async () => {
    await setup();
    await dispatchCloudRunners(env, HUB, later());
    const e = envOf((await mock("gcp-runs"))[0]);
    await env.DB.prepare("UPDATE runners SET expires_at = ? WHERE ephemeral = 1").bind(Date.now() - 1).run();
    expect((await claim(e.UPBEATER_RUNNER_TOKEN)).status).toBe(401);
    expect((await jobsOf()).find((j: any) => j.job_key === "test").status).toBe("queued");
    void SELF;
    void ORIGIN;
  });
});
