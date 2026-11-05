/** POST /webhook/github：push・pull_request・delete を受ける */
import { coordinatorCall, type EventOutcome } from "../coordinator";
import { createGitHubClient, parseRepo, type GitHubClient } from "../github";
import { verifyGitHubSignature } from "../crypto";
import type { Env, RepoRow } from "../env";
import { json } from "../http";
import { recordOperation } from "../operations";
import type { EventInfo } from "../runs";

const MAX_BODY = 25 * 1024 * 1024;

interface Payload {
  ref?: string;
  ref_type?: string;
  after?: string;
  deleted?: boolean;
  action?: string;
  sender?: { login?: string; type?: string };
  pusher?: { name?: string };
  repository?: { full_name?: string };
  commits?: { added?: string[]; modified?: string[]; removed?: string[] }[];
  pull_request?: { number?: number; head?: { sha?: string; ref?: string; repo?: { full_name?: string } | null }; base?: { ref?: string; repo?: { full_name?: string } } };
}

/** Webhook の中身を合図にする。扱わないものは null */
export function toEvent(event: string, p: Payload): { info: Omit<EventInfo, "sha"> & { sha: string | null }; useDefaultBranch: boolean } | null {
  const actor = p.sender?.login ?? null;
  if (event === "push") {
    if (p.deleted || !p.after || /^0+$/.test(p.after)) return null; // ブランチの削除は delete で扱う
    const ref = p.ref ?? "";
    const branch = ref.startsWith("refs/heads/") ? ref.slice(11) : null;
    const tag = ref.startsWith("refs/tags/") ? ref.slice(10) : null;
    if (!branch && !tag) return null;
    // 変更されたファイル（paths の絞り込みに使う。多すぎて省略されている場合は絞り込まない）
    const commits = p.commits ?? [];
    const changed = commits.length > 0 && commits.length < 2048 ? [...new Set(commits.flatMap((c) => [...(c.added ?? []), ...(c.modified ?? []), ...(c.removed ?? [])]))] : undefined;
    return { info: { kind: "push", ref, branch, tag, sha: p.after, actor, isFork: false, ...(changed ? { changedFiles: changed } : {}) }, useDefaultBranch: false };
  }
  if (event === "pull_request") {
    if (!["opened", "synchronize", "reopened"].includes(p.action ?? "")) return null;
    const pr = p.pull_request;
    const sha = pr?.head?.sha;
    if (!sha) return null;
    // フォークからの PR：秘密情報を渡さない
    const isFork = (pr?.head?.repo?.full_name ?? "").toLowerCase() !== (pr?.base?.repo?.full_name ?? p.repository?.full_name ?? "").toLowerCase();
    return { info: { kind: "pull_request", ref: `refs/pull/${pr?.head?.ref ?? ""}`, branch: pr?.base?.ref ?? null, sha, actor, isFork }, useDefaultBranch: false };
  }
  if (event === "delete") {
    if (p.ref_type !== "branch" || !p.ref) return null;
    return { info: { kind: "delete", ref: `refs/heads/${p.ref}`, branch: p.ref, sha: null, actor, isFork: false }, useDefaultBranch: true };
  }
  return null;
}

export function isOwnCommit(env: Env, p: Payload): boolean {
  const bot = (env.UPBEATER_BOT_LOGIN ?? "upbeater[bot]").toLowerCase();
  return (p.sender?.login ?? "").toLowerCase() === bot || (p.pusher?.name ?? "").toLowerCase() === bot;
}

/**
 * Upbeater 自身の書き込みのうち、利用者が MCP で依頼したもの（コミット・PR）か。
 * マージの push はマージの SHA の記録より先に届くことがあるため、コミットに対応する PR でも確かめる
 */
