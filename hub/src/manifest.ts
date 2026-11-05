/**
 * マニフェストの署名と検証（Ed25519、WebCrypto）
 *
 * - 署名対象は JSON を UTF-8 にしたバイト列そのもの（payload を base64url で運ぶ）。正規化の差による検証失敗を避ける
 * - 鍵には世代番号を付ける。端末は複数世代の公開鍵を受け入れ、失効した世代を拒否する
 * - 通番が現行より小さい版は、署名付きの明示的な巻き戻し指示がない限り無効とする
 *
 * verifyManifest / evaluateManifest は端末側の判定の基準実装でもある（app/ はこれと同じ規則で実装する）。
 */
import { b64url, fromB64url } from "./crypto";

export const MANIFEST_VERSION = 1;

export interface ManifestBody {
  v: typeof MANIFEST_VERSION;
  app_id: string;
  os: string;
  seq: number;
  commit_sha: string;
  release_id: string;
  sha256: string;
  size: number;
  url: string;
  issued_at: number;
  /** この時刻を過ぎたマニフェストは受け入れない（古いマニフェストの再送対策） */
  expires_at: number;
  key_generation: number;
  /** 明示的な巻き戻し指示。これがある時に限り、現行より小さい通番を受け入れる */
  rollback?: { to_seq: number; reason?: string };
}

export interface SignedManifest {
  payload: string;
  signature: string;
  key_generation: number;
}

export interface SigningKey {
  gen: number;
  /** Ed25519 の秘密鍵（JWK。kty: OKP, crv: Ed25519, d, x） */
  jwk: JsonWebKey;
}

export interface SigningKeySet {
  active: number;
  keys: SigningKey[];
}

export interface PublicKeyInfo {
  gen: number;
  status: "active" | "valid" | "revoked";
  jwk: { kty: "OKP"; crv: "Ed25519"; x: string };
}

const ALG = { name: "Ed25519" } as const;

/** Secret MANIFEST_SIGNING_KEYS（JSON）を読む。形式：{"active":2,"keys":[{"gen":1,"jwk":{...}},...]} */
export function parseSigningKeys(raw: string | undefined): SigningKeySet {
  if (!raw) throw new Error("署名鍵が設定されていません");
  const v = JSON.parse(raw) as Partial<SigningKeySet>;
  if (typeof v.active !== "number" || !Array.isArray(v.keys)) throw new Error("署名鍵の形式が正しくありません");
  const keys: SigningKey[] = [];
  const seen = new Set<number>();
  for (const k of v.keys) {
    if (!k || !Number.isSafeInteger(k.gen) || k.gen < 1 || seen.has(k.gen)) throw new Error("署名鍵の世代番号が正しくありません");
    if (k.jwk?.kty !== "OKP" || k.jwk.crv !== "Ed25519" || typeof k.jwk.x !== "string" || typeof k.jwk.d !== "string") throw new Error("署名鍵が Ed25519 ではありません");
    seen.add(k.gen);
    keys.push({ gen: k.gen, jwk: k.jwk });
  }
  if (!seen.has(v.active)) throw new Error("有効な世代の鍵がありません");
  return { active: v.active, keys };
}

export function parseRevoked(raw: string | undefined): Set<number> {
  const out = new Set<number>();
  for (const part of (raw ?? "").split(",")) {
    const t = part.trim();
    if (/^\d+$/.test(t)) out.add(Number(t));
  }
  return out;
}

/** 端末に配る公開鍵の一覧（秘密成分 d は含めない） */
export function publicKeys(set: SigningKeySet, revoked: Set<number>): PublicKeyInfo[] {
  return set.keys
    .map((k): PublicKeyInfo => ({
      gen: k.gen,
      status: revoked.has(k.gen) ? "revoked" : k.gen === set.active ? "active" : "valid",
      jwk: { kty: "OKP", crv: "Ed25519", x: k.jwk.x as string },
    }))
    .sort((a, b) => a.gen - b.gen);
}

