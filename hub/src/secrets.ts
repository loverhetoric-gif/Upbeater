/**
 * 秘密情報：AES-GCM で暗号化して保存し、ジョブに指定された分だけ Runner へ渡す。
 * ログからは値そのものと、よくある変形（base64・URL 符号化・JSON の文字列・16 進）を伏せる。
 */
import { b64url, fromB64url, toHex } from "./crypto";
import type { Env } from "./env";
import { HttpError } from "./http";

const enc = new TextEncoder();
const dec = new TextDecoder();

async function key(env: Env): Promise<CryptoKey> {
  if (!env.SECRETS_KEY) throw new HttpError(503, "secrets_not_configured", "秘密情報の暗号鍵が設定されていません");
  const raw = Uint8Array.from(atob(env.SECRETS_KEY), (c) => c.charCodeAt(0));
  if (raw.length !== 32) throw new HttpError(503, "secrets_not_configured", "秘密情報の暗号鍵は 32 バイトにしてください");
  return crypto.subtle.importKey("raw", raw, "AES-GCM", false, ["encrypt", "decrypt"]);
}

/** 暗号文を別の行に付け替えられないよう、所有者・リポジトリ・名前を認証データに含める */
const aad = (owner: string, repo: string, name: string) => enc.encode(`upbeater-secret|${owner}|${repo}|${name}`);

export async function putSecret(env: Env, owner: string, repo: string, name: string, value: string): Promise<void> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: aad(owner, repo, name) }, await key(env), enc.encode(value));
  const now = Date.now();
  await env.DB.prepare(
    `INSERT INTO secrets (owner_id, repo_id, name, ciphertext, iv, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (owner_id, repo_id, name) DO UPDATE SET ciphertext = excluded.ciphertext, iv = excluded.iv, updated_at = excluded.updated_at`,
  )
    .bind(owner, repo, name, b64url(ct), b64url(iv), now, now)
    .run();
}

/** 指定の名前の値。リポジトリ専用の値を、利用者全体の値より優先する */
export async function resolveSecrets(env: Env, owner: string, repo: string, names: string[]): Promise<Record<string, string>> {
  if (names.length === 0) return {};
  const rows = await env.DB.prepare(
    `SELECT repo_id, name, ciphertext, iv FROM secrets WHERE owner_id = ? AND repo_id IN (?, '') AND name IN (SELECT value FROM json_each(?))`,
  )
    .bind(owner, repo, JSON.stringify(names))
    .all<{ repo_id: string; name: string; ciphertext: string; iv: string }>();
  const k = await key(env);
  const out: Record<string, string> = {};
  for (const r of rows.results.sort((a, b) => (a.repo_id === "" ? -1 : 1) - (b.repo_id === "" ? -1 : 1))) {
    const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv: fromB64url(r.iv), additionalData: aad(owner, r.repo_id, r.name) }, k, fromB64url(r.ciphertext));
    out[r.name] = dec.decode(pt);
  }
  return out;
}

function b64(bytes: Uint8Array): string {
  let s = "";
  for (const x of bytes) s += String.fromCharCode(x);
  return btoa(s);
}

/**
 * 伏せる文字列の一覧。長い base64 の途中に埋まった場合も伏せられるよう、
 * 前置きの長さ（3 で割った余り）ごとに、値の影響を受けない中ほどの部分を求める。
 */
export function maskVariants(value: string): string[] {
  if (value.length < 3) return [];
  const bytes = enc.encode(value);
  const out = new Set<string>([value, value.trim()]);
  const std = b64(bytes);
  out.add(std);
  out.add(std.replace(/=+$/, ""));
  out.add(b64url(bytes));
  out.add(encodeURIComponent(value));
  out.add(JSON.stringify(value).slice(1, -1));
  out.add(toHex(bytes));
  out.add(b64(enc.encode(value + "\n")).replace(/=+$/, ""));
  for (let shift = 1; shift <= 2; shift++) {
    const padded = new Uint8Array(shift + bytes.length);
    padded.set(bytes, shift);
    const e = b64(padded);
    // 先頭の前置きに関わる文字と、末尾の不完全な部分を除いた中ほど
    const start = Math.ceil((shift * 4) / 3);
    const end = Math.floor(((shift + bytes.length) * 4) / 3) - (((shift + bytes.length) % 3 === 0) ? 0 : 1);
    const core = e.slice(start, Math.max(start, end));
    if (core.length >= 6) {
      out.add(core);
      out.add(core.replace(/\+/g, "-").replace(/\//g, "_"));
    }
  }
  {
    // 前置きが 0 の場合も末尾の不完全な部分を除いて埋め込まれる
    const end = Math.floor((bytes.length * 4) / 3) - (bytes.length % 3 === 0 ? 0 : 1);
    const core = std.slice(0, end);
    if (core.length >= 6) out.add(core);
  }
  return [...out].filter((s) => s.length >= 3).sort((a, b) => b.length - a.length);
}

export class Masker {
  private readonly needles: string[];
  constructor(values: string[]) {
    this.needles = [...new Set(values.flatMap(maskVariants))].sort((a, b) => b.length - a.length);
  }
  mask(text: string): string {
    let out = text;
    for (const n of this.needles) if (out.includes(n)) out = out.split(n).join("***");
    return out;
  }
  get size(): number {
    return this.needles.length;
  }
}
