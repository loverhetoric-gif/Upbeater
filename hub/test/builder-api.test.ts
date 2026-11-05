import { env, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { sha256Hex } from "../src/crypto";
import { clearGitHubAppCache } from "../src/github-app";
import { MAX_ATTEMPTS } from "../src/routes/builder";
import { deviceCall, ORIGIN } from "./helpers";
import { connect, mockCall, tool } from "./mcp-helpers";

const REPO = "acme/widget";
const STEPS = { linux: { requires: ["sh"], build: ["make"], artifact: "out/app.AppImage" }, android: { build: ["./gradlew assemble"], artifact: "app.apk" } };

async function setup(opts: { kind?: string; os?: string[]; owner?: { login: string; id: number } } = {}) {
  const c = await connect(opts.owner);
  await mockCall("seed", { repo: REPO, branch: "main", files: { "a.txt": "1" }, default: true });
  const reg = await tool(c.access, "register_app", { name: "Widget", repo: REPO, kind: opts.kind ?? "build", target_os: opts.os ?? ["linux", "android"], install_steps: STEPS });
  const b = await tool(c.access, "create_builder", { name: "自宅の Mac" });
  return { access: c.access, appId: reg.app_id as string, token: b.token as string };
}

async function claim(token: string, os = ["linux", "android", "macos", "ios"]) {
  const r = await SELF.fetch(`${ORIGIN}/v1/builder/claim`, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify({ os }) });
  return { status: r.status, body: r.status === 204 ? null : ((await r.json()) as any) };
}
const call = (token: string, id: string, what: string, body: unknown = {}) =>
  SELF.fetch(`${ORIGIN}/v1/builder/jobs/${id}/${what}`, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify(body) });
async function upload(token: string, id: string, data: Uint8Array, sha?: string) {
  return SELF.fetch(`${ORIGIN}/v1/builder/jobs/${id}/artifact`, {
    method: "PUT",
    headers: { authorization: `Bearer ${token}`, "x-upbeater-sha256": sha ?? (await sha256Hex(data)) },
    body: data,
  });
}
const jobs = async (appId: string) =>
  (await env.DB.prepare("SELECT seq, os, status, attempt FROM build_jobs WHERE app_id = ? ORDER BY seq, os").bind(appId).all()).results;

describe("ビルド指示の待ち行列", () => {
  it("連続した更新では、アプリごとに最新の版の指示だけが残る", async () => {
    const s = await setup();
    for (const v of ["2", "3"]) {
      await mockCall("seed", { repo: REPO, branch: "main", files: { "a.txt": v } });
      await tool(s.access, "push_update", { app_id: s.appId });
    }
    expect(await jobs(s.appId)).toEqual([
      { seq: 1, os: "android", status: "cancelled", attempt: 0 },
      { seq: 1, os: "linux", status: "cancelled", attempt: 0 },
      { seq: 2, os: "android", status: "cancelled", attempt: 0 },
      { seq: 2, os: "linux", status: "cancelled", attempt: 0 },
      { seq: 3, os: "android", status: "queued", attempt: 0 },
      { seq: 3, os: "linux", status: "queued", attempt: 0 },
    ]);
    const c = await claim(s.token, ["linux"]);
    expect(c.body.job).toMatchObject({ seq: 3, os: "linux", attempt: 1 });
    expect(c.body.steps).toEqual({ requires: ["sh"], build: ["make"], artifact: "out/app.AppImage", timeout_minutes: 60 });
    expect(c.body.source.clone_url).toBe("https://github-mock.test/acme/widget.git");
  });

  it("ビルドできる OS の指示だけを、古い順に 1 件ずつ渡す", async () => {
    const s = await setup({ os: ["android"] });
    expect((await claim(s.token, ["linux"])).status).toBe(204);
    const a = await claim(s.token, ["android"]);
    expect(a.body.job.os).toBe("android");
    expect((await claim(s.token, ["android"])).status).toBe(204); // 同じ指示は二重に渡さない
  });

  it("GitHub Releases を使うアプリには指示を出さない", async () => {
    const s = await setup({ kind: "release" });
    expect(await jobs(s.appId)).toEqual([]);
  });

  it("取得用のトークンは応答にだけ載せ、Hub には残さない", async () => {
    const s = await setup();
    const c = await claim(s.token);
    const header: string = c.body.source.auth_header;
    expect(header).toMatch(/^Authorization: Basic /);
    const token = atob(header.replace("Authorization: Basic ", "")).replace("x-access-token:", "");
    expect(token).toMatch(/^ghs_/);
    for (const t of ["build_jobs", "builders", "operations", "github_requests"]) {
      const dump = JSON.stringify((await env.DB.prepare(`SELECT * FROM ${t}`).all()).results);
      expect(dump).not.toContain(token);
    }
  });
});

