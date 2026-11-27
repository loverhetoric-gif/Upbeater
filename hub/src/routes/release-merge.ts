/**
 * POST /v1/release-merge
 * 外部の承認の仕組み（WORLD ruler. の release）が、承認後にマージを依頼する受け口。
 * - 認証は MCP と同じ（接続用トークン upb_m_ か OAuth の upb_at_）
 * - 本体は {repo, number, request_id}。登録済みのリポジトリだけを、mergePrOp で request_id 付きに実行する
 * - 同じ request_id の再依頼は、完了済みなら完了済みの結果を返す（二重にマージしない）
 * - 答えは {ok:true, merged:true, note?} か {ok:false, reason}。値・トークンは出さない
 */
import type { Env } from "../env";
import { mergePrOp } from "../gitops";
import { createGitHubClient } from "../github";
import { HttpError, int, json, readJson, str } from "../http";
import { authenticateMcp } from "../oauth";

const REPO = /^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/;
const REQUEST_ID = /^[A-Za-z0-9:_.-]{1,100}$/;

export async function handleReleaseMerge(req: Request, env: Env): Promise<Response> {
  if (req.method !== "POST") return new Response(null, { status: 405, headers: { allow: "POST" } });
  let owner: string;
  try {
    owner = await authenticateMcp(req, env);
  } catch {
    return json({ ok: false, reason: "認証に失敗しました（接続用トークンを確かめてください）" }, 401);
  }
  let repo: string;
  let number: number;
  let requestId: string;
  try {
    const b = await readJson(req);
    repo = str(b.repo, "repo", { max: 201, pattern: REPO });
    number = int(b.number, "number", 1);
    requestId = str(b.request_id, "request_id", { max: 100, pattern: REQUEST_ID });
  } catch (e) {
    if (e instanceof HttpError) return json({ ok: false, reason: `依頼の内容が正しくありません：${e.message}` }, 400);
    throw e;
  }
  // 登録済みのリポジトリか（この利用者のもの）は mergePrOp が確かめる。request_id を必ず付けて渡す
  const r = await mergePrOp({ env, gh: createGitHubClient(env), owner_id: owner }, { repo, number, request_id: requestId });
  if (r.ok) {
    const note = r.duplicate ? "同じ依頼 ID の完了済みの結果を返しました" : r.resumed ? "前回止まった段階から続けて完了しました" : undefined;
    return json({ ok: true, merged: r.result.merged === true, ...(note ? { note } : {}) });
  }
  return json({ ok: false, merged: false, reason: r.reason, code: r.code, retryable: r.retryable, needs_human: r.needs_human });
}
