import { env, runInDurableObject, SELF } from "cloudflare:test";
import { hmacSha256, toHex } from "../src/crypto";
import worker from "../src/index";
import { createExecutionContext, createScheduledController, waitOnExecutionContext } from "cloudflare:test";

export const ORIGIN = "https://hub.test";
const MOCK = "https://github-mock.test";
export const OWNER = "owner1";
export const REPO = "acme/widget";

let n = 0;
/** 40 桁のコミット SHA */
export const sha = (label: string | number) => toHex(new TextEncoder().encode(`c-${label}`.padEnd(20, "."))).slice(0, 40);

export async function mock(path: string, body: unknown = {}): Promise<any> {
  const r = await env.GITHUB_API!.fetch(`${MOCK}/__mock/${path}`, { method: "POST", body: JSON.stringify(body) });
  return r.json();
}

/** 模擬 GitHub にコミット（定義ファイル）を置く */
export async function commit(label: string, files: Record<string, string>, opts: { branch?: string | null; repo?: string } = {}) {
  const s = sha(label);
  await mock("commit", { repo: opts.repo ?? REPO, branch: opts.branch === undefined ? "main" : opts.branch, sha: s, files });
  return s;
}

export async function admin(method: string, path: string, body?: unknown): Promise<Response> {
  return SELF.fetch(`${ORIGIN}${path}`, {
    method,
    headers: { authorization: "Bearer test-admin-token", "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

export async function registerRepo(opts: { repo?: string; trigger_on_own_commits?: boolean } = {}): Promise<string> {
  const r = await admin("POST", "/v1/admin/repos", { owner_id: OWNER, repo: opts.repo ?? REPO, ...(opts.trigger_on_own_commits ? { trigger_on_own_commits: true } : {}) });
  if (r.status !== 201) throw new Error(`登録に失敗：${r.status} ${await r.text()}`);
  return ((await r.json()) as { id: string }).id;
}

export async function webhook(event: string, payload: unknown, opts: { delivery?: string; secret?: string; signature?: string | null } = {}): Promise<Response> {
  const body = JSON.stringify(payload);
  const headers: Record<string, string> = { "content-type": "application/json", "x-github-event": event, "x-github-delivery": opts.delivery ?? `d-${Date.now()}-${++n}` };
  const sig = opts.signature === undefined ? "sha256=" + toHex(await hmacSha256(opts.secret ?? "test-webhook-secret", body)) : opts.signature;
  if (sig !== null) headers["x-hub-signature-256"] = sig;
  return SELF.fetch(`${ORIGIN}/webhook/github`, { method: "POST", headers, body });
}

export function push(s: string, opts: { branch?: string; sender?: string; repo?: string; files?: string[] } = {}) {
  return {
    ref: `refs/heads/${opts.branch ?? "main"}`,
    after: s,
    repository: { full_name: opts.repo ?? REPO },
    sender: { login: opts.sender ?? "alice" },
    pusher: { name: opts.sender ?? "alice" },
    commits: opts.files ? [{ added: opts.files, modified: [], removed: [] }] : [],
  };
}

export function pullRequest(s: string, opts: { fork?: boolean; base?: string } = {}) {
  return {
    action: "opened",
    repository: { full_name: REPO },
    sender: { login: "bob" },
    pull_request: { head: { sha: s, ref: "feature", repo: { full_name: opts.fork ? "evil/widget" : REPO } }, base: { ref: opts.base ?? "main", repo: { full_name: REPO } } },
  };
}

/** push を送り、作られた run を返す */
export async function pushAndRun(label: string, files: Record<string, string>) {
  const s = await commit(label, files);
  const r = await webhook("push", push(s));
  return { sha: s, res: r, body: (await r.json()) as any };
}

export async function runs() {
  return (await env.DB.prepare("SELECT * FROM runs ORDER BY number").all<any>()).results;
}

export async function jobsOf(runId?: string) {
  const q = runId ? env.DB.prepare("SELECT * FROM jobs WHERE run_id = ? ORDER BY created_at").bind(runId) : env.DB.prepare("SELECT * FROM jobs ORDER BY created_at");
  return (await q.all<any>()).results;
}

export const statusMap = async (runId?: string) => Object.fromEntries((await jobsOf(runId)).map((j) => [j.name, j.status]));

/** Runner を登録してトークンを返す */
export async function registerRunner(labels: string[] = ["linux"], name = "runner-1"): Promise<string> {
  const { code } = (await (await admin("POST", "/v1/admin/runner-codes", { owner_id: OWNER })).json()) as { code: string };
  const r = await SELF.fetch(`${ORIGIN}/v1/runners/register`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ code, name, labels }) });
  if (r.status !== 201) throw new Error(`Runner の登録に失敗：${r.status}`);
  return ((await r.json()) as { token: string }).token;
}

export async function claim(token: string, labels?: string[]) {
  const r = await SELF.fetch(`${ORIGIN}/v1/runners/claim`, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify(labels ? { labels } : {}) });
  return { status: r.status, body: r.status === 204 ? null : ((await r.json()) as any) };
}

export async function jobCall(token: string, jobId: string, jobToken: string, what: string, body: unknown = {}) {
  const r = await SELF.fetch(`${ORIGIN}/v1/runners/jobs/${jobId}/${what}`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "x-upbeater-job-token": jobToken, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: r.status, body: (await r.json()) as any };
}

/** 受け取ったジョブを終える */
export async function finish(token: string, claimed: any, conclusion: "success" | "failure" | "cancelled" = "success") {
  return jobCall(token, claimed.job.id, claimed.job_token, "complete", { conclusion, last_seq: 0 });
}

export async function runCronAt(now?: number) {
  const { runCron } = await import("../src/scheduled");
  await runCron(env, now);
}

export async function scheduledHandler() {
  const ctx = createExecutionContext();
  await worker.scheduled(createScheduledController({ cron: "* * * * *" }), env, ctx);
  await waitOnExecutionContext(ctx);
}

export async function coordinatorStorage(repoId: string) {
  const stub = env.REPO_COORDINATOR.get(env.REPO_COORDINATOR.idFromName(repoId));
  return runInDurableObject(stub, async (_i, state) => ({ pending: (await state.storage.get<any[]>("pending")) ?? [], alarm: await state.storage.getAlarm() }));
}

export function coordinatorStub(repoId: string) {
  return env.REPO_COORDINATOR.get(env.REPO_COORDINATOR.idFromName(repoId));
}
