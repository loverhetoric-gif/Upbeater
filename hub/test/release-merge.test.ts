import { env, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { ORIGIN } from "./helpers";
import { connectWithRepo, mockCall, tool } from "./mcp-helpers";

const REPO = "acme/widget";
const files = [{ path: "docs/new.md", content: "新しい文書\n" }];

async function mcpToken(owner: string): Promise<string> {
  const r = await SELF.fetch(`${ORIGIN}/v1/admin/mcp-tokens`, { method: "POST", headers: { authorization: "Bearer test-admin-token", "content-type": "application/json" }, body: JSON.stringify({ owner_id: owner }) });
  return ((await r.json()) as any).token as string;
}

async function merge(token: string | null, body: unknown, method = "POST") {
  const r = await SELF.fetch(`${ORIGIN}/v1/release-merge`, {
    method,
    headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
    ...(method === "POST" ? { body: JSON.stringify(body) } : {}),
  });
  return { status: r.status, body: r.status === 405 ? null : ((await r.json()) as any) };
}

async function openPr(access: string, branch = "feat/doc") {
  const r = await tool(access, "ship_change", { repo: REPO, branch, title: "文書を追加", files, merge: false });
  return r.result.pr_number as number;
}

describe("POST /v1/release-merge", () => {
  it("接続用トークンで承認後のマージを実行し、同じ request_id の再依頼は完了済みの結果を返す", async () => {
    const c = await connectWithRepo(REPO);
    const n = await openPr(c.access);
    const t = await mcpToken(c.owner);
    const r1 = await merge(t, { repo: REPO, number: n, request_id: "rel-1" });
    expect(r1).toMatchObject({ status: 200, body: { ok: true, merged: true } });
    expect((await mockCall("tree", { repo: REPO, branch: "main" })).files["docs/new.md"]).toBe("新しい文書\n");
    const r2 = await merge(t, { repo: REPO, number: n, request_id: "rel-1" });
    expect(r2.body).toMatchObject({ ok: true, merged: true, note: expect.stringContaining("完了済み") });
    // 同じ request_id で別の PR は拒否する
    expect((await merge(t, { repo: REPO, number: n + 5, request_id: "rel-1" })).body).toMatchObject({ ok: false, code: "request_id_conflict" });
  });

  it("OAuth のアクセストークンでも通り、認証なし・不正な内容は拒否する", async () => {
    const c = await connectWithRepo(REPO);
    const n = await openPr(c.access, "feat/oauth");
    expect((await merge(c.access, { repo: REPO, number: n, request_id: "rel-2" })).body).toMatchObject({ ok: true, merged: true });
    expect((await merge(null, { repo: REPO, number: n, request_id: "x" })).status).toBe(401);
    expect((await merge("upb_m_invalid", { repo: REPO, number: n, request_id: "x" })).status).toBe(401);
    expect((await merge(c.access, {}, "GET")).status).toBe(405);
    for (const bad of [{ repo: REPO, number: n }, { repo: "bad", number: n, request_id: "x" }, { repo: REPO, number: 0, request_id: "x" }, { repo: REPO, number: "1", request_id: "x" }]) {
      const r = await merge(c.access, bad);
      expect(r.status).toBe(400);
      expect(r.body.ok).toBe(false);
    }
  });

  it("登録していないリポジトリ・他の利用者のリポジトリはマージしない。失敗は日本語の理由で返し、トークンは出さない", async () => {
    const me = await connectWithRepo(REPO);
    const other = await connect2();
    const n = await openPr(me.access, "feat/mine");
    const r = await merge(other, { repo: REPO, number: n, request_id: "rel-3" });
    expect(r.body).toMatchObject({ ok: false, code: "repo_not_allowed" });
    expect(r.body.reason).toContain("登録されていません");
    expect(JSON.stringify(r.body)).not.toContain(other);
    expect((await mockCall("pulls", { repo: REPO }))[0]).toMatchObject({ merged: false });
  });

  it("衝突など人の判断が要る失敗は ok:false で返す", async () => {
    const c = await connectWithRepo(REPO);
    await tool(c.access, "ship_change", { repo: REPO, branch: "feat/conflict", title: "衝突", files: [{ path: "README.md", content: "こちらの変更\n" }], merge: false });
    await mockCall("seed", { repo: REPO, branch: "main", files: { "README.md": "main 側の変更\n" } });
    const r = await merge(await mcpToken(c.owner), { repo: REPO, number: 1, request_id: "rel-4" });
    expect(r.body).toMatchObject({ ok: false, merged: false, code: "merge_conflict", needs_human: true });
  });
});

async function connect2(): Promise<string> {
  const { connect } = await import("./mcp-helpers");
  return (await connect({ login: "renamed", id: 424242 })).access;
}

describe("delete_secret / unregister_repo", () => {
  async function putSecrets(repoId: string, ownerId: string) {
    const now = Date.now();
    for (const [rid, name] of [[repoId, "TOKEN_A"], [repoId, "TOKEN_B"], ["", "SHARED"]] as const) {
      await env.DB.prepare("INSERT INTO secrets (owner_id, repo_id, name, ciphertext, iv, created_at, updated_at) VALUES (?, ?, ?, 'ct', 'iv', ?, ?)").bind(ownerId, rid, name, now, now).run();
    }
  }

  it("delete_secret は指定した 1 つだけを消し、記録を残す。名前の不正・未登録の repo は拒否する", async () => {
    const c = await connectWithRepo(REPO);
    const repo = await env.DB.prepare("SELECT id FROM repos WHERE full_name = ?").bind(REPO).first<{ id: string }>();
    await putSecrets(repo!.id, c.owner);
    expect(await tool(c.access, "delete_secret", { repo: REPO, name: "TOKEN_A" })).toMatchObject({ ok: true, deleted: true });
    expect(await tool(c.access, "delete_secret", { repo: REPO, name: "TOKEN_A" })).toMatchObject({ ok: true, deleted: false });
    expect((await tool(c.access, "list_secrets", {})).secrets.map((s: any) => s.name).sort()).toEqual(["SHARED", "TOKEN_B"]);
    expect(await tool(c.access, "delete_secret", { name: "SHARED" })).toMatchObject({ ok: true, deleted: true });
    expect(await tool(c.access, "delete_secret", { repo: REPO, name: "bad name" })).toMatchObject({ ok: false, code: "invalid_input" });
    expect(await tool(c.access, "delete_secret", { repo: "no/such", name: "TOKEN_B" })).toMatchObject({ ok: false, code: "repo_not_found" });
    const ops = await env.DB.prepare("SELECT stage, detail FROM operations WHERE kind = 'secret' AND stage = 'delete'").all<{ detail: string }>();
    expect(ops.results.length).toBeGreaterThanOrEqual(2);
    expect(JSON.stringify(ops.results)).not.toContain("ct");
  });

  it("unregister_repo は登録・秘密情報・入力ページを消し、共通の秘密情報と他の利用者には触れない", async () => {
    const c = await connectWithRepo(REPO);
    const other = await connect2();
    const repo = await env.DB.prepare("SELECT id FROM repos WHERE full_name = ?").bind(REPO).first<{ id: string }>();
    await putSecrets(repo!.id, c.owner);
    await tool(c.access, "request_secrets", { repo: REPO, names: ["TOKEN_C"] });
    expect(await tool(other, "unregister_repo", { repo: REPO })).toMatchObject({ ok: false, code: "repo_not_found" });
    expect(await tool(c.access, "unregister_repo", { repo: REPO })).toMatchObject({ ok: true, secrets_deleted: 2, secret_forms_deleted: 1 });
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM repos WHERE id = ?").bind(repo!.id).first()).toMatchObject({ n: 0 });
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM secrets WHERE repo_id = ?").bind(repo!.id).first()).toMatchObject({ n: 0 });
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM secret_forms WHERE repo_id = ?").bind(repo!.id).first()).toMatchObject({ n: 0 });
    expect((await tool(c.access, "list_secrets", {})).secrets.map((s: any) => s.name)).toEqual(["SHARED"]);
    expect(await tool(c.access, "unregister_repo", { repo: REPO })).toMatchObject({ ok: false, code: "repo_not_found" });
    const op = await env.DB.prepare("SELECT status, detail FROM operations WHERE kind = 'repo' AND stage = 'unregister'").first<{ status: string; detail: string }>();
    expect(op?.status).toBe("ok");
    expect(JSON.parse(op!.detail)).toMatchObject({ repo: REPO, secrets_deleted: 2 });
    // 再登録できる
    expect((await tool(c.access, "register_repo", { repo: REPO })).ok).toBe(true);
  });

  it("実行の記録が残っているリポジトリは消さない", async () => {
    const c = await connectWithRepo(REPO);
    const repo = await env.DB.prepare("SELECT id FROM repos WHERE full_name = ?").bind(REPO).first<{ id: string }>();
    await env.DB.prepare("INSERT INTO runs (id, owner_id, repo_id, number, workflow_file, workflow_name, event, sha, status, created_at, updated_at) VALUES ('r1', ?, ?, 1, 'ci.yml', 'ci', 'manual', 'abc', 'queued', ?, ?)")
      .bind(c.owner, repo!.id, Date.now(), Date.now())
      .run();
    expect(await tool(c.access, "unregister_repo", { repo: REPO })).toMatchObject({ ok: false, code: "repo_has_history", needs_human: true });
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM repos WHERE id = ?").bind(repo!.id).first()).toMatchObject({ n: 1 });
  });
});
