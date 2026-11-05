/**
 * 成果物の保存（R2）。受け取りながら SHA-256 を計算し、申告と一致したものだけを ready にする。
 * 一致しない・途中で切れた・取り消された場合は R2 から消し、中途半端な成果物を残さない。
 */
import { toHex } from "./crypto";
import type { Env, ReleaseRow } from "./env";
import { HttpError } from "./http";
import { operationStatement } from "./operations";

/** Workers が受け取れる本文の上限に合わせる */
export const MAX_ARTIFACT_BYTES = 100 * 1024 * 1024;

export interface StoredArtifact {
  sha256: string;
  size: number;
  key: string;
}

export async function storeArtifact(
  env: Env,
  req: Request,
  release: ReleaseRow,
  opts: { expectedSha256?: string | null; extraStatements?: (key: string, sha: string, size: number) => D1PreparedStatement[] } = {},
): Promise<StoredArtifact> {
  if (release.status === "cancelled" || release.status === "halted") throw new HttpError(409, "release_not_accepting", release.status);
  const length = Number(req.headers.get("content-length") ?? "");
  if (!Number.isSafeInteger(length) || length <= 0) throw new HttpError(411, "length_required", "content-length が必要です");
  if (length > MAX_ARTIFACT_BYTES) throw new HttpError(413, "payload_too_large");
  if (!req.body) throw new HttpError(400, "invalid_artifact");
  const expected = opts.expectedSha256?.toLowerCase() ?? null;
  if (expected !== null && !/^[0-9a-f]{64}$/.test(expected)) throw new HttpError(400, "invalid_sha256");

  const key = `${release.owner_id}/${release.app_id}/${release.seq}/${release.os}/${release.id}`;
  const [forHash, forStore] = req.body.tee();
  const digest = new crypto.DigestStream("SHA-256");
  const hashing = forHash.pipeTo(digest).then(() => digest.digest);
  const fixed = new FixedLengthStream(length);
  const piping = forStore.pipeTo(fixed.writable);

  let sha256: string;
  try {
    await Promise.all([env.ARTIFACTS.put(key, fixed.readable, { httpMetadata: { contentType: "application/octet-stream" } }), piping]);
    sha256 = toHex(await hashing);
  } catch {
    await env.ARTIFACTS.delete(key).catch(() => undefined);
    throw new HttpError(400, "upload_incomplete", "成果物の受け取りが途中で切れました");
  }
  if (expected !== null && expected !== sha256) {
    await env.ARTIFACTS.delete(key);
    throw new HttpError(400, "sha256_mismatch", "成果物の SHA-256 が申告と一致しません");
  }

  const now = Date.now();
  const results = await env.DB.batch([
    // 上げている間に新しい版で取り消された場合は ready にしない
    env.DB.prepare(
      "UPDATE releases SET r2_key = ?, sha256 = ?, size = ?, status = 'ready', updated_at = ? WHERE id = ? AND status IN ('pending', 'failed')",
    ).bind(key, sha256, length, now, release.id),
    operationStatement(
      env,
      { owner_id: release.owner_id, app_id: release.app_id, kind: "release", stage: "artifact_ready", status: "ok", detail: { seq: release.seq, os: release.os, sha256, size: length } },
      now,
    ),
    ...(opts.extraStatements?.(key, sha256, length) ?? []),
  ]);
  if ((results[0]?.meta.changes ?? 0) !== 1) {
    await env.ARTIFACTS.delete(key);
    throw new HttpError(409, "release_not_accepting");
  }
  return { sha256, size: length, key };
}
