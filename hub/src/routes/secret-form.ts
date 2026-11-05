/**
 * 秘密情報の入力ページ（一回限り）。管理用トークンで発行し、利用者がスマホなどで値を入れる。
 *   POST /v1/admin/secret-forms   { owner_id, repo?, names: [...] } → { url, expires_at }（管理 API）
 *   GET  /secret-form/<鍵>         伏せ字の入力欄（登録済みかどうかだけを出す。値は出さない）
 *   POST /secret-form/<鍵>         入れた分を暗号化して保存し、ページを使えなくする
 * 鍵は 256 ビットの乱数で、Hub にはハッシュだけを置く。JavaScript は使わない。
 */
import { b64url, randomBytes, sha256Hex } from "../crypto";
import type { Env } from "../env";
import { HttpError, json, str } from "../http";
import { putSecret } from "../secrets";

export const FORM_TTL_MS = 30 * 60_000;
const NAME = /^[A-Z_][A-Z0-9_]{0,99}$/;
const MAX_VALUE = 64 * 1024;
const MAX_NAMES = 30;

interface FormRow {
  token_hash: string;
  owner_id: string;
  repo_id: string;
  names: string;
  expires_at: number;
  used_at: number | null;
}

/** 管理 API：入力ページを発行する */
export async function createSecretForm(env: Env, origin: string, owner: string, repoId: string, names: unknown, now = Date.now()): Promise<Response> {
  if (!Array.isArray(names) || names.length === 0 || names.length > MAX_NAMES) throw new HttpError(400, "invalid_names", `names は 1〜${MAX_NAMES} 個の名前の並びです`);
  const list = [...new Set(names.map((n) => str(n, "names", { pattern: NAME })))];
  const token = b64url(randomBytes(32));
  const expiresAt = now + FORM_TTL_MS;
  await env.DB.batch([
    env.DB.prepare("DELETE FROM secret_forms WHERE expires_at < ?").bind(now - 24 * 60 * 60_000),
    env.DB.prepare("INSERT INTO secret_forms (token_hash, owner_id, repo_id, names, expires_at, created_at) VALUES (?, ?, ?, ?, ?, ?)").bind(
      await sha256Hex("secret-form." + token),
      owner,
      repoId,
      JSON.stringify(list),
      expiresAt,
      now,
    ),
  ]);
  return json({ url: `${origin}/secret-form/${token}`, expires_at: expiresAt, names: list }, 201);
}

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

function page(title: string, body: string, status = 200): Response {
  const html = `<!doctype html>
<html lang="ja"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex"><title>${esc(title)}｜Upbeater</title>
<style>
:root{--bg:#f6f7f9;--card:#fff;--text:#1c1f24;--sub:#5b6370;--line:#d9dde3;--accent:#2457d6;--ok:#1d7a46;--warn:#a15c00}
@media (prefers-color-scheme:dark){:root{--bg:#121417;--card:#1c1f24;--text:#eceef1;--sub:#a2a9b4;--line:#333840;--accent:#7aa2ff;--ok:#5cc98a;--warn:#f0b060}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text);font:16px/1.6 -apple-system,BlinkMacSystemFont,"Hiragino Sans","Noto Sans JP",sans-serif}
main{max-width:560px;margin:0 auto;padding:24px 16px 48px}h1{font-size:1.25rem;margin:0 0 4px}p{margin:8px 0;color:var(--sub)}
.card{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:16px;margin:16px 0}
label{display:block;font-weight:600;margin:16px 0 4px;word-break:break-all}label:first-child{margin-top:0}
.state{font-weight:400;font-size:.85rem;margin-left:6px}.set{color:var(--ok)}.unset{color:var(--warn)}
input[type=password]{width:100%;font-size:16px;padding:12px;border:1px solid var(--line);border-radius:8px;background:var(--bg);color:var(--text)}
button{width:100%;margin-top:20px;padding:14px;font-size:16px;font-weight:600;border:0;border-radius:10px;background:var(--accent);color:#fff}
ul{padding-left:1.2em}small{color:var(--sub)}
</style></head><body><main>${body}</main></body></html>`;
  return new Response(html, {
    status,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      "referrer-policy": "no-referrer",
      "x-content-type-options": "nosniff",
      "x-frame-options": "DENY",
      "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
    },
  });
}

