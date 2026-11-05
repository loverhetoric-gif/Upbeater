/** GET/HEAD /v1/artifacts/:release_id?t=<短期限トークン>：Worker 経由で R2 から配信する（Range 対応） */
import type { Env, ReleaseRow } from "../env";
import { json } from "../http";
import { verifyDownloadToken } from "../tokens";

export type ParsedRange = { offset: number; length: number } | "unsatisfiable" | null;

/** 単一の bytes 範囲だけを扱う。解釈できない・複数範囲は null（全体を返す） */
export function parseRange(header: string | null, size: number): ParsedRange {
  if (!header) return null;
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!m) return null;
  const [, a, b] = m;
  if (a === "" && b === "") return null;
  if (a === "") {
    const suffix = Number(b);
    if (suffix === 0) return "unsatisfiable";
    const len = Math.min(suffix, size);
    return { offset: size - len, length: len };
  }
  const start = Number(a);
  if (start >= size) return "unsatisfiable";
  const end = b === "" ? size - 1 : Math.min(Number(b), size - 1);
  if (end < start) return null;
  return { offset: start, length: end - start + 1 };
}

export async function handleArtifact(req: Request, env: Env, releaseId: string): Promise<Response> {
  if (!env.DOWNLOAD_TOKEN_SECRET) return json({ error: "not_configured" }, 503);
  const token = new URL(req.url).searchParams.get("t") ?? "";
  const claims = await verifyDownloadToken(env.DOWNLOAD_TOKEN_SECRET, token);
  if (!claims || claims.r !== releaseId) return json({ error: "invalid_or_expired_token" }, 403);

  const release = await env.DB.prepare("SELECT * FROM releases WHERE id = ?").bind(releaseId).first<ReleaseRow>();
  if (!release || !release.r2_key) return json({ error: "not_found" }, 404);
  if (release.status !== "ready") return json({ error: "release_unavailable", status: release.status }, 410);

  const head = await env.ARTIFACTS.head(release.r2_key);
  if (!head) return json({ error: "not_found" }, 404);
  const size = head.size;
  const etag = `"${release.sha256}"`;

  // If-Range が現在の内容と一致しない場合は全体を返す（途中で中身が変わった時に継ぎはぎしない）
  const ifRange = req.headers.get("if-range");
  const range = ifRange && ifRange !== etag ? null : parseRange(req.headers.get("range"), size);

  const headers = new Headers({
    "content-type": "application/octet-stream",
    "accept-ranges": "bytes",
    etag,
    "cache-control": "private, no-store",
    "x-upbeater-sha256": release.sha256 ?? "",
  });
  if (range === "unsatisfiable") {
    headers.set("content-range", `bytes */${size}`);
    return new Response(null, { status: 416, headers });
  }

  if (req.method === "HEAD") {
    headers.set("content-length", String(range ? range.length : size));
    if (range) headers.set("content-range", `bytes ${range.offset}-${range.offset + range.length - 1}/${size}`);
    return new Response(null, { status: range ? 206 : 200, headers });
  }

  const obj = await env.ARTIFACTS.get(release.r2_key, range ? { range } : undefined);
  if (!obj) return json({ error: "not_found" }, 404);
  if (range) {
    headers.set("content-range", `bytes ${range.offset}-${range.offset + range.length - 1}/${size}`);
    headers.set("content-length", String(range.length));
    return new Response(obj.body, { status: 206, headers });
  }
  headers.set("content-length", String(size));
  return new Response(obj.body, { status: 200, headers });
}
