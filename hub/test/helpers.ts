import { env, runDurableObjectAlarm, runInDurableObject, SELF } from "cloudflare:test";
import { hmacSha256, toHex } from "../src/crypto";

export const ORIGIN = "https://hub.test";
const MOCK = "https://github-mock.test";

/** 40 桁のコミット SHA を作る */
export function sha(n: number | string): string {
  return toHex(new TextEncoder().encode(String(n).padStart(20, "0"))).slice(0, 40);
}

export const mock = {
  async setHead(repo: string, branch: string, commit: string | null) {
    await env.GITHUB_API!.fetch(`${MOCK}/__mock/branch`, { method: "POST", body: JSON.stringify({ repo, branch, sha: commit }) });
  },
  async fail(count: number, status: number, headers: Record<string, string> = {}) {
    await env.GITHUB_API!.fetch(`${MOCK}/__mock/fail`, { method: "POST", body: JSON.stringify({ count, status, headers }) });
  },
  async delay(ms: number) {
    await env.GITHUB_API!.fetch(`${MOCK}/__mock/delay`, { method: "POST", body: JSON.stringify({ ms }) });
  },
  async calls(): Promise<number> {
    const r = await env.GITHUB_API!.fetch(`${MOCK}/__mock/calls`);
    return ((await r.json()) as { calls: number }).calls;
  },
};

let deliverySeq = 0;
export async function sendWebhook(
  payload: unknown,
  opts: { event?: string; delivery?: string; secret?: string; signature?: string | null; rawBody?: string } = {},
): Promise<Response> {
  const body = opts.rawBody ?? JSON.stringify(payload);
  const headers: Record<string, string> = {
    "content-type": "application/json",
    "x-github-event": opts.event ?? "push",
    "x-github-delivery": opts.delivery ?? `delivery-${Date.now()}-${++deliverySeq}`,
  };
  const sig = opts.signature === undefined ? "sha256=" + toHex(await hmacSha256(opts.secret ?? "test-webhook-secret", body)) : opts.signature;
  if (sig !== null) headers["x-hub-signature-256"] = sig;
  return SELF.fetch(`${ORIGIN}/webhook/github`, { method: "POST", headers, body });
}

export function pushPayload(repo: string, branch: string, after: string) {
  return { ref: `refs/heads/${branch}`, after, repository: { full_name: repo } };
}

export async function admin(method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<Response> {
  const isBinary = body instanceof Uint8Array;
  return SELF.fetch(`${ORIGIN}${path}`, {
    method,
    headers: { authorization: "Bearer test-admin-token", ...(isBinary ? {} : { "content-type": "application/json" }), ...headers },
    body: body === undefined ? undefined : isBinary ? body : JSON.stringify(body),
  });
}

export async function createApp(opts: { id?: string; owner?: string; repo?: string; branch?: string; os?: string[] } = {}) {
  const id = opts.id ?? "app1";
  const res = await admin("POST", "/v1/admin/apps", {
    id,
    owner_id: opts.owner ?? "owner1",
    name: id,
    repo: opts.repo ?? "Example/Repo",
    branch: opts.branch ?? "main",
    kind: "build",
    target_os: opts.os ?? ["android", "linux"],
  });
  if (res.status !== 201) throw new Error(`アプリの登録に失敗：${res.status} ${await res.text()}`);
  return id;
}

export async function versions(appId: string) {
  const r = await env.DB.prepare("SELECT seq, commit_sha, source FROM app_versions WHERE app_id = ? ORDER BY seq").bind(appId).all<{
    seq: number;
    commit_sha: string;
    source: string;
  }>();
  return r.results;
}

export function coordinator(appId: string) {
  return env.APP_COORDINATOR.get(env.APP_COORDINATOR.idFromName(appId));
}

export async function runAlarm(appId: string): Promise<boolean> {
  return runDurableObjectAlarm(coordinator(appId));
}

export async function coordinatorState(appId: string) {
  return runInDurableObject(coordinator(appId), async (_i, state) => ({
    alarm: await state.storage.getAlarm(),
    attempt: (await state.storage.get<number>("attempt")) ?? 0,
    blockedUntil: (await state.storage.get<number>("blocked_until")) ?? 0,
    dirty: (await state.storage.get<boolean>("dirty")) ?? false,
  }));
}

export async function registerDevice(owner = "owner1", os = "android") {
  const codeRes = await admin("POST", "/v1/admin/registration-codes", { owner_id: owner });
  const { code } = (await codeRes.json()) as { code: string };
  const res = await SELF.fetch(`${ORIGIN}/v1/devices/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ code, name: "端末", os }),
  });
  if (res.status !== 201) throw new Error(`端末の登録に失敗：${res.status}`);
  return (await res.json()) as { device_id: string; token: string };
}

export async function deviceCall(token: string, path: string, body: unknown): Promise<Response> {
  return SELF.fetch(`${ORIGIN}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });
}

export async function upload(appId: string, seq: number, os: string, bytes: Uint8Array) {
  const res = await admin("PUT", `/v1/admin/apps/${appId}/versions/${seq}/artifacts/${os}`, bytes);
  if (res.status !== 201) throw new Error(`成果物の登録に失敗：${res.status} ${await res.text()}`);
  return (await res.json()) as { id: string; sha256: string; size: number };
}

/** Webhook を送り、アプリの照合が終わるまで待つ */
export async function pushAndSync(appId: string, repo: string, branch: string, commit: string) {
  await mock.setHead(repo, branch, commit);
  const res = await sendWebhook(pushPayload(repo, branch, commit));
  if (res.status !== 202) throw new Error(`Webhook の受信に失敗：${res.status}`);
  return (await res.json()) as { outcomes: Record<string, string> };
}
