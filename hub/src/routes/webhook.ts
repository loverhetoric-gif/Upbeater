/** POST /webhook/github */
import { requestAppSync, type CoordinatorOutcome } from "../coordinator";
import { verifyGitHubSignature } from "../crypto";
import type { Env } from "../env";
import { json } from "../http";

const MAX_BODY = 25 * 1024 * 1024; // GitHub の上限

export async function handleGitHubWebhook(req: Request, env: Env): Promise<Response> {
  if (!env.WEBHOOK_SECRET) return json({ error: "webhook_not_configured" }, 503); // 設定が無ければ受け付けない（安全側）

  const len = Number(req.headers.get("content-length") ?? "0");
  if (len > MAX_BODY) return json({ error: "payload_too_large" }, 413);
  const raw = new Uint8Array(await req.arrayBuffer());
  if (raw.byteLength > MAX_BODY) return json({ error: "payload_too_large" }, 413);

  // 署名の検証は本文の解釈より前に行う
  if (!(await verifyGitHubSignature(env.WEBHOOK_SECRET, raw, req.headers.get("x-hub-signature-256")))) {
    return json({ error: "invalid_signature" }, 401);
  }

  const event = req.headers.get("x-github-event") ?? "";
  const delivery = req.headers.get("x-github-delivery") ?? "";
  if (!delivery || delivery.length > 128) return json({ error: "missing_delivery_id" }, 400);
  if (event === "ping") return json({ ok: true, event });

  let payload: { ref?: unknown; repository?: { full_name?: unknown } };
  try {
    payload = JSON.parse(new TextDecoder().decode(raw)) as typeof payload;
  } catch {
    return json({ error: "invalid_json" }, 400);
  }

  // 配信 ID で重複を捨てる（先に記録した方だけが処理する）
  const now = Date.now();
  const ins = await env.DB.prepare(
    "INSERT OR IGNORE INTO webhook_deliveries (delivery_id, owner_id, event, received_at) VALUES (?, '', ?, ?)",
  )
    .bind(delivery, event, now)
    .run();
  if ((ins.meta.changes ?? 0) === 0) return json({ ok: true, duplicate: true });

  if (event !== "push") return json({ ok: true, ignored: "event" }, 202);

  const repo = typeof payload.repository?.full_name === "string" ? payload.repository.full_name.toLowerCase() : "";
  const ref = typeof payload.ref === "string" ? payload.ref : "";
  if (!repo || !ref.startsWith("refs/heads/")) return json({ ok: true, ignored: "ref" }, 202);
  const branch = ref.slice("refs/heads/".length);

  // 登録済みアプリの対象ブランチだけを扱う。push の中身（after 等）は判断に使わない
  const apps = await env.DB.prepare("SELECT id, owner_id FROM apps WHERE repo_full_name = ? AND branch = ?")
    .bind(repo, branch)
    .all<{ id: string; owner_id: string }>();
  if (apps.results.length === 0) return json({ ok: true, ignored: "not_registered" }, 202);

  await env.DB.prepare("UPDATE webhook_deliveries SET owner_id = ? WHERE delivery_id = ?")
    .bind(apps.results[0]!.owner_id, delivery)
    .run();

  const outcomes: Record<string, CoordinatorOutcome["status"]> = {};
  try {
    for (const app of apps.results) outcomes[app.id] = (await requestAppSync(env, app.id, "webhook")).status;
  } catch {
    // 受け付けに失敗したら記録を消し、GitHub の再送で処理できるようにする（巡回でも回復する）
    await env.DB.prepare("DELETE FROM webhook_deliveries WHERE delivery_id = ?").bind(delivery).run();
    return json({ error: "temporarily_unavailable" }, 503);
  }
  return json({ ok: true, outcomes }, 202);
}
