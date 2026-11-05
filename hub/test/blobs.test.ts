import { env, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { toHex } from "../src/crypto";
import { claim, commit, finish, ORIGIN, pullRequest, pushAndRun, registerRepo, registerRunner, webhook } from "./helpers";

const TWO = `on: { push: {}, pull_request: {} }\njobs:\n  build:\n    runs-on: linux\n    steps: [{ run: make }]\n  test:\n    needs: build\n    runs-on: linux\n    steps: [{ run: test }]\n`;

async function hash(data: Uint8Array) {
  return toHex(await crypto.subtle.digest("SHA-256", data));
}

function blob(token: string, c: any, kind: "artifacts" | "cache", name: string, method = "GET", data?: Uint8Array, sha?: string, extra: Record<string, string> = {}) {
  return SELF.fetch(`${ORIGIN}/v1/runners/jobs/${c.job.id}/${kind}/${encodeURIComponent(name)}`, {
    method,
    headers: { authorization: `Bearer ${token}`, "x-upbeater-job-token": c.job_token, ...(data ? { "content-length": String(data.length), "x-upbeater-sha256": sha ?? "" } : {}), ...extra },
    body: data,
  });
}

const bytes = (s: string) => new TextEncoder().encode(s);

describe("成果物", () => {
  it("同じ実行の後のジョブへ受け渡し、SHA-256 を返す。別の実行からは見えない", async () => {
    await registerRepo();
    const t = await registerRunner(["linux"]);
    await pushAndRun("a", { ".upbeater/ci.yml": TWO });
    const build = (await claim(t)).body;
    const data = bytes("成果物の中身");
    const sha = await hash(data);
    expect((await blob(t, build, "artifacts", "app", "PUT", data, sha, { "x-upbeater-format": "file", "x-upbeater-filename": "app.apk" })).status).toBe(201);
    expect((await env.DB.prepare("SELECT name, sha256, size FROM artifacts").first())).toMatchObject({ name: "app", sha256: sha, size: data.length });
    await finish(t, build);
    const test = (await claim(t)).body;
    expect(test.job.job_key).toBe("test");
    const r = await blob(t, test, "artifacts", "app");
    expect(r.status).toBe(200);
    expect(r.headers.get("x-upbeater-sha256")).toBe(sha);
    expect(r.headers.get("x-upbeater-format")).toBe("file");
    expect(r.headers.get("x-upbeater-filename")).toBe("app.apk");
    expect(new Uint8Array(await r.arrayBuffer())).toEqual(data);
    // 同じ実行の別のジョブが同じ名前で上書きすることはできない
    expect((await blob(t, test, "artifacts", "app", "PUT", data, sha)).status).toBe(409);
    await finish(t, test);

    await pushAndRun("b", { ".upbeater/ci.yml": TWO });
    const other = (await claim(t)).body;
    expect((await blob(t, other, "artifacts", "app")).status).toBe(404);
  });

  it("中身が SHA-256 と合わなければ保存しない", async () => {
    await registerRepo();
    const t = await registerRunner(["linux"]);
    await pushAndRun("a", { ".upbeater/ci.yml": TWO });
    const c = (await claim(t)).body;
    const r = await blob(t, c, "artifacts", "app", "PUT", bytes("改ざんされた中身"), await hash(bytes("本来の中身")));
    expect(r.status).toBe(400);
    expect((await r.json()) as any).toMatchObject({ error: "sha256_mismatch" });
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM artifacts").first("n")).toBe(0);
    expect((await env.BLOBS.list({ prefix: "artifacts/" })).objects).toHaveLength(0);
  });

  it("ジョブトークンが古い・名前が不正なら拒否する", async () => {
    await registerRepo();
    const t = await registerRunner(["linux"]);
    await pushAndRun("a", { ".upbeater/ci.yml": TWO });
    const c = (await claim(t)).body;
    const data = bytes("x");
    expect((await blob(t, { ...c, job_token: "upb_j_old" }, "artifacts", "app", "PUT", data, await hash(data))).status).toBe(409);
    expect((await blob(t, c, "artifacts", "../escape", "PUT", data, await hash(data))).status).toBe(400);
    expect((await blob(t, c, "artifacts", "app", "PUT", data, "zz")).status).toBe(400);
  });
});

describe("キャッシュ", () => {
  it("同じリポジトリの別の実行で使い回し、一度保存したものは変えない", async () => {
    await registerRepo();
    const t = await registerRunner(["linux"]);
    await pushAndRun("a", { ".upbeater/ci.yml": TWO });
    const c1 = (await claim(t)).body;
    const key = "deps-linux-" + "a".repeat(64);
    expect((await blob(t, c1, "cache", key)).status).toBe(404);
    const data = bytes("依存関係");
    expect((await blob(t, c1, "cache", key, "PUT", data, await hash(data))).status).toBe(201);
    expect((await blob(t, c1, "cache", key, "PUT", bytes("別"), await hash(bytes("別")))).status).toBe(409);
    await finish(t, c1);

    await pushAndRun("b", { ".upbeater/ci.yml": TWO });
    const c2 = (await claim(t)).body;
    const r = await blob(t, c2, "cache", key);
    expect(r.status).toBe(200);
    expect(new TextDecoder().decode(await r.arrayBuffer())).toBe("依存関係");
  });

  it("フォークからの PR はキャッシュを読めるが、保存できない（汚染の防止）", async () => {
    await registerRepo();
    const t = await registerRunner(["linux"]);
    const s = await commit("fork", { ".upbeater/ci.yml": TWO }, { branch: null });
    await webhook("pull_request", pullRequest(s, { fork: true }));
    const c = (await claim(t)).body;
    const data = bytes("毒入り");
    const r = await blob(t, c, "cache", "deps", "PUT", data, await hash(data));
    expect(r.status).toBe(403);
    expect((await blob(t, c, "cache", "deps")).status).toBe(404);
  });
});