const gone = () => page("使えないページ", `<h1>このページは使えません</h1><p>期限（30 分）が過ぎたか、もう送信済みです。必要なら、新しいページを発行してもらってください。</p>`, 410);

async function load(env: Env, token: string, now: number): Promise<FormRow | null> {
  if (!/^[A-Za-z0-9_-]{43}$/.test(token)) return null;
  const row = await env.DB.prepare("SELECT * FROM secret_forms WHERE token_hash = ?").bind(await sha256Hex("secret-form." + token)).first<FormRow>();
  if (!row || row.used_at !== null || row.expires_at <= now) return null;
  return row;
}

export async function handleSecretForm(req: Request, env: Env, token: string, now = Date.now()): Promise<Response> {
  const row = await load(env, token, now);
  if (!row) return gone();
  const names = JSON.parse(row.names) as string[];
  const repo = row.repo_id ? await env.DB.prepare("SELECT full_name FROM repos WHERE id = ?").bind(row.repo_id).first<{ full_name: string }>() : null;
  const where = repo ? `${repo.full_name} 専用` : "すべてのリポジトリ共通";

  if (req.method === "GET") {
    const set = await env.DB.prepare("SELECT name FROM secrets WHERE owner_id = ? AND repo_id = ? AND name IN (SELECT value FROM json_each(?))")
      .bind(row.owner_id, row.repo_id, row.names)
      .all<{ name: string }>();
    const have = new Set(set.results.map((r) => r.name));
    const fields = names
      .map(
        (n) =>
          `<label for="${n}">${n}<span class="state ${have.has(n) ? "set" : "unset"}">${have.has(n) ? "登録済み（空欄なら変えません）" : "未登録"}</span></label>` +
          `<input type="password" id="${n}" name="${n}" autocomplete="off" autocapitalize="off" spellcheck="false" maxlength="${MAX_VALUE}">`,
      )
      .join("");
    const left = Math.max(1, Math.round((row.expires_at - now) / 60_000));
    return page(
      "秘密情報の登録",
      `<h1>秘密情報の登録</h1><p>${esc(where)}。入れた値は暗号化して Upbeater の Hub に保存し、ジョブの実行時だけ使います。画面にもログにも出ません。</p>
<form method="post" class="card">${fields}<button type="submit">保存する</button></form>
<p><small>このページは一度だけ使えます（残り約 ${left} 分）。空欄の項目は変えません。</small></p>`,
    );
  }
  if (req.method !== "POST") throw new HttpError(405, "method_not_allowed");
  const len = Number(req.headers.get("content-length") ?? "0");
  if (len > MAX_NAMES * (MAX_VALUE + 200)) throw new HttpError(413, "too_large");
  const form = await req.formData();
  const saved: string[] = [];
  for (const n of names) {
    const v = form.get(n);
    if (typeof v !== "string" || v.length === 0) continue;
    if (v.length > MAX_VALUE) throw new HttpError(413, "too_large", `${n} の値が長すぎます`);
    // 貼り付けで付きやすい前後の空白・改行は落とす（値の途中は変えない）
    const value = v.trim();
    if (!value) continue;
    await putSecret(env, row.owner_id, row.repo_id, n, value);
    saved.push(n);
  }
  // 一度送ったら使えなくする（同時に送られても 1 度だけ）
  await env.DB.prepare("UPDATE secret_forms SET used_at = ? WHERE token_hash = ? AND used_at IS NULL").bind(now, row.token_hash).run();
  const skipped = names.filter((n) => !saved.includes(n));
  return page(
    "保存しました",
    `<h1>保存しました</h1><div class="card"><p>${esc(where)}</p>${saved.length ? `<ul>${saved.map((n) => `<li>${n}</li>`).join("")}</ul>` : "<p>入力が無かったため、何も変えていません。</p>"}${
      skipped.length ? `<p><small>空欄のため変えていないもの：${skipped.join("・")}</small></p>` : ""
    }</div><p>このページは閉じて大丈夫です。もう使えません。</p>`,
  );
}