describe("Builder の停止・中断", () => {
  it("連絡が途絶えた指示は待ち行列に戻り、上限に達したら失敗として記録する", async () => {
    const s = await setup({ os: ["linux"] });
    for (let i = 1; i <= MAX_ATTEMPTS; i++) {
      const c = await claim(s.token);
      expect(c.body.job.attempt).toBe(i);
      await env.DB.prepare("UPDATE build_jobs SET lease_until = 0 WHERE status = 'claimed'").run(); // Mac がスリープした
    }
    expect((await claim(s.token)).status).toBe(204);
    expect(await jobs(s.appId)).toEqual([{ seq: 1, os: "linux", status: "failed", attempt: MAX_ATTEMPTS }]);
    const rel = await env.DB.prepare("SELECT status FROM releases WHERE app_id = ?").bind(s.appId).first();
    expect(rel).toEqual({ status: "failed" });
  });

  it("生存の連絡で期限を延ばし、新しい版に置き換わったら中断を指示する", async () => {
    const s = await setup({ os: ["linux"] });
    const c = await claim(s.token);
    expect(await (await call(s.token, c.body.job.id, "heartbeat", { stage: "build" })).json()).toMatchObject({ continue: true });
    await mockCall("seed", { repo: REPO, branch: "main", files: { "a.txt": "2" } });
    await tool(s.access, "push_update", { app_id: s.appId });
    expect(await (await call(s.token, c.body.job.id, "heartbeat")).json()).toMatchObject({ continue: false, status: "cancelled" });
    // 取り消された版の成果物は受け付けない
    const up = await upload(s.token, c.body.job.id, new Uint8Array([1, 2, 3]));
    expect(up.status).toBe(409);
    expect((await env.ARTIFACTS.list()).objects).toHaveLength(0);
  });

  it("中断（再試行できる失敗）は待ち行列に戻す", async () => {
    const s = await setup({ os: ["linux"] });
    const c = await claim(s.token);
    const r = await call(s.token, c.body.job.id, "fail", { stage: "interrupted", reason: "Builder を停止しました", retryable: true });
    expect(await r.json()).toMatchObject({ status: "requeued" });
    expect((await claim(s.token)).body.job.attempt).toBe(2);
  });
});

describe("成果物の提出と失敗の報告", () => {
  it("SHA-256 が一致しない成果物は受け付けず、一致したものだけを配信する", async () => {
    const s = await setup({ os: ["linux"] });
    const c = await claim(s.token);
    const data = new Uint8Array(50_000).map((_, i) => i & 255);
    const bad = await upload(s.token, c.body.job.id, data, "0".repeat(64));
    expect(bad.status).toBe(400);
    expect((await env.ARTIFACTS.list()).objects).toHaveLength(0);
    expect(await env.DB.prepare("SELECT status FROM releases WHERE app_id = ?").bind(s.appId).first()).toEqual({ status: "pending" });

    const ok = await upload(s.token, c.body.job.id, data);
    expect(ok.status).toBe(201);
    expect(await jobs(s.appId)).toEqual([{ seq: 1, os: "linux", status: "succeeded", attempt: 1 }]);

    const { code } = await tool(s.access, "create_registration_code");
    const dev = (await (await SELF.fetch(`${ORIGIN}/v1/devices/register`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ code, name: "PC", os: "linux" }) })).json()) as any;
    const check = (await (await deviceCall(dev.token, "/v1/devices/check", { app_id: s.appId, current_seq: 0 })).json()) as any;
    expect(check.update).toBe(true);
  });

  it("ビルドの失敗は配信せず、段階・理由・末尾ログ（秘密情報は伏せる）を MCP から取得できる", async () => {
    const s = await setup({ os: ["linux"] });
    const c = await claim(s.token);
    const leaked = "ghs_" + "A".repeat(36);
    const r = await call(s.token, c.body.job.id, "fail", { stage: "build", reason: "make が失敗しました（終了コード 2）", log_tail: `...\nerror: undefined symbol\ntoken=${leaked}\n`, retryable: false });
    expect(await r.json()).toMatchObject({ status: "failed" });
    const builds = await tool(s.access, "list_builds", { app_id: s.appId });
    expect(builds.builds[0]).toMatchObject({ status: "failed", stage: "build", reason: "make が失敗しました（終了コード 2）" });
    expect(builds.builds[0].log_tail).toContain("undefined symbol");
    expect(builds.builds[0].log_tail).not.toContain(leaked);
    const ops = await tool(s.access, "list_operations", { needs_human_only: true });
    expect(ops.operations.some((o: any) => o.kind === "build" && o.stage === "build")).toBe(true);
    expect(await env.DB.prepare("SELECT status FROM releases WHERE app_id = ?").bind(s.appId).first()).toEqual({ status: "failed" });
  });

  it("道具の不足は具体的に報告され、人の判断が要るものとして残る", async () => {
    const s = await setup({ os: ["linux"] });
    const c = await claim(s.token);
    await call(s.token, c.body.job.id, "fail", { stage: "preflight", reason: "必要な道具がありません：flutter, java", retryable: false });
    const builds = await tool(s.access, "list_builds", { status: "failed" });
    expect(builds.builds[0]).toMatchObject({ stage: "preflight", reason: "必要な道具がありません：flutter, java" });
  });

  it("他の利用者の Builder は指示を受け取れず、無効なトークンは拒否する", async () => {
    const s = await setup({ os: ["linux"] });
    const other = await connect({ login: "renamed", id: 424242 });
    const ob = await tool(other.access, "create_builder", { name: "他人の Mac" });
    expect((await claim(ob.token)).status).toBe(204);
    expect((await claim("upb_b_invalid")).status).toBe(401);
    const c = await claim(s.token);
    expect((await call(ob.token, c.body.job.id, "heartbeat")).status).toBe(404);
  });

  it("GitHub App が外されていたら、指示を失敗にして人の判断を求める", async () => {
    const s = await setup({ os: ["linux"] });
    await mockCall("repo", { repo: REPO, uninstalled: true });
    clearGitHubAppCache(); // 記憶済みのインストール情報を捨て、外れたことを Hub に気付かせる
    const c = await claim(s.token);
    expect(c.status).toBe(409);
    expect(c.body.reason).toContain("インストールされていません");
    expect(await jobs(s.appId)).toEqual([{ seq: 1, os: "linux", status: "failed", attempt: 1 }]);
    const ops = await tool(s.access, "list_operations", { needs_human_only: true });
    expect(ops.operations.some((o: any) => o.kind === "build" && o.stage === "fetch")).toBe(true);
  });
});
