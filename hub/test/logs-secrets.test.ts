import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { maskVariants, Masker } from "../src/secrets";
import { admin, claim, commit, jobCall, pullRequest, pushAndRun, registerRepo, registerRunner, sha, webhook } from "./helpers";

const SECRET = "s3cr3t-Value_9!xyz";
const DEF = `on: { push: { branches: [main] }, pull_request: {} }\njobs:\n  deploy:\n    runs-on: linux\n    secrets: [DEPLOY_TOKEN]\n    steps: [{ run: deploy }]\n`;

async function setup() {
  await registerRepo();
  await admin("PUT", "/v1/admin/secrets", { owner_id: "owner1", name: "DEPLOY_TOKEN", value: SECRET });
  await admin("PUT", "/v1/admin/secrets", { owner_id: "owner1", name: "OTHER_TOKEN", value: "never-sent-value" });
  return registerRunner(["linux"]);
}

async function logs(jobId: string) {
  return (await admin("GET", `/v1/admin/jobs/${jobId}/logs`)).text();
}

describe("ログの逐次受信", () => {
  it("順不同・重複・途切れを受け、欠けた通番を返し、再送で通番の順に並べ直す", async () => {
    const t = await setup();
    await pushAndRun("a", { ".upbeater/ci.yml": DEF });
    const c = (await claim(t)).body;
    const send = (chunks: { seq: number; text: string }[], last = 0) => jobCall(t, c.job.id, c.job_token, "logs", { chunks, last_seq: last });
    expect((await send([{ seq: 1, text: "一\n" }, { seq: 3, text: "三\n" }])).body).toMatchObject({ contiguous_through: 1, missing: [2] });
    // 通信が途切れて 2 と 4 が届かないまま終了の報告が来た
    const done = await jobCall(t, c.job.id, c.job_token, "complete", { conclusion: "success", last_seq: 4 });
    expect(done.body.missing).toEqual([2, 4]);
    expect(await logs(c.job.id)).toBe("一\n\n[ログの欠落：通番 2〜2]\n三\n");
    // Runner が保持していた分を再送（重複を含む）
    const r = await send([{ seq: 4, text: "四\n" }, { seq: 2, text: "二\n" }, { seq: 3, text: "三（重複）\n" }], 4);
    expect(r.body).toMatchObject({ contiguous_through: 4, missing: [] });
    expect(await logs(c.job.id)).toBe("一\n二\n三\n四\n");
  });
});

