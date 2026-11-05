/**
 * GitHub App の認証（JWT → インストールトークン）
 * 秘密鍵は Secret GITHUB_APP_PRIVATE_KEY（PEM。PKCS#1・PKCS#8 のどちらでもよい）。値はログに出さない。
 */
import { b64url } from "./crypto";
import { GitHubError, type GitHubTokenProvider, type RepoRef } from "./github";

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

/** DER の長さ表現 */
function derLength(n: number): number[] {
  if (n < 0x80) return [n];
  const bytes: number[] = [];
  while (n > 0) {
    bytes.unshift(n & 0xff);
    n >>= 8;
  }
  return [0x80 | bytes.length, ...bytes];
}

function der(tag: number, content: Uint8Array): Uint8Array {
  const len = derLength(content.length);
  const out = new Uint8Array(1 + len.length + content.length);
  out[0] = tag;
  out.set(len, 1);
  out.set(content, 1 + len.length);
  return out;
}

function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

/** PKCS#1（RSA PRIVATE KEY）を PKCS#8（PRIVATE KEY）に包む。GitHub が配る鍵は PKCS#1 */
export function pkcs1ToPkcs8(pkcs1: Uint8Array): Uint8Array {
  const version = new Uint8Array([0x02, 0x01, 0x00]);
  const rsaOid = new Uint8Array([0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x01]);
  const nul = new Uint8Array([0x05, 0x00]);
  const algo = der(0x30, concat(rsaOid, nul));
  return der(0x30, concat(version, algo, der(0x04, pkcs1)));
}

export function pemToPkcs8(pem: string): Uint8Array {
  const m = /-----BEGIN (RSA )?PRIVATE KEY-----([\s\S]+?)-----END (RSA )?PRIVATE KEY-----/.exec(pem.replace(/\\n/g, "\n"));
  if (!m) throw new GitHubError("GitHub App の秘密鍵の形式が正しくありません", 0, false, undefined, true);
  const bin = atob(m[2]!.replace(/\s+/g, ""));
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return m[1] ? pkcs1ToPkcs8(bytes) : bytes;
}

export async function createAppJwt(appId: string, pem: string, nowMs: number): Promise<string> {
  const key = await crypto.subtle.importKey("pkcs8", pemToPkcs8(pem), { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["sign"]);
  const now = Math.floor(nowMs / 1000);
  const head = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  // 時計のずれを見込んで 60 秒前から有効、有効期間は GitHub の上限（10 分）未満
  const body = b64url(JSON.stringify({ iat: now - 60, exp: now + 540, iss: appId }));
  const sig = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, new TextEncoder().encode(`${head}.${body}`));
  return `${head}.${body}.${b64url(sig)}`;
}

interface CachedToken {
  token: string;
  expiresAt: number;
}

/** 同じ isolate の中でインストールとトークンを使い回す（期限の 5 分前に取り直す） */
const installationCache = new Map<string, number>();
const tokenCache = new Map<number, CachedToken>();

export function clearGitHubAppCache(): void {
  installationCache.clear();
  tokenCache.clear();
}

export class GitHubAppTokenProvider implements GitHubTokenProvider {
  constructor(
    private readonly fetchImpl: FetchLike,
    private readonly apiBase: string,
    private readonly appId: string,
    private readonly privateKeyPem: string,
    private readonly now: () => number = Date.now,
  ) {}

  async getToken(repo: RepoRef): Promise<string> {
    const key = `${this.appId}:${repo.owner}/${repo.name}`.toLowerCase();
    let installationId = installationCache.get(key);
    if (installationId === undefined) {
      const res = await this.appRequest(`/repos/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.name)}/installation`, "GET");
      if (res.status === 404) {
        throw new GitHubError(`GitHub App が ${repo.owner}/${repo.name} にインストールされていません`, 404, false, undefined, true);
      }
      installationId = ((await res.json()) as { id: number }).id;
      installationCache.set(key, installationId);
    }
    const cached = tokenCache.get(installationId);
    if (cached && cached.expiresAt - 5 * 60_000 > this.now()) return cached.token;

    const res = await this.appRequest(`/app/installations/${installationId}/access_tokens`, "POST");
    if (res.status === 404) {
      installationCache.delete(key);
      throw new GitHubError("GitHub App のインストールが見つかりません（削除された可能性）", 404, false, undefined, true);
    }
    const body = (await res.json()) as { token: string; expires_at: string };
    const token = { token: body.token, expiresAt: Date.parse(body.expires_at) || this.now() + 3600_000 };
    tokenCache.set(installationId, token);
    return token.token;
  }

  /** トークンが失効していた時に呼ぶ。次の getToken で取り直す */
  invalidate(repo: RepoRef): void {
    const key = `${this.appId}:${repo.owner}/${repo.name}`.toLowerCase();
    const id = installationCache.get(key);
    if (id !== undefined) tokenCache.delete(id);
    installationCache.delete(key);
  }

  private async appRequest(path: string, method: string): Promise<Response> {
    const jwt = await createAppJwt(this.appId, this.privateKeyPem, this.now());
    let res: Response;
    try {
      res = await this.fetchImpl(this.apiBase.replace(/\/$/, "") + path, {
        method,
        headers: {
          authorization: `Bearer ${jwt}`,
          accept: "application/vnd.github+json",
          "x-github-api-version": "2022-11-28",
          "user-agent": "upbeater-hub",
        },
      });
    } catch {
      throw new GitHubError("GitHub に接続できません", 0, true);
    }
    if (res.ok || res.status === 404) return res;
    const ra = res.headers.get("retry-after");
    const wait = ra && /^\d+$/.test(ra) ? Number(ra) * 1000 : undefined;
    if (res.status === 429 || res.status >= 500 || (res.status === 403 && (wait !== undefined || res.headers.get("x-ratelimit-remaining") === "0"))) {
      throw new GitHubError("GitHub の障害・回数制限（GitHub App の認証）", res.status, true, wait);
    }
    // 秘密鍵の失効・App の停止など。人の判断が要る
    throw new GitHubError("GitHub App の認証に失敗しました（秘密鍵の失効・App の停止の可能性）", res.status, false, undefined, true);
  }
}
