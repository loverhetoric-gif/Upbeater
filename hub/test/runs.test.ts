import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { admin, claim, commit, finish, jobsOf, mock, push, pushAndRun, registerRepo, registerRunner, runs, statusMap, webhook } from "./helpers";

const PIPE = `name: 公開
on:
  push: { branches: [main] }
  manual: {}
jobs:
  test:
    runs-on: linux
    matrix:
      node: [20, 22]
    steps: [{ run: npm test }]
  build:
    needs: test
    runs-on: linux
    steps: [{ run: npm run build }]
  deploy:
    needs: [build]
    if: event == 'push'
    runs-on: linux
    steps: [{ run: deploy }]
  notify:
    needs: deploy
    if: failure()
    runs-on: linux
    steps: [{ run: notify }]
`;

describe("実行の管理", () => {
  it("matrix を展開し、needs の順に待ち行列へ入れる", async () => {
    await registerRepo();
    const t = await registerRunner(["linux"]);
    await pushAndRun("a", { ".upbeater/ci.yml": PIPE });
    expect(await statusMap()).toEqual({ "test (node=20)": "queued", "test (node=22)": "queued", build: "waiting", deploy: "waiting", notify: "waiting" });

    const a = await claim(t);
    const b = await claim(t);
    expect([a.body.job.name, b.body.job.name].sort()).toEqual(["test (node=20)", "test (node=22)"]);
    expect(a.body.job.matrix).toEqual({ node: 20 });
    expect((await claim(t)).status).toBe(204); // build は test の両方が終わるまで待つ
    await finish(t, a.body);
    expect((await statusMap()).build).toBe("waiting");
    await finish(t, b.body);
    expect((await statusMap()).build).toBe("queued");
    const bc = await claim(t);
    expect(bc.status, JSON.stringify(bc.body)).toBe(200);
    await finish(t, bc.body);
    const d = (await claim(t)).body;
    expect(d.job.job_key).toBe("deploy");
    await finish(t, d);
    // 失敗していないので failure() の notify は飛ばす
    expect(await statusMap()).toMatchObject({ deploy: "succeeded", notify: "skipped" });
    expect((await runs())[0]).toMatchObject({ status: "completed", conclusion: "success", workflow_name: "公開" });
  });

  it("失敗したら後続は飛ばし、failure() のジョブだけ動かす（依存元の失敗も含む）。失敗したジョブは再実行できる", async () => {
    await registerRepo();
    const t = await registerRunner(["linux"]);
    await pushAndRun("a", { ".upbeater/ci.yml": PIPE });
    await finish(t, (await claim(t)).body);
    await finish(t, (await claim(t)).body);
    await finish(t, (await claim(t)).body, "failure"); // build が失敗
    expect(await statusMap()).toMatchObject({ build: "failed", deploy: "skipped", notify: "queued" });
    await finish(t, (await claim(t)).body);
    expect((await runs())[0]).toMatchObject({ conclusion: "failure" });

    const run = (await runs())[0];
    const r = await admin("POST", `/v1/admin/runs/${run.id}/rerun`);
    expect(await r.json()).toMatchObject({ jobs: 2 });
    expect(await statusMap()).toMatchObject({ "test (node=20)": "succeeded", build: "queued", deploy: "waiting" });
  });

  it("concurrency：同じ group の古いジョブを取り消し、同時に動くのは 1 つ", async () => {
    await registerRepo();
    const t = await registerRunner(["linux"]);
    const def = `on: { push: { branches: [main] } }\njobs:\n  deploy:\n    runs-on: linux\n    concurrency: production\n    steps: [{ run: deploy }]\n`;
    await pushAndRun("a", { ".upbeater/ci.yml": def });
    const running = (await claim(t)).body; // a の deploy が実行中
    await pushAndRun("b", { ".upbeater/ci.yml": def });
    await pushAndRun("c", { ".upbeater/ci.yml": def });
    const [ra, rb, rc] = await runs();
    // b は c に置き換わって取り消し。c は a の終了を待つ（公開系の直列化）
    expect((await jobsOf(rb.id))[0]).toMatchObject({ status: "cancelled", reason: "新しい更新に置き換わりました" });
    expect((await jobsOf(rc.id))[0]).toMatchObject({ status: "blocked" });
    // 実行中の a には中断を指示する
    const hb = await (await import("./helpers")).jobCall(t, running.job.id, running.job_token, "heartbeat");
    expect(hb.body).toMatchObject({ continue: false, cancel: true });
    expect((await claim(t)).status).toBe(204);
    await finish(t, running, "cancelled");
    expect((await jobsOf(ra.id))[0].status).toBe("cancelled");
    expect((await jobsOf(rc.id))[0].status).toBe("queued");
    expect((await claim(t)).body.job.run_number).toBe(rc.number);
  });

  it("concurrency（cancel-in-progress: false）は取り消さずに順番に実行する", async () => {
    await registerRepo();
    const t = await registerRunner(["linux"]);
    const def = `on: { push: { branches: [main] } }\njobs:\n  publish:\n    runs-on: linux\n    concurrency: { group: release, cancel-in-progress: false }\n    steps: [{ run: publish }]\n`;
    await pushAndRun("a", { ".upbeater/ci.yml": def });
    const first = (await claim(t)).body;
    await pushAndRun("b", { ".upbeater/ci.yml": def });
    await pushAndRun("c", { ".upbeater/ci.yml": def });
    const st = async () => (await jobsOf()).map((j) => j.status);
    expect(await st()).toEqual(["claimed", "blocked", "blocked"]);
    await finish(t, first);
    expect(await st()).toEqual(["succeeded", "queued", "blocked"]);
    await finish(t, (await claim(t)).body);
    expect(await st()).toEqual(["succeeded", "succeeded", "queued"]);
  });

  it("定義ファイルの誤りは実行せず、ファイル名と行番号つきで記録し、GitHub にも失敗として表示する", async () => {
    await registerRepo();
    const bad = "on: push\njobs:\n  test:\n    steps:\n      - run: make\n";
    const { body } = await pushAndRun("a", { ".upbeater/ci.yml": bad, ".upbeater/ok.yml": "on: push\njobs:\n  a: {runs-on: linux, steps: [{run: x}]}\n" });
    expect(Object.values(body.outcomes)).toEqual(["created"]);
    const [r1, r2] = await runs();
    expect(r1).toMatchObject({ workflow_file: ".upbeater/ci.yml", status: "completed", conclusion: "definition_error" });
    expect(JSON.parse(r1.problems)[0]).toMatchObject({ file: ".upbeater/ci.yml", line: 3, message: expect.stringContaining("runs-on") });
    expect(r2.status).toBe("queued"); // 正しい定義ファイルは実行する
    const checks = await mock("checks");
    const fail = checks.find((c: any) => c.created.name === "Upbeater / .upbeater/ci.yml");
    expect(fail.created).toMatchObject({ conclusion: "failure", output: { title: "定義ファイルの誤り" } });
    expect(fail.created.output.annotations[0]).toMatchObject({ path: ".upbeater/ci.yml", start_line: 3, annotation_level: "failure" });
    const res = await admin("GET", `/v1/admin/runs/${r1.id}`);
    expect(((await res.json()) as any).run.problems[0].line).toBe(3);
  });

  it("手動実行：on.manual がある定義ファイルを既定ブランチで実行する", async () => {
    await registerRepo();
    await commit("a", { ".upbeater/ci.yml": PIPE });
    const r = await admin("POST", "/v1/admin/runs", { owner_id: "owner1", repo: "acme/widget", workflow: ".upbeater/ci.yml", inputs: { env: "prod" } });
    expect(r.status).toBe(201);
    expect((await runs())[0]).toMatchObject({ event: "manual", inputs: JSON.stringify({ env: "prod" }) });
    // deploy は if: event == 'push' なので手動では飛ばされる
    void webhook;
    void push;
    void env;
  });
});
