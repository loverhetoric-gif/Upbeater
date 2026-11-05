import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BuildSteps, ClaimedJob, FailReport } from "../src/hub.js";

export function tmp(prefix = "upb-test-"): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

/** テスト用の Git リポジトリ（指定のファイルで 1 コミット） */
export function gitRepo(files: Record<string, string>): { url: string; sha: string; dir: string } {
  const dir = tmp("upb-repo-");
  const g = (...args: string[]) => execFileSync("git", args, { cwd: dir, encoding: "utf8", env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.com", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.com" } }).trim();
  g("init", "-q", "-b", "main");
  g("config", "uploadpack.allowAnySHA1InWant", "true");
  for (const [p, c] of Object.entries(files)) {
    execFileSync("mkdir", ["-p", join(dir, p, "..")]);
    writeFileSync(join(dir, p), c);
  }
  g("add", "-A");
  g("commit", "-q", "-m", "初版");
  return { url: `file://${dir}`, sha: g("rev-parse", "HEAD"), dir };
}

export interface FakeHubState {
  jobs: ClaimedJob[];
  uploads: { id: string; sha256: string; body: Buffer; auth: string | undefined }[];
  fails: (FailReport & { id: string })[];
  heartbeats: { id: string; stage: string }[];
  /** 生存の連絡に「続けない」と返す */
  cancelOnHeartbeat: boolean;
  /** 次の N 回の提出・受け取りを 500 にする */
  uploadErrors: number;
  claimErrors: number;
  down: boolean;
}

/** テスト用の Hub（Builder API だけを持つ） */
export async function fakeHub(): Promise<{ url: string; state: FakeHubState; close: () => Promise<void> }> {
  const state: FakeHubState = { jobs: [], uploads: [], fails: [], heartbeats: [], cancelOnHeartbeat: false, uploadErrors: 0, claimErrors: 0, down: false };
  const read = (req: IncomingMessage) =>
    new Promise<Buffer>((res) => {
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", () => res(Buffer.concat(chunks)));
    });
  const server: Server = createServer(async (req, res) => {
    const body = await read(req);
    const send = (status: number, v?: unknown) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(v === undefined ? undefined : JSON.stringify(v));
    };
    if (state.down) return send(503, { error: "down" });
    if (req.headers.authorization !== "Bearer upb_b_test-token-123") return send(401, {});
    const url = req.url ?? "";
    if (url === "/v1/builder/claim") {
      if (state.claimErrors > 0) return state.claimErrors--, send(500, {});
      const job = state.jobs.shift();
      return job ? send(200, job) : send(204);
    }
    const m = /^\/v1\/builder\/jobs\/([^/]+)\/(heartbeat|artifact|fail)$/.exec(url);
    if (!m) return send(404, {});
    const id = m[1]!;
    if (m[2] === "heartbeat") {
      state.heartbeats.push({ id, stage: JSON.parse(body.toString()).stage });
      return send(200, { continue: !state.cancelOnHeartbeat });
    }
    if (m[2] === "fail") {
      state.fails.push({ id, ...(JSON.parse(body.toString()) as FailReport) });
      return send(200, { ok: true });
    }
    if (state.uploadErrors > 0) return state.uploadErrors--, send(500, {});
    const sha = createHash("sha256").update(body).digest("hex");
    if (sha !== req.headers["x-upbeater-sha256"] || Number(req.headers["content-length"]) !== body.length) return send(400, { error: "sha256_mismatch" });
    state.uploads.push({ id, sha256: sha, body, auth: req.headers.authorization });
    return send(201, { ok: true });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const addr = server.address() as { port: number };
  return { url: `http://127.0.0.1:${addr.port}`, state, close: () => new Promise((r) => server.close(() => r())) };
}

export function job(repo: { url: string; sha: string }, steps: Partial<BuildSteps>, extra: Partial<ClaimedJob["source"]> = {}): ClaimedJob {
  return {
    job: { id: crypto.randomUUID(), app_id: "app1", app_name: "Widget", kind: "build", seq: 3, commit_sha: repo.sha, os: "linux", attempt: 1, lease_ms: 600_000 },
    source: { clone_url: repo.url, auth_header: null, ...extra },
    steps: { requires: [], build: [], artifact: ".", timeout_minutes: 60, ...steps },
  };
}
