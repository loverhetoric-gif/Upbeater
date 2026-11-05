import { describe, expect, it } from "vitest";
import { connect, mockCall, tool } from "./mcp-helpers";

const REPO = "acme/widget";

async function setup() {
  const c = await connect();
  await mockCall("seed", { repo: REPO, branch: "main", files: { "README.md": "初版\n", "src/a.ts": "a" }, default: true });
  const reg = await tool(c.access, "register_app", { name: "Widget", repo: REPO, kind: "direct", target_os: ["linux"] });
  expect(reg.ok).toBe(true);
  return c.access;
}

const tree = (branch: string) => mockCall("tree", { repo: REPO, branch });
const files = [{ path: "docs/new.md", content: "新しい文書\n" }];

describe("GitHub 操作（MCP 経由）", () => {
  it("ブランチ作成 → コミット → PR → マージを一続きで行う", async () => {
    const t = await setup();
    const r = await tool(t, "ship_change", { repo: REPO, branch: "feat/doc", title: "文書を追加", files: [...files, { path: "src/a.ts", delete: true }] });
    expect(r).toMatchObject({ ok: true, result: { merged: true, pr_number: 1 } });
    const main = await tree("main");
    expect(main.files).toEqual({ "README.md": "初版\n", "docs/new.md": "新しい文書\n" });
    expect(main.sha).toBe(r.result.merge_commit_sha);
  });

  it("個別の道具でも同じ流れを実行でき、既にあるブランチ・PR はそのまま使う", async () => {
    const t = await setup();
    expect(await tool(t, "create_branch", { repo: REPO, branch: "work" })).toMatchObject({ ok: true, result: { created: true } });
    expect(await tool(t, "create_branch", { repo: REPO, branch: "work", request_id: "again" })).toMatchObject({ ok: true, result: { created: false } });
    expect((await tool(t, "commit_files", { repo: REPO, branch: "work", message: "追加", files })).ok).toBe(true);
    const pr = await tool(t, "open_pr", { repo: REPO, head: "work", title: "追加" });
    const pr2 = await tool(t, "open_pr", { repo: REPO, head: "work", title: "追加（再）" });
    expect(pr2.result.number).toBe(pr.result.number);
    expect(await tool(t, "merge_pr", { repo: REPO, number: pr.result.number })).toMatchObject({ ok: true, result: { merged: true } });
  });

  it("main への直接書き込み・許可リスト外のリポジトリ・不正なパスは拒否する", async () => {
    const t = await setup();
    expect(await tool(t, "commit_files", { repo: REPO, branch: "main", message: "直接", files })).toMatchObject({ ok: false, code: "direct_write_forbidden" });
    expect(await tool(t, "ship_change", { repo: REPO, branch: "main", title: "x", files })).toMatchObject({ ok: false, code: "direct_write_forbidden" });
    expect(await tool(t, "ship_change", { repo: "other/repo", branch: "x", title: "x", files })).toMatchObject({ ok: false, code: "repo_not_allowed" });
    expect(await tool(t, "commit_files", { repo: REPO, branch: "w", message: "m", files: [{ path: "../etc", content: "x" }] })).toMatchObject({
      ok: false,
      code: "invalid_input",
    });
    expect((await tree("main")).files["docs/new.md"]).toBeUndefined();
  });

  it("同じ依頼の重複実行は既存の結果を返し、別内容の同じ依頼 ID は拒否する", async () => {
    const t = await setup();
    const a = { repo: REPO, branch: "feat/dup", title: "重複", files, request_id: "req-1" };
    const first = await tool(t, "ship_change", a);
    const second = await tool(t, "ship_change", a);
    expect(second).toMatchObject({ ok: true, duplicate: true, result: first.result });
    expect(await mockCall("pulls", { repo: REPO })).toHaveLength(1);
    expect(await tool(t, "ship_change", { ...a, title: "別の内容" })).toMatchObject({ ok: false, code: "request_id_conflict" });
    // 依頼 ID を省いても、同じ内容なら同じ依頼とみなす
    const b = { repo: REPO, branch: "feat/auto", title: "自動", files };
    await tool(t, "ship_change", b);
    expect(await tool(t, "ship_change", b)).toMatchObject({ ok: true, duplicate: true });
  });

  it("途中の段階で失敗したら段階と理由を返し、同じ依頼 ID で失敗した段階から再開する", async () => {
    const t = await setup();
    await mockCall("fail", { count: 1, status: 503, path: "/pulls", method: "POST" });
    const a = { repo: REPO, branch: "feat/resume", title: "再開", files, request_id: "req-resume" };
    const failed = await tool(t, "ship_change", a);
    expect(failed).toMatchObject({ ok: false, stage: "open_pr", retryable: true, code: "github_unavailable" });
    const status = await tool(t, "get_request", { request_id: "req-resume" });
    expect(status).toMatchObject({ status: "failed", stage: "open_pr" });
    const commitBefore = (await tree("feat/resume")).sha;

    const resumed = await tool(t, "ship_change", a);
    expect(resumed).toMatchObject({ ok: true, resumed: true, result: { merged: true, commit_sha: commitBefore } });
    // コミットは作り直していない（同じコミットが main に入った）
    expect((await tree("main")).files["docs/new.md"]).toBe("新しい文書\n");
    expect(await mockCall("pulls", { repo: REPO })).toHaveLength(1);
  });

  it("main が先に進んでいれば取り込んでからマージする", async () => {
    const t = await setup();
    await mockCall("protect", { repo: REPO, strict: true });
    await tool(t, "ship_change", { repo: REPO, branch: "feat/behind", title: "遅れ", files, merge: false });
    await mockCall("seed", { repo: REPO, branch: "main", files: { "other.txt": "別の変更" } });
    const pr = (await mockCall("pulls", { repo: REPO }))[0];
    const m = await tool(t, "merge_pr", { repo: REPO, number: pr.number });
    expect(m).toMatchObject({ ok: true, result: { merged: true } });
    const main = await tree("main");
    expect(main.files["other.txt"]).toBe("別の変更");
    expect(main.files["docs/new.md"]).toBe("新しい文書\n");
  });

  it("解消できない衝突は PR を残し、衝突箇所を具体的に返す", async () => {
    const t = await setup();
    await tool(t, "ship_change", { repo: REPO, branch: "feat/conflict", title: "衝突", files: [{ path: "README.md", content: "こちらの変更\n" }], merge: false });
    await mockCall("seed", { repo: REPO, branch: "main", files: { "README.md": "main 側の変更\n" } });
    const pr = (await mockCall("pulls", { repo: REPO }))[0];
    const m = await tool(t, "merge_pr", { repo: REPO, number: pr.number });
    expect(m).toMatchObject({ ok: false, code: "merge_conflict", stage: "merge_pr", needs_human: true, details: { conflicting_files: ["README.md"] } });
    expect((await mockCall("pulls", { repo: REPO }))[0]).toMatchObject({ state: "open", merged: false });
    expect((await tree("main")).files["README.md"]).toBe("main 側の変更\n");
  });

  it("ブランチ保護・必須の検査で止まる場合は、満たせない条件を具体的に返す", async () => {
    const t = await setup();
    await mockCall("protect", { repo: REPO, failing: ["test"], pending: ["lint"] });
    const r = await tool(t, "ship_change", { repo: REPO, branch: "feat/protected", title: "保護", files });
    expect(r).toMatchObject({ ok: false, code: "requirements_not_met", needs_human: true, details: { failing_checks: ["test"], pending_checks: ["lint"] } });

    await mockCall("protect", { repo: REPO, pending: ["lint"] });
    const r2 = await tool(t, "merge_pr", { repo: REPO, number: 1 });
    expect(r2).toMatchObject({ ok: false, code: "requirements_not_met", retryable: true, needs_human: false });

    await mockCall("protect", { repo: REPO, reviews: true });
    const r3 = await tool(t, "merge_pr", { repo: REPO, number: 1, request_id: "rv" });
    expect(r3.details.conditions[0]).toContain("レビュー");
  });

  it("マージ可否の判定が遅れても、待ってからマージする", async () => {
    const t = await setup();
    await mockCall("unknown-mergeable", { count: 2 });
    expect(await tool(t, "ship_change", { repo: REPO, branch: "feat/slow", title: "遅延", files })).toMatchObject({ ok: true, result: { merged: true } });
  });

  it("書き込みの直前にブランチが他から更新されても、新しい先頭の上に作り直す", async () => {
    const t = await setup();
    await tool(t, "create_branch", { repo: REPO, branch: "feat/race" });
    await mockCall("race", { repo: REPO, branch: "feat/race", count: 1 });
    const r = await tool(t, "commit_files", { repo: REPO, branch: "feat/race", message: "競合", files });
    expect(r.ok).toBe(true);
    const b = await tree("feat/race");
    expect(b.sha).toBe(r.result.commit_sha);
    expect(b.files["race-1.txt"]).toBe("other"); // 他の書き込みを失っていない
    expect(b.files["docs/new.md"]).toBe("新しい文書\n");
  });

  it("インストールトークンが失効していても取り直して続ける", async () => {
    const t = await setup();
    await mockCall("revoke-tokens");
    expect((await tool(t, "ship_change", { repo: REPO, branch: "feat/token", title: "失効", files })).ok).toBe(true);
  });

  it("GitHub の権限失効は人の判断が要るものとして返し、操作の記録に残す", async () => {
    const t = await setup();
    await mockCall("fail", { count: 3, status: 401 });
    const r = await tool(t, "create_branch", { repo: REPO, branch: "feat/denied" });
    expect(r).toMatchObject({ ok: false, needs_human: true, retryable: false });
    const ops = await tool(t, "list_operations", { needs_human_only: true });
    expect(ops.operations.some((o: any) => o.kind === "github" && o.status === "failed")).toBe(true);
  });
});
