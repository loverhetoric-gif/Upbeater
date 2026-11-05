/** Upbeater Hub の入口 */
import { AppCoordinator, requestAppSync } from "./coordinator";
import type { Env } from "./env";
import { errorResponse, HttpError, json } from "./http";
import { parseRevoked, parseSigningKeys, publicKeys } from "./manifest";
import { handleMcp } from "./mcp";
import {
  authorizationServerMetadata,
  cors,
  handleAuthorize,
  handleConsent,
  handleGitHubCallback,
  handleRegisterClient,
  handleRevoke,
  handleToken,
  protectedResourceMetadata,
} from "./oauth";
import { handleCreateApp, handleCreateRegistrationCode, handlePutArtifact, requireAdmin } from "./routes/admin";
import { handleArtifact } from "./routes/artifacts";
import { handleCheck, handleRegister, handleReport } from "./routes/devices";
import { handleGitHubWebhook } from "./routes/webhook";

export { AppCoordinator };

/** 受信記録の保持期間（GitHub の再送はこれより短い） */
const DELIVERY_RETENTION_MS = 7 * 24 * 3600_000;
const CRON_CONCURRENCY = 5;

async function route(req: Request, env: Env): Promise<Response> {
  const url = new URL(req.url);
  const p = url.pathname;
  const m = req.method;

  if (p === "/webhook/github" && m === "POST") return handleGitHubWebhook(req, env);

  // MCP と OAuth
  if (p === "/mcp") return handleMcp(req, env, url.origin);
  if (m === "OPTIONS" && (p.startsWith("/.well-known/") || p.startsWith("/oauth/"))) return new Response(null, { status: 204, headers: cors() });
  if (m === "GET" && (p === "/.well-known/oauth-protected-resource" || p === "/.well-known/oauth-protected-resource/mcp")) {
    return protectedResourceMetadata(url.origin);
  }
  if (m === "GET" && (p === "/.well-known/oauth-authorization-server" || p === "/.well-known/oauth-authorization-server/mcp")) {
    return authorizationServerMetadata(url.origin);
  }
  if (p === "/oauth/register" && m === "POST") return handleRegisterClient(req, env);
  if (p === "/oauth/authorize" && m === "GET") return handleAuthorize(req, env, url.origin);
  if (p === "/oauth/github/callback" && m === "GET") return handleGitHubCallback(req, env, url.origin);
  if (p === "/oauth/consent" && m === "POST") return handleConsent(req, env, url.origin);
  if (p === "/oauth/token" && m === "POST") return handleToken(req, env);
  if (p === "/oauth/revoke" && m === "POST") return handleRevoke(req, env);
  if (p === "/v1/devices/register" && m === "POST") return handleRegister(req, env);
  if (p === "/v1/devices/check" && m === "POST") return handleCheck(req, env, url.origin);
  if (p === "/v1/devices/report" && m === "POST") return handleReport(req, env);

  const art = /^\/v1\/artifacts\/([0-9a-f-]{36})$/.exec(p);
  if (art && (m === "GET" || m === "HEAD")) return handleArtifact(req, env, art[1]!);

  if (p === "/v1/keys" && m === "GET") {
    const keys = parseSigningKeys(env.MANIFEST_SIGNING_KEYS);
    const revoked = parseRevoked(env.MANIFEST_REVOKED_GENERATIONS);
    return json({ active: keys.active, keys: publicKeys(keys, revoked) });
  }

  if (p.startsWith("/v1/admin/")) {
    await requireAdmin(req, env);
    if (p === "/v1/admin/apps" && m === "POST") return handleCreateApp(req, env);
    if (p === "/v1/admin/registration-codes" && m === "POST") return handleCreateRegistrationCode(req, env);
    const put = /^\/v1\/admin\/apps\/([A-Za-z0-9_-]{1,64})\/versions\/(\d+)\/artifacts\/(android|ios|macos|linux)$/.exec(p);
    if (put && m === "PUT") return handlePutArtifact(req, env, put[1]!, put[2]!, put[3]!);
  }

  if (p === "/health") return json({ ok: true });
  throw new HttpError(404, "not_found");
}

/** 巡回：全アプリの対象ブランチを照合する（Webhook の取りこぼし対策） */
export async function sweepAllApps(env: Env): Promise<Record<string, string>> {
  const apps = await env.DB.prepare("SELECT id FROM apps ORDER BY id").all<{ id: string }>();
  const ids = apps.results.map((a) => a.id);
  const out: Record<string, string> = {};
  let next = 0;
  const worker = async () => {
    while (next < ids.length) {
      const id = ids[next++]!;
      try {
        out[id] = (await requestAppSync(env, id, "cron")).status;
      } catch {
        out[id] = "error"; // 1 件の失敗で巡回全体を止めない
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(CRON_CONCURRENCY, ids.length) }, worker));
  const now = Date.now();
  await env.DB.batch([
    env.DB.prepare("DELETE FROM webhook_deliveries WHERE received_at < ?").bind(now - DELIVERY_RETENTION_MS),
    // 期限を過ぎた認可の途中経過・コード・トークンを片付ける（コードは再使用の検知のため 1 日残す）
    env.DB.prepare("DELETE FROM oauth_requests WHERE expires_at < ?").bind(now),
    env.DB.prepare("DELETE FROM oauth_codes WHERE expires_at < ?").bind(now - 24 * 3600_000),
    env.DB.prepare("DELETE FROM oauth_tokens WHERE expires_at < ?").bind(now - 24 * 3600_000),
  ]);
  return out;
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    try {
      return await route(req, env);
    } catch (e) {
      return errorResponse(e);
    }
  },
  async scheduled(_controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(sweepAllApps(env));
  },
} satisfies ExportedHandler<Env>;
