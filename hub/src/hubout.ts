/**
 * LOVE connect HUB への知らせ：失敗した実行を、WORLD ruler. へ event レーンの封筒（event.upbeater.run.failed）で送る。
 * Upbeater は通知サービスを持たない（失敗は GitHub のコミットの状態に出るだけ）ので、利用者の iPhone に届く経路をここで足す。
 *
 * - 規格：LOVE connect HUB 規格書 第4・5・19・20章。受ける側の決まりは WORLD ruler. 設計書 9.3
 * - 実行時の外部部品は入れない。署名は Web Crypto（HMAC-SHA256）だけ。love-connect-hub のパッケージは別のリポジトリ（private・TypeScript のソースのまま）で、
 *   この Hub から取り込む道が無いため、封筒の検査に要る最小の部分（項目名を並べ替えた JSON と署名）をここに自前で書く。規格の版が上がったらこのファイルを差し替える
 * - 署名の鍵は会社ごとに 1 本（env:HUB_KEY_LOVERHETORIC。Worker の秘密情報）。値は書かない・出さない。無い間は何もしない（失敗は GitHub の表示に出るまま）
 * - 送り損ねても失わない：封筒を作って預け（hub_outbox）、Cron で送る。再送は同じ封筒（番号・時刻・署名）のまま。受け口が DUPLICATE を返したら届いたとみなす
 * - 本文は最小：repo・workflow・run・reason・at。ログの本文は入れない
 */
import type { Env } from "./env";

export const HUB_ID = "upbeater";
export const COMPANY = "loverhetoric";
export const FORMAT = "event.upbeater.run.failed";
/** 1 回の Cron で送る数の上限（受け口は送り手ごとに 1 分 60 回まで） */
export const SEND_PER_CRON = 20;
/** 送り直しの上限と間隔（最初は 5 分、倍々で、最長 1 時間）。超えたら諦めて理由を残す */
export const MAX_ATTEMPTS = 12;
const RETRY_BASE_MS = 5 * 60_000;
const RETRY_MAX_MS = 60 * 60_000;
const WATERMARK = "failed_watermark";

const enc = new TextEncoder();

function b64uEncode(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function b64uDecode(text: string): Uint8Array | null {
  if (!/^[A-Za-z0-9_-]*$/.test(text) || text.length % 4 === 1) return null;
  try {
    const bin = atob(text.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (text.length % 4)) % 4));
    return Uint8Array.from(bin, (c) => c.charCodeAt(0));
  } catch {
    return null;
  }
}

