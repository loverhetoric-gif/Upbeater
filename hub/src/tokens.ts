/** 成果物の取得に使う短期限トークン（HMAC 署名つき、Hub 内で完結） */
import { b64url, fromB64url, hmacSha256, timingSafeEqual } from "./crypto";

export interface DownloadClaims {
  /** release_id */
  r: string;
  /** device_id */
  d: string;
  /** 有効期限（ミリ秒） */
  e: number;
}

export async function createDownloadToken(secret: string, claims: DownloadClaims): Promise<string> {
  const body = b64url(JSON.stringify(claims));
  const sig = b64url(await hmacSha256(secret, "dl." + body));
  return `${body}.${sig}`;
}

export async function verifyDownloadToken(secret: string, token: string, now = Date.now()): Promise<DownloadClaims | null> {
  const [body, sig, ...rest] = token.split(".");
  if (!body || !sig || rest.length) return null;
  const expected = b64url(await hmacSha256(secret, "dl." + body));
  if (!timingSafeEqual(expected, sig)) return null;
  try {
    const c = JSON.parse(new TextDecoder().decode(fromB64url(body))) as DownloadClaims;
    if (typeof c.r !== "string" || typeof c.d !== "string" || typeof c.e !== "number") return null;
    if (c.e <= now) return null;
    return c;
  } catch {
    return null;
  }
}
