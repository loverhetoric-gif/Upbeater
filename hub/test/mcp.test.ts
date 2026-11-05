import { env, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { claim, finish, ORIGIN, registerRunner, webhook } from "./helpers";
import { connect, connectWithRepo, mockCall, rpc, tool } from "./mcp-helpers";

const REPO = "acme/widget";
const CI = "on:\n  push: {}\n  manual: {}\njobs:\n  test:\n    runs-on: linux\n    steps:\n      - run: echo ok\n";

describe("MCP サーバー", () => {
  it("プロトコルの版の交渉・道具の一覧・誤りの扱い", async () => {
    const { access } = await connect();
    expect((await rpc(access, "initialize", { protocolVersion: "2025-03-26" })).body.result.protocolVersion).toBe("2025-03-26");
    const names = (await rpc(access, "tools/list")).body.result.tools.map((t: any) => t.name);
    for (const n of ["run_workflow", "rerun", "cancel", "pause", "list_runs", "get_run", "get_logs", "list_runners", "migrate_workflows", "list_secrets", "request_secrets", "create_branch", "commit_files", "open_pr", "merge_pr"]) expect(names).toContain(n);
    expect((await rpc(access, "nope")).body.error.code).toBe(-32601);
    expect((await rpc(access, "tools/call", { name: "get_run", arguments: {} })).body.error.code).toBe(-32602);
    expect((await rpc(access, "ping", undefined, { origin: "https://evil.example" })).status).toBe(403);
  });

  it("手動実行 → 一覧 → 詳細 → ログ → 再実行、利用者ごとに分離される", async () => {
    const me = await connectWithRepo(REPO);
    const other = await connect({ login: "renamed", id: 424242 });
    await mockCall("seed", { repo: REPO, branch: "main", files: { ".upbeater/ci.yml": CI } });
    // Runner は同じ利用者（gh:1001）に登録する
    const { code } = (await (await SELF.fetch(`${ORIGIN}/v1/admin/runner-codes`, { method: "POST", headers: { authorization: "Bearer test-admin-token", "content-type": "application/json" }, body: JSON.stringify({ owner_id: me.owner }) })).json()) as any;
    const reg = (await (await SELF.fetch(`${ORIGIN}/v1/runners/register`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ code, name: "mac", labels: ["linux"] }) })).json()) as any;

    const r = await tool(me.access, "run_workflow", { repo: REPO, workflow: ".upbeater/ci.yml" });
    expect(r.ok).toBe(true);
    const runId = r.runs[0].id ?? r.runs[0].run_id;
    expect((await tool(me.access, "list_runs", { repo: REPO })).runs).toHaveLength(1);
    expect((await tool(other.access, "list_runs")).runs).toHaveLength(0);
    expect(await tool(other.access, "get_run", { run_id: runId })).toMatchObject({ ok: false, code: "run_not_found" });

    const c = await claim(reg.token);
    expect(c.status).toBe(200);
    expect((await tool(me.access, "list_runners")).runners[0]).toMatchObject({ name: "mac", online: true });
    await finish(reg.token, c.body, "failure");
    const run = await tool(me.access, "get_run", { run_id: runId });
    expect(run.run.conclusion).toBe("failure");
    const logs = await tool(me.access, "get_logs", { job_id: run.jobs[0].job_id });
    expect(logs.ok).toBe(true);
    expect(await tool(me.access, "rerun", { run_id: runId })).toMatchObject({ ok: true, jobs: 1 });
    expect(await tool(me.access, "cancel", { run_id: runId })).toMatchObject({ ok: true });
  });

  it("一時停止中は push で実行せず、手動実行はできる", async () => {
    const me = await connectWithRepo(REPO);
    await tool(me.access, "pause", { repo: REPO });
    const { sha } = await mockCall("seed", { repo: REPO, branch: "main", files: { ".upbeater/ci.yml": CI } });
    const w = await webhook("push", { ref: "refs/heads/main", after: sha, repository: { full_name: REPO }, sender: { login: "alice" }, commits: [] });
    expect(Object.values(((await w.json()) as any).outcomes)).toEqual(["skipped"]);
    expect((await tool(me.access, "run_workflow", { repo: REPO, workflow: ".upbeater/ci.yml" })).ok).toBe(true);
    expect((await tool(me.access, "list_repos")).repos[0].paused).toBe(true);
    await tool(me.access, "pause", { repo: REPO, paused: false });
    expect((await tool(me.access, "list_repos")).repos[0].paused).toBe(false);
  });

  it("MCP で依頼した変更は Upbeater のコミットでも合図にし、それ以外の自分のコミットは照合でも拾わない", async () => {
    const me = await connectWithRepo(REPO);
    await mockCall("seed", { repo: REPO, branch: "main", files: { ".upbeater/ci.yml": CI } });
    const s = await tool(me.access, "ship_change", { repo: REPO, branch: "feat/x", title: "変更", files: [{ path: "a.txt", content: "1" }] });
    const bot = { login: "upbeater-loverhetoric[bot]" };
    const w1 = await webhook("push", { ref: "refs/heads/main", after: s.result.merge_commit_sha, repository: { full_name: REPO }, sender: bot, pusher: { name: bot.login }, commits: [] });
    expect(Object.values(((await w1.json()) as any).outcomes)).toEqual(["created"]);
    // 依頼していない自分のコミット（ジョブからの push など）
    const own = await mockCall("seed", { repo: REPO, branch: "main", files: { "b.txt": "2" } });
    const w2 = await webhook("push", { ref: "refs/heads/main", after: own.sha, repository: { full_name: REPO }, sender: bot, pusher: { name: bot.login }, commits: [] });
    expect(Object.values(((await w2.json()) as any).outcomes)).toEqual(["skipped"]);
    const repo = await env.DB.prepare("SELECT last_seen_sha FROM repos WHERE full_name = ?").bind(REPO).first<any>();
    expect(repo.last_seen_sha).toBe(own.sha);
  });

  it("Actions の定義を変換して PR にする", async () => {
    const me = await connectWithRepo(REPO);
    await mockCall("seed", {
      repo: REPO,
      branch: "main",
      files: { ".github/workflows/ci.yml": "on: [push]\njobs:\n  t:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: actions/checkout@v4\n      - run: npm test\n" },
    });
    const check = await tool(me.access, "migrate_workflows", { repo: REPO, check: true });
    expect(check).toMatchObject({ ok: true, check: true, files: [{ file: ".upbeater/ci.yml", errors: 0 }] });
    const r = await tool(me.access, "migrate_workflows", { repo: REPO });
    expect(r).toMatchObject({ ok: true, result: { pr_number: 1 } });
    expect(r.result.merged).toBeUndefined();
    expect((await mockCall("tree", { repo: REPO, branch: "upbeater-migration" })).files[".upbeater/ci.yml"]).toContain("runs-on: linux");
  });

  it("秘密情報は名前だけを返し、入力ページの URL を発行する", async () => {
    const me = await connectWithRepo(REPO);
    const f = await tool(me.access, "request_secrets", { repo: REPO, names: ["API_TOKEN"] });
    expect(f.url).toMatch(/^https:\/\/hub\.test\/secret-form\//);
    expect((await tool(me.access, "list_secrets")).secrets).toEqual([]);
    expect(await tool(me.access, "request_secrets", { names: ["bad-name"] })).toMatchObject({ ok: false, code: "invalid_input" });
  });
});

describe("直接登録する接続用トークン", () => {
  it("管理 API で発行したトークンで MCP を使え、発行し直すと前のものは使えない", async () => {
    const issue = async () =>
      ((await (await SELF.fetch(`${ORIGIN}/v1/admin/mcp-tokens`, { method: "POST", headers: { authorization: "Bearer test-admin-token", "content-type": "application/json" }, body: JSON.stringify({ owner_id: "gh:1001" }) })).json()) as any).token as string;
    const t1 = await issue();
    expect(t1).toMatch(/^upb_m_/);
    expect((await rpc(t1, "tools/list")).body.result.tools.length).toBeGreaterThan(10);
    expect(JSON.stringify((await env.DB.prepare("SELECT * FROM mcp_tokens").all()).results)).not.toContain(t1);
    const t2 = await issue();
    expect((await rpc(t1, "ping")).status).toBe(401);
    expect((await rpc(t2, "ping")).status).toBe(200);
  });
});