describe("秘密情報", () => {
  it("暗号化して保存し、ジョブに指定された分だけ Runner へ渡す", async () => {
    const t = await setup();
    const dump = JSON.stringify((await env.DB.prepare("SELECT * FROM secrets").all()).results);
    expect(dump).not.toContain(SECRET);
    const names = ((await (await admin("GET", "/v1/admin/secrets?owner_id=owner1")).json()) as any).secrets.map((s: any) => s.name);
    expect(names).toEqual(["DEPLOY_TOKEN", "OTHER_TOKEN"]);
    await pushAndRun("a", { ".upbeater/ci.yml": DEF });
    const c = (await claim(t)).body;
    expect(c.secrets).toEqual({ DEPLOY_TOKEN: SECRET });
    expect(c.secrets_withheld).toBe(false);
  });

  it("GITHUB_TOKEN は、登録が無ければ GitHub App のトークンを自動で渡し、ログでは伏せる。登録があればそちらを使う", async () => {
    const t = await setup();
    const D = DEF.replace("[DEPLOY_TOKEN]", "[GITHUB_TOKEN]");
    await pushAndRun("a", { ".upbeater/ci.yml": D });
    const c = (await claim(t)).body;
    const tok = c.secrets.GITHUB_TOKEN as string;
    expect(typeof tok).toBe("string");
    expect(tok.length).toBeGreaterThan(5);
    await jobCall(t, c.job.id, c.job_token, "logs", { chunks: [{ seq: 1, text: `t=${tok}\n` }] });
    await jobCall(t, c.job.id, c.job_token, "complete", { conclusion: "success", last_seq: 1 });
    expect(await logs(c.job.id)).not.toContain(tok);
    // 登録があれば、そちらを優先する
    await admin("PUT", "/v1/admin/secrets", { owner_id: "owner1", name: "GITHUB_TOKEN", value: "registered-pat-12345" });
    await pushAndRun("b", { ".upbeater/ci.yml": D });
    expect((await claim(t)).body.secrets).toEqual({ GITHUB_TOKEN: "registered-pat-12345" });
  });

  it("フォークからの PR には秘密情報を渡さない", async () => {
    const t = await setup();
    await commit("pr", { ".upbeater/ci.yml": DEF }, { branch: null });
    await webhook("pull_request", pullRequest(sha("pr"), { fork: true }));
    const c = (await claim(t)).body;
    expect(c.secrets).toEqual({});
    expect(c.secrets_withheld).toBe(true);
    // 同じリポジトリ内の PR には渡す
    await commit("pr2", { ".upbeater/ci.yml": DEF }, { branch: null });
    await webhook("pull_request", pullRequest(sha("pr2")));
    expect((await claim(t)).body.secrets).toEqual({ DEPLOY_TOKEN: SECRET });
  });

  it("ログ上で値と変形（base64・長い base64 の途中・URL 符号化・JSON・16 進）を伏せる", async () => {
    const t = await setup();
    await pushAndRun("a", { ".upbeater/ci.yml": DEF });
    const c = (await claim(t)).body;
    const b64 = (s: string) => btoa(String.fromCharCode(...new TextEncoder().encode(s)));
    const lines = [
      `raw=${SECRET}`,
      `b64=${b64(SECRET)}`,
      `embedded1=${b64("x" + SECRET + "tail")}`,
      `embedded2=${b64("xy" + SECRET + "tail")}`,
      `embedded3=${b64("Authorization: Basic " + SECRET)}`,
      `url=${encodeURIComponent(SECRET)}`,
      `json=${JSON.stringify({ t: SECRET })}`,
      `hex=${Array.from(new TextEncoder().encode(SECRET), (x) => x.toString(16).padStart(2, "0")).join("")}`,
    ];
    await jobCall(t, c.job.id, c.job_token, "logs", { chunks: [{ seq: 1, text: lines.join("\n") + "\n" }] });
    // 断片の境目で分かれた値も、つないだ後に伏せる
    await jobCall(t, c.job.id, c.job_token, "logs", { chunks: [{ seq: 2, text: "split=" + SECRET.slice(0, 7) }, { seq: 3, text: SECRET.slice(7) + "\n" }] });
    await jobCall(t, c.job.id, c.job_token, "complete", { conclusion: "failure", reason: `失敗：${SECRET}`, last_seq: 3 });
    const text = await logs(c.job.id);
    expect(text).not.toContain(SECRET);
    for (const v of maskVariants(SECRET)) expect(text).not.toContain(v);
    expect(text.match(/\*\*\*/g)!.length).toBeGreaterThanOrEqual(lines.length + 1);
    // 保存されたものにも値は残らない
    const objs = await env.BLOBS.list();
    for (const o of objs.objects) expect(await (await env.BLOBS.get(o.key))!.text()).not.toContain(SECRET);
    const job = await env.DB.prepare("SELECT reason FROM jobs").first<{ reason: string }>();
    expect(job!.reason).toBe("失敗：***");
  });

  it("どの位置に埋まった base64 でも伏せられる", () => {
    const m = new Masker([SECRET]);
    for (let pre = 0; pre < 6; pre++) {
      const s = "P".repeat(pre) + SECRET + "Q".repeat(5);
      const e = btoa(s);
      expect(m.mask(e), `前置き ${pre}`).toContain("***");
    }
  });
});
