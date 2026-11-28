/**
 * LIFElive（開発の見張り）への受け渡し。
 * LIFElive は GitHub を読まない（大量の読み取りでアカウントが止められたため）。代わりに、Hub に届いた
 * GitHub の合図を、GitHub の署名（x-hub-signature-256）を付けたまま渡し、LIFElive 側で同じ鍵で確かめる。
 */
import type { Env } from "./env";

export type LifeliveEnv = Env & {
  /** 受け口（wrangler.jsonc の vars）。空なら渡さない */
  LIFELIVE_EVENTS_URL?: string;
  /** テスト用：LIFElive への接続口 */
  LIFELIVE_API?: Fetcher;
};

/** 渡す合図（アプリ一覧・漏れ・機能一覧に使う） */
const LIFELIVE_EVENTS = new Set(["push", "pull_request", "delete", "create"]);

/** 失敗しても Upbeater の処理は止めない（5 秒で諦める） */
export async function forwardToLifelive(env: LifeliveEnv, event: string, delivery: string, raw: Uint8Array, signature: string): Promise<boolean> {
  if (!env.LIFELIVE_EVENTS_URL || !LIFELIVE_EVENTS.has(event)) return false;
  try {
    const f = env.LIFELIVE_API ?? { fetch: (u: string, i: RequestInit) => fetch(u, i) };
    const res = await f.fetch(env.LIFELIVE_EVENTS_URL, {
      method: "POST",
      headers: { "content-type": "application/json", "x-github-event": event, "x-github-delivery": delivery, "x-hub-signature-256": signature },
      body: raw,
      signal: AbortSignal.timeout(5000),
    });
    return res.ok;
  } catch {
    return false;
  }
}
