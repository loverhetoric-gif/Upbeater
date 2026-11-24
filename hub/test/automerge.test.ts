import { env, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { claim, finish, ORIGIN, runCronAt, webhook } from "./helpers";
import { connectWithRepo, mockCall, tool } from "./mcp-helpers";

const REPO = "acme/widget";
const OWNER = "gh:1001";
const CI = "on: pull_request\njobs:\n  t:\n    runs-on: linux\n    steps: [{ run: x }]\n";
const files = (extra = "新しい\n") => [
  { path: ".upbeater/ci.yml", content: CI },
  { path: "docs/new.md", content: extra },
];

async function admin(method: string, path: string, body: unknown) {
  return SELF.fetch(`${ORIGIN}${path}`, { method, headers: { authorization: "Bearer test-admin-token", "content-type": "application/json" }, body: JSON.stringify(body) });
}
const setAuto = (enabled: boolean, method?: string) => admin("PUT", "/v1/admin/auto-merge", { owner_id: OWNER, repo: REPO, enabled, ...(method ? { method } : {}) });

async function setup(enable = true) {
  const c = await connectWithRepo(REPO);
  if (enable) expect((await setAuto(true)).status).toBe(200);
  const { code } = (await (await admin("POST", "/v1/admin/runner-codes", { owner_id: OWNER })).json()) as { code: string };
  const r = await SELF.fetch(`${ORIGIN}/v1/runners/register`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ code, name: "r1", labels: ["linux"] }) });
  const runner = ((await r.json()) as { token: string }).token;
  return { t: c.access, runner };
}

const headOf = async (branch: string) => (await mockCall("tree", { repo: REPO, branch })).sha as string | null;
const prEvent = (action: string, n: number, sha: string, extra: Record<string, unknown> = {}) =>
  webhook("pull_request", {
    action,
    number: n,
    repository: { full_name: REPO },
    sender: { login: "alice" },
    pull_request: { number: n, head: { sha, ref: "feat/x", repo: { full_name: REPO } }, base: { ref: "main", repo: { full_name: REPO } }, ...extra },
  });
const state = async (n: number) => env.DB.prepare("SELECT * FROM auto_merges WHERE pr_number = ?").bind(n).first<any>();
const ops = async () => (await env.DB.prepare("SELECT stage, status, needs_human, reason FROM operations WHERE kind = 'auto_merge' ORDER BY id").all<any>()).results;
const mergedFiles = async () => (await mockCall("tree", { repo: REPO, branch: "main" })).files as Record<string, string>;
const prMerged = async () => (await mockCall("pulls", { repo: REPO }))[0].merged as boolean;

/** 予約つきで PR を作り、PR の合図で検査（run）を起こす */
async function reserve(t: string, extra: Record<string, unknown> = {}) {
  const r = await tool(t, "ship_change", { repo: REPO, branch: "feat/x", title: "追加", files: files(), auto_merge: true, request_id: "rq-1", ...extra });
  expect(r.ok, JSON.stringify(r)).toBe(true);
  const n = r.result.pr_number as number;
  const sha = (await headOf("feat/x"))!;
  await prEvent("opened", n, sha);
  return { n, sha, r };
}

