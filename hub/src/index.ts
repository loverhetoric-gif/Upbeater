/** Upbeater Hub の入口（GitHub Actions の代替） */
import { RepoCoordinator } from "./coordinator";
import type { Env } from "./env";
import { errorResponse, HttpError, json } from "./http";
import { parseRevoked, parseSigningKeys, publicKeys } from "./manifest";
import { handleAdmin } from "./routes/admin";
import { handleBlob } from "./routes/blobs";
import { handleClaim, handleComplete, handleHeartbeat, handleLogs, handleRegisterRunner, handleStep } from "./routes/runner";
import { handleSecretForm } from "./routes/secret-form";
import { handleGitHubWebhook } from "./routes/webhook";
import { handleMcp } from "./mcp";
import { authorizationServerMetadata, cors, handleAuthorize, handleConsent, handleGitHubCallback, handleRegisterClient, handleRevoke, handleToken, protectedResourceMetadata } from "./oauth";
import { runCron } from "./scheduled";

export { RepoCoordinator };

async function route(req: Request, env: Env): Promise<Response> {
  const url = new URL(req.url);
  const p = url.pathname;
  const m = req.method;
  const origin = url.origin;
  if (p === "/webhook/github" && m === "POST") return handleGitHubWebhook(req, env);
  // MCP（claude.ai のコネクタ）と OAuth
  if (p === "/mcp") return handleMcp(req, env, origin);
  if (p === "/.well-known/oauth-protected-resource" || p === "/.well-known/oauth-protected-resource/mcp") return protectedResourceMetadata(origin);
  if (p === "/.well-known/oauth-authorization-server" || p === "/.well-known/openid-configuration") return authorizationServerMetadata(origin);
  if (p.startsWith("/oauth/") && m === "OPTIONS") return new Response(null, { status: 204, headers: cors() });
  if (p === "/oauth/register" && m === "POST") return handleRegisterClient(req, env);
  if (p === "/oauth/authorize" && m === "GET") return handleAuthorize(req, env, origin);
  if (p === "/oauth/github/callback" && m === "GET") return handleGitHubCallback(req, env, origin);
  if (p === "/oauth/consent" && m === "POST") return handleConsent(req, env, origin);
  if (p === "/oauth/token" && m === "POST") return handleToken(req, env);
  if (p === "/oauth/revoke" && m === "POST") return handleRevoke(req, env);
  if (p === "/v1/runners/register" && m === "POST") return handleRegisterRunner(req, env);
  if (p === "/v1/runners/claim" && m === "POST") return handleClaim(req, env);
  const j = /^\/v1\/runners\/jobs\/([0-9a-f-]{36})\/(heartbeat|logs|steps|complete)$/.exec(p);
  if (j && m === "POST") {
    const id = j[1]!;
    if (j[2] === "heartbeat") return handleHeartbeat(req, env, id);
    if (j[2] === "logs") return handleLogs(req, env, id);
    if (j[2] === "steps") return handleStep(req, env, id);
    return handleComplete(req, env, id);
  }
  const b = /^\/v1\/runners\/jobs\/([0-9a-f-]{36})\/(artifacts|cache)\/([^/]+)$/.exec(p);
  if (b) return handleBlob(req, env, b[1]!, b[2] as "artifacts" | "cache", b[3]!);
  if (p.startsWith("/v1/admin/")) return handleAdmin(req, env, p);
  const sf = /^\/secret-form\/([^/]+)$/.exec(p);
  if (sf) return handleSecretForm(req, env, sf[1]!);
  if (p === "/v1/keys" && m === "GET") {
    const keys = parseSigningKeys(env.MANIFEST_SIGNING_KEYS);
    const revoked = parseRevoked(env.MANIFEST_REVOKED_GENERATIONS);
    return json({ active: keys.active, keys: publicKeys(keys, revoked) });
  }
  if (p === "/health") return json({ ok: true });
  throw new HttpError(404, "not_found");
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    try {
      return await route(req, env);
    } catch (e) {
      return errorResponse(e);
    }
  },
  async scheduled(_c: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(runCron(env));
  },
} satisfies ExportedHandler<Env>;
