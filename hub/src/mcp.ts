/**
 * MCP サーバー（Streamable HTTP、JSON 応答のみ、状態を持たない）
 * POST /mcp に JSON-RPC 2.0 を受ける。認証は OAuth のアクセストークン（Bearer）
 */
import type { Env } from "./env";
import { HttpError, json } from "./http";
import { authenticateMcp, cors } from "./oauth";
import { callTool, InvalidParams, TOOLS } from "./tools";

export const SUPPORTED_PROTOCOL_VERSIONS = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"];
const SERVER_INFO = { name: "upbeater", title: "Upbeater", version: "0.4.0" };
const INSTRUCTIONS =
  "Upbeater は GitHub Actions の代わりに、各リポジトリの .upbeater/*.yml の自動処理（検査・ビルド・公開）を自前の Runner で実行する。" +
  "実行の状況は list_runs・get_run・get_logs で確かめ、失敗したら rerun で再実行する。Actions の定義は migrate_workflows で変換して PR にできる。" +
  "GitHub の変更は ship_change で一続きに反映でき、失敗したら同じ request_id で呼び直すと失敗した段階から続く。ただし短い時間に何度も PR の作成・マージをしない（手元でテストを通し、変更をまとめて 1 回で反映する）。" +
  "秘密情報の値はチャットに書かせず、request_secrets の入力ページで利用者に入れてもらう。人の判断が要る失敗は list_operations の needs_human_only で確かめられる。";

interface RpcRequest {
  jsonrpc?: unknown;
  id?: unknown;
  method?: unknown;
  params?: unknown;
}

const DEFAULT_ALLOWED_ORIGINS = ["https://claude.ai", "https://claude.com"];

function rpcError(id: unknown, code: number, message: string) {
  return { jsonrpc: "2.0", id: id ?? null, error: { code, message } };
}

function unauthorized(origin: string, error: string): Response {
  return json({ error }, 401, {
    ...cors(),
    "www-authenticate": `Bearer realm="upbeater", error="${error}", resource_metadata="${origin}/.well-known/oauth-protected-resource/mcp"`,
  });
}

async function handleOne(env: Env, owner: string, origin: string, msg: RpcRequest): Promise<object | null> {
  const isNotification = msg.id === undefined;
  if (msg.jsonrpc !== "2.0" || typeof msg.method !== "string") return isNotification ? null : rpcError(msg.id, -32600, "Invalid Request");
  if (isNotification) return null; // notifications/initialized など
  const params = (msg.params ?? {}) as Record<string, unknown>;
  try {
    switch (msg.method) {
      case "initialize": {
        const requested = typeof params.protocolVersion === "string" ? params.protocolVersion : "";
        const protocolVersion = SUPPORTED_PROTOCOL_VERSIONS.includes(requested) ? requested : SUPPORTED_PROTOCOL_VERSIONS[0];
        return { jsonrpc: "2.0", id: msg.id, result: { protocolVersion, capabilities: { tools: { listChanged: false } }, serverInfo: SERVER_INFO, instructions: INSTRUCTIONS } };
      }
      case "ping":
        return { jsonrpc: "2.0", id: msg.id, result: {} };
      case "tools/list":
        return {
          jsonrpc: "2.0",
          id: msg.id,
          result: { tools: TOOLS.map((t) => ({ name: t.name, title: t.title, description: t.description, inputSchema: t.inputSchema, ...(t.annotations ? { annotations: t.annotations } : {}) })) },
        };
      case "tools/call": {
        if (typeof params.name !== "string") return rpcError(msg.id, -32602, "name が必要です");
        const result = await callTool({ env, owner_id: owner, origin }, params.name, params.arguments);
        return {
          jsonrpc: "2.0",
          id: msg.id,
          result: { content: [{ type: "text", text: JSON.stringify(result, null, 2) }], structuredContent: result, isError: !result.ok },
        };
      }
      default:
        return rpcError(msg.id, -32601, `Method not found: ${msg.method}`);
    }
  } catch (e) {
    if (e instanceof InvalidParams) return rpcError(msg.id, -32602, e.message);
    console.error("MCP の処理に失敗", msg.method);
    return rpcError(msg.id, -32603, "Internal error");
  }
}

export async function handleMcp(req: Request, env: Env, origin: string): Promise<Response> {
  // DNS リバインディング対策：ブラウザからの呼び出しは許可した Origin だけ
  const reqOrigin = req.headers.get("origin");
  if (reqOrigin && reqOrigin !== origin && !DEFAULT_ALLOWED_ORIGINS.includes(reqOrigin)) return json({ error: "forbidden_origin" }, 403);
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors() });
  if (req.method !== "POST") return new Response(null, { status: 405, headers: { allow: "POST", ...cors() } });

  let owner: string;
  try {
    owner = await authenticateMcp(req, env);
  } catch (e) {
    return unauthorized(origin, e instanceof HttpError && e.code === "invalid_token" ? "invalid_token" : "invalid_request");
  }
  const pv = req.headers.get("mcp-protocol-version");
  if (pv && !SUPPORTED_PROTOCOL_VERSIONS.includes(pv)) return json(rpcError(null, -32600, `対応していないプロトコルの版：${pv}`), 400, cors());

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return json(rpcError(null, -32700, "Parse error"), 400, cors());
  }
  if (Array.isArray(body)) {
    if (body.length === 0) return json(rpcError(null, -32600, "Invalid Request"), 400, cors());
    const out = (await Promise.all(body.map((m) => handleOne(env, owner, origin, m as RpcRequest)))).filter(Boolean);
    return out.length ? json(out, 200, cors()) : new Response(null, { status: 202, headers: cors() });
  }
  const res = await handleOne(env, owner, origin, body as RpcRequest);
  return res ? json(res, 200, cors()) : new Response(null, { status: 202, headers: cors() });
}
