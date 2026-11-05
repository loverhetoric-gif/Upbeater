import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Builder } from "../src/builder.js";
import { HubClient } from "../src/hub.js";
import { runJob } from "../src/job.js";
import { fakeHub, gitRepo, job, tmp, type FakeHubState } from "./fixtures.js";

let hub: Awaited<ReturnType<typeof fakeHub>>;
let state: FakeHubState;
let client: HubClient;
let workRoot: string;

beforeEach(async () => {
  hub = await fakeHub();
  state = hub.state;
  client = new HubClient(hub.url, "upb_b_test-token-123");
  workRoot = tmp("upb-work-");
});
afterEach(async () => {
  await hub.close();
});

const deps = (extra = {}) => ({ hub: client, workRoot, heartbeatMs: 50, ...extra });
const leftovers = () => readdirSync(workRoot).filter((n) => n.startsWith("job-"));

describe("ビルドの実行", () => {
  it("取得 → ビルド → 成果物の提出。作業場所は消える", async () => {
    const repo = gitRepo({ "src/main.c": "int main(){}" });
    const j = job(repo, { build: ["mkdir -p out", 'printf "built:%s" "$UPBEATER_SEQ" > out/app.bin'], artifact: "out/app.bin" });
    expect(await runJob(j, deps())).toBe("succeeded");
    expect(state.uploads).toHaveLength(1);
    expect(state.uploads[0]!.body.toString()).toBe("built:3");
    expect(state.fails).toEqual([]);
    expect(leftovers()).toEqual([]);
  });

  it("ビルド不要（direct）はリポジトリの内容を .git を除いて tar.gz にまとめる", async () => {
    const repo = gitRepo({ "index.html": "<h1>hi</h1>", "js/app.js": "1" });
    expect(await runJob(job(repo, {}), deps())).toBe("succeeded");
    const file = join(tmp(), "a.tar.gz");
    writeFileSync(file, state.uploads[0]!.body);
    const list = execFileSync("tar", ["-tzf", file], { encoding: "utf8" });
    expect(list).toContain("index.html");
    expect(list).toContain("js/app.js");
    expect(list).not.toContain(".git/");
  });

  it("ビルドが失敗したら上げずに、段階・理由・末尾ログを報告する", async () => {
    const repo = gitRepo({ "a.txt": "1" });
    const j = job(repo, { build: ["echo コンパイル中", "echo 'error: 型が合いません' >&2; exit 2"], artifact: "a.txt" });
    expect(await runJob(j, deps())).toBe("failed");
    expect(state.uploads).toEqual([]);
    expect(state.fails[0]).toMatchObject({ stage: "build", retryable: false });
    expect(state.fails[0]!.reason).toContain("終了コード 2");
    expect(state.fails[0]!.log_tail).toContain("error: 型が合いません");
    expect(leftovers()).toEqual([]);
  });

  it("必要な道具が無ければ、取得の前に不足を具体的に報告する", async () => {
    const repo = gitRepo({ "a.txt": "1" });
    const j = job(repo, { requires: ["no-such-tool-xyz", "sh", "another-missing"], build: ["true"] });
    expect(await runJob(j, deps())).toBe("failed");
    expect(state.fails[0]).toMatchObject({ stage: "preflight", reason: "必要な道具がありません：no-such-tool-xyz, another-missing" });
    expect(existsSync(workRoot) ? leftovers() : []).toEqual([]);
  });

  it("取得用の資格情報はビルド手順に渡さず、ログからも伏せる", async () => {
    const repo = gitRepo({ "a.txt": "1" });
    const secret = "ghs_" + "S".repeat(36);
    const header = `Authorization: Basic ${Buffer.from(`x-access-token:${secret}`).toString("base64")}`;
    const j = job(repo, { build: ["env > env.txt", `echo "${secret}"`, "exit 1"], artifact: "env.txt" }, { auth_header: header });
    await runJob(j, deps());
    const report = JSON.stringify(state.fails);
    expect(report).not.toContain(secret);
    expect(report).not.toContain(Buffer.from(`x-access-token:${secret}`).toString("base64"));
    expect(state.fails[0]!.log_tail).toContain("[伏せ字]");

    const j2 = job(repo, { build: ["env > env.txt"], artifact: "env.txt" }, { auth_header: header });
    expect(await runJob(j2, deps())).toBe("succeeded");
    const env = state.uploads[0]!.body.toString();
    expect(env).not.toContain(secret);
    expect(env).not.toContain("GIT_CONFIG");
    expect(env).toContain("UPBEATER_COMMIT=" + repo.sha);
  });

  it("成果物のパスが作業場所の外を指していたら拒否する", async () => {
    const repo = gitRepo({ "a.txt": "1" });
    expect(await runJob(job(repo, { artifact: "../../etc/passwd" }), deps())).toBe("failed");
    expect(state.fails[0]).toMatchObject({ stage: "artifact" });
    const j = job(repo, { build: ["ln -s /etc/hosts link"], artifact: "link" });
    expect(await runJob(j, deps())).toBe("failed");
    expect(state.fails[1]!.reason).toContain("作業場所の外");
    expect(await runJob(job(repo, { build: ["touch empty"], artifact: "empty" }), deps())).toBe("failed");
    expect(state.fails[2]!.reason).toContain("空です");
    expect(state.uploads).toEqual([]);
  });

  it("指示のコミットが取得できなければ、再試行できる失敗として報告する", async () => {
    const repo = gitRepo({ "a.txt": "1" });
    const j = job({ url: repo.url, sha: "f".repeat(40) }, {});
    expect(await runJob(j, deps())).toBe("failed");
    expect(state.fails[0]).toMatchObject({ stage: "fetch", retryable: true });
  });
});

