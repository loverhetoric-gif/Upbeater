import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { commit, mock, pullRequest, push, registerRepo, REPO, runs, sha, webhook } from "./helpers";

const CI = `on:
  push: { branches: [main] }
  pull_request: {}
  delete: {}
jobs:
  test:
    runs-on: linux
    steps: [{ run: npm test }]
`;

describe("合図の受信（Webhook）", () => {
  it("署名不一致は 401 で拒否し、何も記録しない", async () => {
    await registerRepo();
    const s = await commit("a", { ".upbeater/ci.yml": CI });
    expect((await webhook("push", push(s), { secret: "wrong" })).status).toBe(401);
    expect((await webhook("push", push(s), { signature: null })).status).toBe(401);
    expect((await webhook("push", push(s), { signature: "sha256=" + "0".repeat(64) })).status).toBe(401);
    expect((await webhook("push", push(s), { signature: "sha256=abc" })).status).toBe(401);
    const n = await env.DB.prepare("SELECT COUNT(*) AS n FROM webhook_deliveries").first<{ n: number }>();
    expect(n?.n).toBe(0);
    expect(await runs()).toHaveLength(0);
  });

  it("同じ配信 ID の重複は捨てる", async () => {
    await registerRepo();
    const s = await commit("a", { ".upbeater/ci.yml": CI });
    expect((await webhook("push", push(s), { delivery: "dup" })).status).toBe(202);
    const second = await webhook("push", push(s), { delivery: "dup" });
    expect(await second.json()).toMatchObject({ duplicate: true });
    expect(await runs()).toHaveLength(1);
  });

  it("Upbeater 自身のコミットは、既定では合図にしない（設定で変えられる）", async () => {
    await registerRepo();
    const s = await commit("a", { ".upbeater/ci.yml": CI });
    const r = await webhook("push", push(s, { sender: env.UPBEATER_BOT_LOGIN! }));
    expect(Object.values(((await r.json()) as any).outcomes)).toEqual(["skipped"]);
    expect(await runs()).toHaveLength(0);
    const ops = await env.DB.prepare("SELECT stage FROM operations WHERE stage = 'own_commit'").all();
    expect(ops.results).toHaveLength(1);

    await env.DB.prepare("UPDATE repos SET trigger_on_own_commits = 1").run();
    await webhook("push", push(s, { sender: env.UPBEATER_BOT_LOGIN! }));
    expect(await runs()).toHaveLength(1);
  });

  it("push・pull_request・delete を受け、登録していないリポジトリは無視する", async () => {
    await registerRepo();
    const s = await commit("a", { ".upbeater/ci.yml": CI });
    await webhook("push", push(s));
    await commit("pr", { ".upbeater/ci.yml": CI }, { branch: null });
    await webhook("pull_request", pullRequest(sha("pr")));
    await webhook("delete", { ref: "feature", ref_type: "branch", repository: { full_name: REPO }, sender: { login: "alice" } });
    expect((await runs()).map((r) => r.event)).toEqual(["push", "pull_request", "delete"]);
    const other = await webhook("push", push(s, { repo: "someone/else" }));
    expect(await other.json()).toMatchObject({ ignored: "not_registered" });
    const ping = await webhook("ping", { zen: "x" });
    expect(ping.status).toBe(200);
  });

  it("到着順を信用しない：新しいコミットを処理済みなら、遅れて届いた古い合図は実行しない", async () => {
    await registerRepo();
    const a = await commit("a", { ".upbeater/ci.yml": CI }, { branch: null });
    const b = await commit("b", { ".upbeater/ci.yml": CI }); // main の先頭は b
    await webhook("push", push(b));
    const late = await webhook("push", push(a));
    expect(Object.values(((await late.json()) as any).outcomes)).toEqual(["skipped"]);
    expect((await runs()).map((r) => r.sha)).toEqual([b]);
  });

  it("強制プッシュで過去のコミットに戻っても、新しい通番の実行になる", async () => {
    await registerRepo();
    const a = await commit("a", { ".upbeater/ci.yml": CI });
    await webhook("push", push(a));
    const b = await commit("b", { ".upbeater/ci.yml": CI });
    await webhook("push", push(b));
    await mock("branch", { repo: REPO, branch: "main", sha: a }); // 強制プッシュで a に戻す
    await webhook("push", push(a));
    expect((await runs()).map((r) => [r.number, r.sha])).toEqual([
      [1, a],
      [2, b],
      [3, a],
    ]);
  });

  it("フォークからの PR は印を付けて受ける（秘密情報を渡さないため）", async () => {
    await registerRepo();
    await commit("pr", { ".upbeater/ci.yml": CI }, { branch: null });
    await webhook("pull_request", pullRequest(sha("pr"), { fork: true }));
    expect((await runs())[0]).toMatchObject({ event: "pull_request", is_fork: 1 });
    void mock;
  });
});
