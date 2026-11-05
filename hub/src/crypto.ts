/** 暗号処理の共通部品（WebCrypto のみを使う） */
const enc = new TextEncoder();

export function toBytes(data: string | Uint8Array | ArrayBuffer): Uint8Array {
  if (typeof data === "string") return enc.encode(data);
  return data instanceof Uint8Array ? data : new Uint8Array(data);
}

export function toHex(data: ArrayBuffer | Uint8Array): string {
  const b = toBytes(data);
  let s = "";
  for (const x of b) s += x.toString(16).padStart(2, "0");
  return s;
}

export function b64url(data: Uint8Array | ArrayBuffer | string): string {
  const b = toBytes(data);
  let s = "";
  for (const x of b) s += String.fromCharCode(x);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function fromB64url(s: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]*$/.test(s)) throw new Error("base64url の形式ではありません");
  const pad = s.length % 4 === 0 ? "" : "=".repeat(4 - (s.length % 4));
  const bin = atob(s.replace(/-/g, "+").replace(/_/g, "/") + pad);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** 長さ・内容に依存せず一定の手数で比較する */
export function timingSafeEqual(a: string | Uint8Array, b: string | Uint8Array): boolean {
  const x = toBytes(a);
  const y = toBytes(b);
  const len = Math.max(x.length, y.length);
  let diff = x.length ^ y.length;
  for (let i = 0; i < len; i++) diff |= (x[i] ?? 0) ^ (y[i] ?? 0);
  return diff === 0;
}

export async function sha256Hex(data: string | Uint8Array | ArrayBuffer): Promise<string> {
  return toHex(await crypto.subtle.digest("SHA-256", toBytes(data)));
}

async function hmacKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
}

export async function hmacSha256(secret: string, data: string | Uint8Array | ArrayBuffer): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.sign("HMAC", await hmacKey(secret), toBytes(data)));
}

/** GitHub の X-Hub-Signature-256（"sha256=<16進>"）を検証する */
export async function verifyGitHubSignature(secret: string, body: Uint8Array, header: string | null): Promise<boolean> {
  if (!header) return false;
  const expected = "sha256=" + toHex(await hmacSha256(secret, body));
  return timingSafeEqual(expected, header.trim().toLowerCase());
}

export function randomBytes(n: number): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(n));
}

export function randomToken(prefix: string, bytes = 32): string {
  return prefix + b64url(randomBytes(bytes));
}

/** 人が入力しやすい登録コード（紛らわしい文字を除いた 32 文字から一様に選ぶ） */
const CODE_ALPHABET = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ";
export function randomCode(length = 10): string {
  let out = "";
  while (out.length < length) {
    for (const b of randomBytes(length)) {
      if (out.length >= length) break;
      out += CODE_ALPHABET[b & 31];
    }
  }
  return out;
}

export function normalizeCode(code: string): string {
  return code.replace(/[\s-]/g, "").toUpperCase();
}