export async function signManifest(
  body: Omit<ManifestBody, "key_generation" | "v">,
  set: SigningKeySet,
  revoked: Set<number>,
): Promise<SignedManifest> {
  if (revoked.has(set.active)) throw new Error("有効な世代の鍵が失効しています");
  const key = set.keys.find((k) => k.gen === set.active);
  if (!key) throw new Error("有効な世代の鍵がありません");
  const full: ManifestBody = { v: MANIFEST_VERSION, ...body, key_generation: key.gen };
  const payload = new TextEncoder().encode(JSON.stringify(full));
  // 生成元によって alg の表記（EdDSA / Ed25519）が異なるため、鍵の成分だけを渡す
  const priv = await crypto.subtle.importKey("jwk", { kty: "OKP", crv: "Ed25519", d: key.jwk.d, x: key.jwk.x }, ALG, false, ["sign"]);
  const sig = await crypto.subtle.sign(ALG, priv, payload);
  return { payload: b64url(payload), signature: b64url(sig), key_generation: key.gen };
}

export type VerifyResult = { ok: true; body: ManifestBody } | { ok: false; reason: string };

/** 署名の検証（端末側の基準実装）。trusted は端末が持つ世代番号→公開鍵 */
export async function verifyManifest(
  signed: SignedManifest,
  trusted: ReadonlyMap<number, JsonWebKey>,
  revoked: ReadonlySet<number>,
): Promise<VerifyResult> {
  if (revoked.has(signed.key_generation)) return { ok: false, reason: "revoked_key" };
  const jwk = trusted.get(signed.key_generation);
  if (!jwk) return { ok: false, reason: "unknown_key" };
  let payload: Uint8Array;
  let sig: Uint8Array;
  try {
    payload = fromB64url(signed.payload);
    sig = fromB64url(signed.signature);
  } catch {
    return { ok: false, reason: "malformed" };
  }
  let valid = false;
  try {
    const pub = await crypto.subtle.importKey("jwk", { kty: "OKP", crv: "Ed25519", x: jwk.x }, ALG, false, ["verify"]);
    valid = await crypto.subtle.verify(ALG, pub, sig, payload);
  } catch {
    valid = false;
  }
  if (!valid) return { ok: false, reason: "bad_signature" };
  let body: ManifestBody;
  try {
    body = JSON.parse(new TextDecoder().decode(payload)) as ManifestBody;
  } catch {
    return { ok: false, reason: "malformed" };
  }
  // 署名に含まれる世代と外側の世代が食い違うものは拒否する
  if (body.v !== MANIFEST_VERSION || body.key_generation !== signed.key_generation) return { ok: false, reason: "malformed" };
  return { ok: true, body };
}

export interface EvaluateContext {
  app_id: string;
  os: string;
  /** 端末で動いている版の通番（未導入は 0） */
  current_seq: number;
  now: number;
}

export type EvaluateResult =
  | { ok: true; action: "update" | "rollback" }
  | { ok: false; reason: "wrong_app" | "wrong_os" | "expired" | "same_version" | "downgrade" };

/**
 * 署名済みの中身を適用してよいか判定する。
 * 通番が現行より小さい版は、署名に含まれた巻き戻し指示（to_seq がその版と一致）がない限り無効。
 */
export function evaluateManifest(body: ManifestBody, ctx: EvaluateContext): EvaluateResult {
  if (body.app_id !== ctx.app_id) return { ok: false, reason: "wrong_app" };
  if (body.os !== ctx.os) return { ok: false, reason: "wrong_os" };
  if (!(body.expires_at > ctx.now)) return { ok: false, reason: "expired" };
  if (body.seq > ctx.current_seq) return { ok: true, action: "update" };
  if (body.seq === ctx.current_seq) return { ok: false, reason: "same_version" };
  if (body.rollback && body.rollback.to_seq === body.seq) return { ok: true, action: "rollback" };
  return { ok: false, reason: "downgrade" };
}

/** 署名の検証と適用可否の判定をまとめて行う */
export async function acceptManifest(
  signed: SignedManifest,
  trusted: ReadonlyMap<number, JsonWebKey>,
  revoked: ReadonlySet<number>,
  ctx: EvaluateContext,
): Promise<{ ok: true; body: ManifestBody; action: "update" | "rollback" } | { ok: false; reason: string }> {
  const v = await verifyManifest(signed, trusted, revoked);
  if (!v.ok) return v;
  const e = evaluateManifest(v.body, ctx);
  if (!e.ok) return e;
  return { ok: true, body: v.body, action: e.action };
}