describe("検査通過後の自動マージ", () => {
  it("持ち主が有効にしていないリポジトリでは予約を断り（何も作らない）、AI は有効にできない。無効にはできる", async () => {
    const { t } = await setup(false);
    expect(await tool(t, "ship_change", { repo: REPO, branch: "feat/x", title: "追加", files: files(), auto_merge: true })).toMatchObject({ ok: false, code: "auto_merge_disabled", needs_human: true });
    expect(await tool(t, "open_pr", { repo: REPO, head: "feat/x", title: "x", auto_merge: true })).toMatchObject({ ok: false, code: "auto_merge_disabled" });
    expect(await headOf("feat/x")).toBeNull();
    expect(await tool(t, "set_auto_merge", { repo: REPO, enabled: true })).toMatchObject({ ok: false, code: "owner_only" });
    expect((await tool(t, "list_repos")).repos[0].auto_merge).toEqual({ enabled: false, method: "squash" });
    // 管理 API（持ち主）だけが有効にできる。トークンが無ければ拒否する
    expect((await SELF.fetch(`${ORIGIN}/v1/admin/auto-merge`, { method: "PUT", body: JSON.stringify({ owner_id: OWNER, repo: REPO, enabled: true }) })).status).toBe(401);
    expect((await setAuto(true, "rebase")).status).toBe(200);
    expect((await tool(t, "list_repos")).repos[0].auto_merge).toEqual({ enabled: true, method: "rebase" });
    expect(await tool(t, "set_auto_merge", { repo: REPO, enabled: false })).toMatchObject({ ok: true, enabled: false });
    expect((await tool(t, "list_repos")).repos[0].auto_merge.enabled).toBe(false);
  });

  it("予約 → 検査の完了を待つ → 検査が成功したら Upbeater がマージする（記録と get_request で状況が分かる）", async () => {
    const { t, runner } = await setup();
    const { n, r } = await reserve(t);
    expect(r.result).toMatchObject({ merged: false, auto_merge: { reserved: true, status: "waiting" } });
    expect(await prMerged()).toBe(false);
    const c = await claim(runner);
    expect(c.status).toBe(200);
    expect((await state(n)).status).toBe("waiting"); // 検査の実行中はマージしない
    await finish(runner, c.body, "success");
    expect(await state(n)).toMatchObject({ status: "merged", code: "merged" });
    expect((await mergedFiles())["docs/new.md"]).toBe("新しい\n");
    const req = await tool(t, "get_request", { request_id: "rq-1" });
    expect(req.auto_merge).toMatchObject({ pr_number: n, status: "merged" });
    expect(req.auto_merge.history.map((h: any) => h.stage)).toEqual(expect.arrayContaining(["reserved", "waiting", "merged"]));
    expect((await ops()).map((o: any) => o.stage)).toEqual(expect.arrayContaining(["reserved", "waiting", "merged"]));
  });

  it("リポジトリの設定のマージの方法を使う", async () => {
    const { t, runner } = await setup();
    await setAuto(true, "merge");
    const { n } = await reserve(t);
    await finish(runner, (await claim(runner)).body, "success");
    expect((await state(n)).status).toBe("merged");
    expect(await prMerged()).toBe(true);
  });

  it("検査が失敗したらマージせず、理由を人の判断が要るものとして 1 度だけ記録する。新しいコミットが成功すればマージする", async () => {
    const { t, runner } = await setup();
    const { n } = await reserve(t);
    await finish(runner, (await claim(runner)).body, "failure");
    expect(await state(n)).toMatchObject({ status: "waiting", code: "checks_failed" });
    expect(await prMerged()).toBe(false);
    const failed = (await ops()).filter((o: any) => o.needs_human === 1);
    expect(failed).toHaveLength(1);
    expect(failed[0].reason).toContain("検査が失敗");
    await runCronAt(Date.now() + 2 * 60 * 60_000); // Cron で何度見ても記録は増えない
    expect((await ops()).filter((o: any) => o.needs_human === 1)).toHaveLength(1);

    // 新しいコミット：その検査を待ち直す
    await mockCall("seed", { repo: REPO, branch: "feat/x", files: { "docs/fix.md": "直した\n" } });
    const sha2 = (await headOf("feat/x"))!;
    await prEvent("synchronize", n, sha2);
    expect(await state(n)).toMatchObject({ status: "waiting", head_sha: sha2, code: "head_changed" });
    await finish(runner, (await claim(runner)).body, "success");
    expect((await state(n)).status).toBe("merged");
    expect((await mergedFiles())["docs/fix.md"]).toBe("直した\n");
  });

  it("新しいコミットが積まれたら、古いコミットの検査が成功してもマージせず、新しいコミットの検査を待つ", async () => {
    const { t, runner } = await setup();
    const { n } = await reserve(t);
    const first = (await claim(runner)).body; // 古いコミットの検査（実行中）
    await mockCall("seed", { repo: REPO, branch: "feat/x", files: { "docs/more.md": "追加\n" } });
    const sha2 = (await headOf("feat/x"))!;
    await prEvent("synchronize", n, sha2);
    const second = (await claim(runner)).body; // 新しいコミットの検査
    await finish(runner, first, "success");
    expect(await state(n)).toMatchObject({ status: "waiting", head_sha: sha2 });
    expect(await prMerged()).toBe(false);
    await finish(runner, second, "success");
    expect((await state(n)).status).toBe("merged");
    expect((await mergedFiles())["docs/more.md"]).toBe("追加\n");
  });

  it("PR が閉じられたら予約を終え、その後に検査が成功してもマージしない", async () => {
    const { t, runner } = await setup();
    const { n, sha } = await reserve(t);
    const c = (await claim(runner)).body;
    await prEvent("closed", n, sha, { merged: false });
    expect(await state(n)).toMatchObject({ status: "closed" });
    await finish(runner, c, "success");
    expect((await state(n)).status).toBe("closed");
    expect(await prMerged()).toBe(false);
  });

  it("取り消すと、検査が成功してもマージしない。存在しない予約は取り消せない", async () => {
    const { t, runner } = await setup();
    const { n } = await reserve(t);
    const c = (await claim(runner)).body;
    expect(await tool(t, "cancel_auto_merge", { repo: REPO, number: n })).toMatchObject({ ok: true, status: "cancelled" });
    expect(await tool(t, "cancel_auto_merge", { repo: REPO, number: n })).toMatchObject({ ok: true, status: "cancelled" });
    await finish(runner, c, "success");
    expect((await state(n)).status).toBe("cancelled");
    expect(await prMerged()).toBe(false);
    expect(await tool(t, "cancel_auto_merge", { repo: REPO, number: 99 })).toMatchObject({ ok: false, code: "not_found" });
  });

  it("下書きの間はマージせず、準備完了で続きをマージする", async () => {
    const { t, runner } = await setup();
    const { n, sha } = await reserve(t);
    await mockCall("draft", { repo: REPO, number: n, draft: true });
    await finish(runner, (await claim(runner)).body, "success");
    expect(await state(n)).toMatchObject({ status: "waiting", code: "draft" });
    await mockCall("draft", { repo: REPO, number: n, draft: false });
    await prEvent("ready_for_review", n, sha);
    expect((await state(n)).status).toBe("merged");
  });

  it("解消できない衝突は予約を止め、needs_human で 1 度だけ残す。PR は残る", async () => {
    const { t, runner } = await setup();
    await mockCall("seed", { repo: REPO, branch: "main", files: { "docs/new.md": "main 側\n" } });
    const { n } = await reserve(t);
    await mockCall("seed", { repo: REPO, branch: "main", files: { "docs/new.md": "さらに main 側\n" } });
    await finish(runner, (await claim(runner)).body, "success");
    expect(await state(n)).toMatchObject({ status: "stopped", code: "merge_conflict" });
    const o = (await ops()).filter((x: any) => x.stage === "stopped");
    expect(o).toHaveLength(1);
    expect(o[0].needs_human).toBe(1);
    expect((await mockCall("pulls", { repo: REPO }))[0].state).toBe("open");
  });

  it("main が進んでいたら main を取り込み、新しいコミットの検査が成功してからマージする（検査していないコミットはマージしない）", async () => {
    const { t, runner } = await setup();
    await mockCall("protect", { repo: REPO, strict: true });
    const { n, sha } = await reserve(t);
    await mockCall("seed", { repo: REPO, branch: "main", files: { "other.txt": "別の変更\n" } });
    await finish(runner, (await claim(runner)).body, "success");
    expect(await state(n)).toMatchObject({ status: "waiting", code: "base_merged" });
    const sha2 = (await headOf("feat/x"))!;
    expect(sha2).not.toBe(sha);
    expect(await prMerged()).toBe(false);
    await prEvent("synchronize", n, sha2); // 取り込みで head が変わった
    await finish(runner, (await claim(runner)).body, "success");
    expect((await state(n)).status).toBe("merged");
    expect(await mergedFiles()).toMatchObject({ "other.txt": "別の変更\n", "docs/new.md": "新しい\n" });
  });

  it("必須の検査が保留中なら間隔を広げて待ち、Cron が条件のそろった予約をマージする", async () => {
    const { t, runner } = await setup();
    await mockCall("protect", { repo: REPO, pending: ["required-x"] });
    const { n } = await reserve(t);
    await finish(runner, (await claim(runner)).body, "success");
    expect(await state(n)).toMatchObject({ status: "waiting", code: "required_checks_pending", attempts: 1 });
    await mockCall("protect", { repo: REPO });
    await runCronAt(Date.now() + 60_000); // まだ次の確認の時刻ではない
    expect((await state(n)).status).toBe("waiting");
    await runCronAt(Date.now() + 2 * 60 * 60_000);
    expect((await state(n)).status).toBe("merged");
  });

  it("予約の後に持ち主が無効にしたら、検査が成功してもマージしない。有効に戻せば続きをマージする", async () => {
    const { t, runner } = await setup();
    const { n } = await reserve(t);
    await setAuto(false);
    await finish(runner, (await claim(runner)).body, "success");
    expect(await state(n)).toMatchObject({ status: "waiting", code: "disabled" });
    expect(await prMerged()).toBe(false);
    await setAuto(true);
    await runCronAt(Date.now() + 2 * 60 * 60_000);
    expect((await state(n)).status).toBe("merged");
  });

  it("open_pr でも予約でき、同じ依頼 ID の再実行で重複しない。予約なしの open_pr・merge_pr は従来どおり", async () => {
    const { t, runner } = await setup();
    await tool(t, "create_branch", { repo: REPO, branch: "feat/x" });
    await tool(t, "commit_files", { repo: REPO, branch: "feat/x", message: "追加", files: files() });
    const a = await tool(t, "open_pr", { repo: REPO, head: "feat/x", title: "追加", auto_merge: true, request_id: "rq-2" });
    expect(a).toMatchObject({ ok: true, result: { auto_merge: { reserved: true } } });
    expect(await tool(t, "open_pr", { repo: REPO, head: "feat/x", title: "追加", auto_merge: true, request_id: "rq-2" })).toMatchObject({ ok: true, duplicate: true });
    const n = a.result.number as number;
    await prEvent("opened", n, (await headOf("feat/x"))!);
    await finish(runner, (await claim(runner)).body, "success");
    expect((await state(n)).status).toBe("merged");
    // 予約なしの PR は、従来どおり merge_pr で（予約は作られない）
    await tool(t, "create_branch", { repo: REPO, branch: "plain" });
    await tool(t, "commit_files", { repo: REPO, branch: "plain", message: "x", files: [{ path: "p.md", content: "p\n" }] });
    const p = await tool(t, "open_pr", { repo: REPO, head: "plain", title: "plain" });
    expect(await state(p.result.number)).toBeNull();
    expect(await tool(t, "merge_pr", { repo: REPO, number: p.result.number })).toMatchObject({ ok: true, result: { merged: true } });
    expect(await tool(t, "ship_change", { repo: REPO, branch: "feat/y", title: "y", files: [{ path: "y.md", content: "y\n" }], auto_merge: true, merge: true })).toMatchObject({ ok: false, code: "invalid_input" });
  });
});