/** 項目名を並べ替えた JSON（LOVE connect HUB 規格の canonicalJson と同じ規則） */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") {
    const s = JSON.stringify(value);
    if (s === undefined) throw new Error("署名できない値が含まれています");
    return s;
  }
  if (Array.isArray(value)) return `[${value.map((v) => canonicalJson(v === undefined ? null : v)).join(",")}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj)
    .filter((k) => obj[k] !== undefined)
    .sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`).join(",")}}`;
}

/** 署名（HMAC-SHA256。sig を除く封筒全体の正規の JSON）。鍵は base64url の 32 バイト以上。読めなければ null */
export async function signEnvelope(keyText: string | undefined, envelope: Record<string, unknown>): Promise<string | null> {
  const raw = keyText ? b64uDecode(keyText.trim()) : null;
  if (!raw || raw.byteLength < 32) return null;
  const key = await crypto.subtle.importKey("raw", raw, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return b64uEncode(new Uint8Array(await crypto.subtle.sign("HMAC", key, enc.encode(canonicalJson(envelope)))));
}

/** 1 行の文字だけにして長さを切る（改行・制御文字は空白に） */
export function oneLine(v: string | null | undefined, max: number): string {
  // eslint-disable-next-line no-control-regex
  return (v ?? "").replace(/[\u0000-\u001f\u007f]+/g, " ").trim().slice(0, max);
}

interface FailedRun {
  id: string;
  number: number;
  workflow_file: string;
  conclusion: string;
  problems: string | null;
  updated_at: number;
  repo: string;
}

/** 失敗の理由（短く。ログの本文は使わない）：失敗したジョブの理由、無ければ定義ファイルの誤りなど */
async function reasonOf(env: Env, r: FailedRun): Promise<string> {
  if (r.conclusion === "definition_error") {
    try {
      const p = JSON.parse(r.problems ?? "[]") as { message?: string }[];
      return oneLine(`定義ファイルの誤り：${p[0]?.message ?? ""}`, 200);
    } catch {
      return "定義ファイルの誤り";
    }
  }
  const j = await env.DB.prepare("SELECT name, reason FROM jobs WHERE run_id = ? AND status = 'failed' ORDER BY COALESCE(finished_at, updated_at) LIMIT 1").bind(r.id).first<{ name: string; reason: string | null }>();
  return oneLine(j ? `${j.name}：${j.reason ?? "失敗"}` : "失敗", 200);
}

/** 封筒を作る（at は作った時刻。再送でも変えない） */
export async function buildEnvelope(env: Env, r: FailedRun, now: number): Promise<{ id: string; text: string } | null> {
  const id = `upb-${r.id}-${r.updated_at}`.slice(0, 64);
  const env1: Record<string, unknown> = {
    v: 1,
    l: "event",
    f: FORMAT,
    id,
    co: COMPANY,
    by: HUB_ID,
    at: now,
    c: 1,
    b: { repo: r.repo, workflow: oneLine(r.workflow_file, 100), run: r.number, reason: await reasonOf(env, r), at: r.updated_at },
  };
  const sig = await signEnvelope(env.HUB_KEY_LOVERHETORIC, env1);
  return sig ? { id, text: JSON.stringify({ ...env1, sig }) } : null;
}

/** 失敗した実行を、読み進めた位置から先だけ拾って預ける。最初の 1 回は位置を決めるだけ（過去の失敗を一度に送らない） */
export async function collectFailures(env: Env, now: number): Promise<number> {
  const st = await env.DB.prepare("SELECT v FROM hub_out_state WHERE k = ?").bind(WATERMARK).first<{ v: number }>();
  if (!st) {
    await env.DB.prepare("INSERT OR IGNORE INTO hub_out_state (k, v) VALUES (?, ?)").bind(WATERMARK, now).run();
    return 0;
  }
  const rows = await env.DB.prepare(
    `SELECT x.id, x.number, x.workflow_file, x.conclusion, x.problems, x.updated_at, r.full_name AS repo
       FROM runs x JOIN repos r ON r.id = x.repo_id
      WHERE x.status = 'completed' AND x.conclusion IN ('failure', 'definition_error') AND x.updated_at >= ?
      ORDER BY x.updated_at LIMIT 100`,
  )
    .bind(st.v)
    .all<FailedRun>();
  let queued = 0;
  let last = st.v;
  for (const r of rows.results) {
    const e = await buildEnvelope(env, r, now);
    if (!e) return queued; // 鍵が読めない：位置を進めない（鍵が置かれてから、改めて拾う）
    const ins = await env.DB.prepare("INSERT OR IGNORE INTO hub_outbox (id, envelope, next_at, created_at) VALUES (?, ?, ?, ?)").bind(e.id, e.text, now, now).run();
    queued += ins.meta.changes ?? 0;
    last = Math.max(last, r.updated_at);
  }
  if (last !== st.v) await env.DB.prepare("UPDATE hub_out_state SET v = ? WHERE k = ?").bind(last, WATERMARK).run();
  return queued;
}

type Send = (url: string, init: RequestInit) => Promise<Response>;

/** 預けた封筒を送る。届いた（200・DUPLICATE）・通らないと分かった（4xx）・また送る（5xx・通信の失敗） */
export async function flushOutbox(env: Env, opts: { now?: number; send?: Send } = {}): Promise<{ sent: number; dead: number; retry: number }> {
  const now = opts.now ?? Date.now();
  const send: Send = opts.send ?? ((u, i) => fetch(u, i));
  const url = env.HUB_WORLDRULERS_URL;
  const out = { sent: 0, dead: 0, retry: 0 };
  const rows = await env.DB.prepare("SELECT id, envelope, attempts FROM hub_outbox WHERE sent_at IS NULL AND dead_reason IS NULL AND next_at <= ? ORDER BY next_at LIMIT ?")
    .bind(now, SEND_PER_CRON)
    .all<{ id: string; envelope: string; attempts: number }>();
  for (const r of rows.results) {
    let status = 0;
    let code = "";
    try {
      const res = await send(`${url!.replace(/\/+$/, "")}/hub`, { method: "POST", headers: { "content-type": "application/json" }, body: r.envelope });
      status = res.status;
      code = String(((await res.json().catch(() => null)) as { code?: unknown } | null)?.code ?? "");
    } catch {
      status = 0; // 通信の失敗：また送る
    }
    if (status === 200 || (status === 409 && code === "DUPLICATE")) {
      await env.DB.prepare("UPDATE hub_outbox SET sent_at = ?, attempts = attempts + 1 WHERE id = ?").bind(now, r.id).run();
      out.sent++;
    } else if (status >= 400 && status < 500 && status !== 429) {
      // 鍵の誤り（BAD_SIGNATURE・NO_KEY）・形の誤り・許可されていない：送り直しても通らない。理由の符号だけ残す（本文は残さない）
      await env.DB.prepare("UPDATE hub_outbox SET dead_reason = ?, attempts = attempts + 1 WHERE id = ?").bind(`${status} ${code}`.trim().slice(0, 100), r.id).run();
      out.dead++;
    } else if (r.attempts + 1 >= MAX_ATTEMPTS) {
      await env.DB.prepare("UPDATE hub_outbox SET dead_reason = ?, attempts = attempts + 1 WHERE id = ?").bind(`送り直しの上限（最後は ${status || "通信の失敗"}）`, r.id).run();
      out.dead++;
    } else {
      const wait = Math.min(RETRY_BASE_MS * 2 ** r.attempts, RETRY_MAX_MS);
      await env.DB.prepare("UPDATE hub_outbox SET attempts = attempts + 1, next_at = ? WHERE id = ?").bind(now + wait, r.id).run();
      out.retry++;
    }
  }
  return out;
}

/** Cron から：鍵と送り先がそろっている時だけ動く（無ければ何もしない） */
export async function runHubOut(env: Env, now = Date.now(), send?: Send): Promise<{ queued: number; sent: number; dead: number; retry: number } | null> {
  if (!env.HUB_KEY_LOVERHETORIC || !env.HUB_WORLDRULERS_URL) return null;
  const queued = await collectFailures(env, now);
  const r = await flushOutbox(env, { now, send });
  // 古い記録の片付け（届いた物は 7 日、諦めた物は 30 日）
  await env.DB.batch([
    env.DB.prepare("DELETE FROM hub_outbox WHERE sent_at IS NOT NULL AND sent_at < ?").bind(now - 7 * 86_400_000),
    env.DB.prepare("DELETE FROM hub_outbox WHERE dead_reason IS NOT NULL AND created_at < ?").bind(now - 30 * 86_400_000),
  ]);
  return { queued, ...r };
}