export async function isRequestedChange(env: Env, full: string, event: string, p: Payload, gh: GitHubClient = createGitHubClient(env)): Promise<boolean> {
  const has = async (kind: "commit" | "pull", value: string) =>
    !!(await env.DB.prepare("SELECT 1 FROM requested_refs WHERE repo_full_name = ? AND kind = ? AND value = ?").bind(full, kind, value).first());
  if (event === "pull_request") {
    const n = p.pull_request?.number;
    return (typeof n === "number" && (await has("pull", String(n)))) || (!!p.pull_request?.head?.sha && (await has("commit", p.pull_request.head.sha)));
  }
  if (event !== "push" || !p.after) return false;
  if (await has("commit", p.after)) return true;
  try {
    for (const n of await gh.listCommitPulls(parseRepo(full), p.after)) if (await has("pull", String(n))) return true;
  } catch {
    // GitHub に聞けない時は合図にしない（無限の連鎖を防ぐ側に倒す）
  }
  return false;
}

export async function handleGitHubWebhook(req: Request, env: Env): Promise<Response> {
  if (!env.WEBHOOK_SECRET) return json({ error: "webhook_not_configured" }, 503);
  const len = Number(req.headers.get("content-length") ?? "0");
  if (len > MAX_BODY) return json({ error: "payload_too_large" }, 413);
  const raw = new Uint8Array(await req.arrayBuffer());
  if (raw.byteLength > MAX_BODY) return json({ error: "payload_too_large" }, 413);
  // 署名の検証は本文の解釈より前（定数時間で比較）
  if (!(await verifyGitHubSignature(env.WEBHOOK_SECRET, raw, req.headers.get("x-hub-signature-256")))) return json({ error: "invalid_signature" }, 401);

  const event = req.headers.get("x-github-event") ?? "";
  const delivery = req.headers.get("x-github-delivery") ?? "";
  if (!delivery || delivery.length > 128) return json({ error: "missing_delivery_id" }, 400);
  if (event === "ping") return json({ ok: true, event });

  let payload: Payload;
  try {
    payload = JSON.parse(new TextDecoder().decode(raw)) as Payload;
  } catch {
    return json({ error: "invalid_json" }, 400);
  }
  const ins = await env.DB.prepare("INSERT OR IGNORE INTO webhook_deliveries (delivery_id, owner_id, event, received_at) VALUES (?, '', ?, ?)")
    .bind(delivery, event, Date.now())
    .run();
  if ((ins.meta.changes ?? 0) === 0) return json({ ok: true, duplicate: true });

  const ev = toEvent(event, payload);
  if (!ev) return json({ ok: true, ignored: "event" }, 202);
  const full = (payload.repository?.full_name ?? "").toLowerCase();
  const repos = (await env.DB.prepare("SELECT * FROM repos WHERE full_name = ?").bind(full).all<RepoRow>()).results;
  if (repos.length === 0) return json({ ok: true, ignored: "not_registered" }, 202);
  await env.DB.prepare("UPDATE webhook_deliveries SET owner_id = ? WHERE delivery_id = ?").bind(repos[0]!.owner_id, delivery).run();

  const outcomes: Record<string, EventOutcome["status"]> = {};
  try {
    for (const repo of repos) {
      // 無限の連鎖を防ぐ：Upbeater 自身のコミットは、設定しない限り合図にしない
      if (isOwnCommit(env, payload) && !repo.trigger_on_own_commits && !(await isRequestedChange(env, full, event, payload))) {
        await recordOperation(env, { owner_id: repo.owner_id, repo_id: repo.id, kind: "event", stage: "own_commit", status: "ok", reason: "Upbeater 自身のコミットのため合図にしません" });
        // 定期照合が「取りこぼし」として拾わないよう、処理済みにしておく
        if (event === "push" && ev.info.branch === repo.default_branch && ev.info.sha) {
          await env.DB.prepare("UPDATE repos SET last_seen_sha = ? WHERE id = ?").bind(ev.info.sha, repo.id).run();
        }
        outcomes[repo.id] = "skipped";
        continue;
      }
      const r = await coordinatorCall<EventOutcome>(env, repo.id, "/event", { event: ev.info, useDefaultBranch: ev.useDefaultBranch });
      outcomes[repo.id] = r.status;
    }
  } catch {
    // 受け付けに失敗したら記録を消し、GitHub の再送で処理できるようにする（定期照合でも回復する）
    await env.DB.prepare("DELETE FROM webhook_deliveries WHERE delivery_id = ?").bind(delivery).run();
    return json({ error: "temporarily_unavailable" }, 503);
  }
  return json({ ok: true, outcomes }, 202);
}
