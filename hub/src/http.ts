/** 応答と入力検証の共通部品 */
export class HttpError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message?: string,
  ) {
    super(message ?? code);
  }
}

export function json(body: unknown, status = 200, headers: HeadersInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...headers },
  });
}

export function errorResponse(e: unknown): Response {
  if (e instanceof HttpError) return json({ error: e.code, message: e.message }, e.status);
  // 内部の詳細（秘密情報を含みうる）は応答に出さない
  console.error("内部エラー", e instanceof Error ? e.name : typeof e);
  return json({ error: "internal_error" }, 500);
}

export async function readJson<T = Record<string, unknown>>(req: Request, maxBytes = 64 * 1024): Promise<T> {
  const len = Number(req.headers.get("content-length") ?? "0");
  if (len > maxBytes) throw new HttpError(413, "payload_too_large");
  const text = await req.text();
  if (text.length > maxBytes) throw new HttpError(413, "payload_too_large");
  try {
    const v = JSON.parse(text) as unknown;
    if (v === null || typeof v !== "object" || Array.isArray(v)) throw new Error();
    return v as T;
  } catch {
    throw new HttpError(400, "invalid_json");
  }
}

export function str(v: unknown, field: string, opts: { max?: number; pattern?: RegExp; optional?: boolean } = {}): string {
  if (v === undefined || v === null || v === "") {
    if (opts.optional) return "";
    throw new HttpError(400, "invalid_field", `${field} が必要です`);
  }
  if (typeof v !== "string" || v.length > (opts.max ?? 256) || (opts.pattern && !opts.pattern.test(v))) {
    throw new HttpError(400, "invalid_field", `${field} の形式が正しくありません`);
  }
  return v;
}

export function int(v: unknown, field: string, min = 0): number {
  if (typeof v !== "number" || !Number.isSafeInteger(v) || v < min) {
    throw new HttpError(400, "invalid_field", `${field} は ${min} 以上の整数です`);
  }
  return v;
}

export function bearer(req: Request): string | null {
  const h = req.headers.get("authorization");
  if (!h) return null;
  const m = /^Bearer\s+(\S+)$/i.exec(h);
  return m?.[1] ?? null;
}