describe("中断・取り消し・時間切れ", () => {
  it("Hub が取り消したら、実行中のビルドを止めて何も上げない", async () => {
    const repo = gitRepo({ "a.txt": "1" });
    state.cancelOnHeartbeat = true;
    const t0 = Date.now();
    const j = job(repo, { build: ["sleep 30", "echo done > out.txt"], artifact: "out.txt" });
    expect(await runJob(j, deps())).toBe("cancelled");
    expect(Date.now() - t0).toBeLessThan(10_000);
    expect(state.uploads).toEqual([]);
    expect(state.fails).toEqual([]); // 取り消し済みの指示には報告しない
    expect(leftovers()).toEqual([]);
  });

  it("Builder の停止で中断したら、再試行できる中断として報告し、作業場所を消す", async () => {
    const repo = gitRepo({ "a.txt": "1" });
    const shutdown = new AbortController();
    setTimeout(() => shutdown.abort(), 300);
    const j = job(repo, { build: ["sleep 30"], artifact: "a.txt" });
    expect(await runJob(j, deps({ shutdown: shutdown.signal }))).toBe("interrupted");
    expect(state.fails[0]).toMatchObject({ stage: "interrupted", retryable: true });
    expect(leftovers()).toEqual([]);
  });

  it("時間切れのビルドは止め、時間切れとして報告する", async () => {
    const repo = gitRepo({ "a.txt": "1" });
    const j = job(repo, { build: ["sleep 30"], artifact: "a.txt" });
    expect(await runJob(j, deps({ timeoutCapMs: 500 }))).toBe("failed");
    expect(state.fails[0]!.reason).toContain("時間切れ");
  });

  it("提出に失敗したら、再試行できる失敗として報告する", async () => {
    const repo = gitRepo({ "a.txt": "1" });
    state.uploadErrors = 1;
    expect(await runJob(job(repo, { artifact: "a.txt" }), deps())).toBe("failed");
    expect(state.fails[0]).toMatchObject({ stage: "upload", retryable: true });
  });
});

describe("常駐の繰り返し", () => {
  it("起動時に、前回の中断で残った作業場所を消す", async () => {
    mkdirSync(join(workRoot, "job-old", "src"), { recursive: true });
    writeFileSync(join(workRoot, "job-old", "src", "half.bin"), "途中");
    mkdirSync(join(workRoot, "keep"), { recursive: true });
    const b = new Builder({ hub: client, workRoot, os: ["linux"], pollMs: 10 });
    expect(await b.cleanupStale()).toBe(1);
    expect(readdirSync(workRoot)).toEqual(["keep"]);
  });

  it("Hub が止まっていても落ちずに待ち、復旧後に指示を順番に処理する", async () => {
    const repo = gitRepo({ "a.txt": "1" });
    state.down = true;
    const logs: string[] = [];
    const b = new Builder({ hub: client, workRoot, os: ["linux"], pollMs: 20, maxBackoffMs: 50, log: (l) => logs.push(l), jobDeps: { heartbeatMs: 50 } });
    expect(await b.tick()).toMatchObject({ kind: "hub_unavailable" });
    state.jobs.push(job(repo, { artifact: "a.txt" }), job(repo, { build: ["echo 2 > b.txt"], artifact: "b.txt" }));
    const shutdown = new AbortController();
    const loop = b.loop(shutdown.signal);
    setTimeout(() => (state.down = false), 150);
    const t0 = Date.now();
    while (state.uploads.length < 2 && Date.now() - t0 < 10_000) await new Promise((r) => setTimeout(r, 20));
    shutdown.abort();
    await loop;
    expect(state.uploads.map((u) => u.body.toString())).toEqual(["1", "2\n"]);
    expect(logs.some((l) => l.includes("Hub に届きません"))).toBe(true);
  });

  it("トークンが無効なら、原因を示して止まる", async () => {
    const bad = new HubClient(hub.url, "upb_b_wrong");
    const b = new Builder({ hub: bad, workRoot, os: ["linux"], pollMs: 10 });
    await expect(b.tick()).rejects.toThrow("トークンが無効");
  });
});

describe("シンボリックリンクの扱い", () => {
  it("作業場所の中を指すリンクは成果物として使える", async () => {
    const repo = gitRepo({ "dist/app.bin": "bin" });
    const j = job(repo, { build: ["ln -s dist/app.bin latest"], artifact: "latest" });
    expect(await runJob(j, deps())).toBe("succeeded");
    expect(state.uploads[0]!.body.toString()).toBe("bin");
    void symlinkSync;
  });
});
