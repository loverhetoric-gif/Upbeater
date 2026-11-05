/**
 * クラウド Runner（Google Cloud Run Jobs）。Mac などの常駐 Runner が受け取れない Linux のジョブを、必要な時だけクラウドで実行する。
 * - 待ち行列に CLOUD_RUNNER_DELAY_MS 以上残り、受け取れる常駐 Runner が動いていないジョブが対象
 * - ジョブ 1 件ごとに使い捨ての Runner（そのジョブだけを受け取れる・期限つき）を作り、トークンを実行の環境変数で渡す
 * - 設定（GCP_PROJECT・GCP_REGION・CLOUD_RUN_JOB と Secret GCP_SERVICE_ACCOUNT_KEY）が無ければ何もしない
 */
import { b64url, randomToken, sha256Hex } from "./crypto";
import type { Env, JobRow, JobSpec } from "./env";
import { pemToPkcs8 } from "./github-app";
import { operationStatement, recordOperation } from "./operations";
import { RUNNER_TOKEN_PREFIX } from "./routes/runner";

export const CLOUD_RUNNER_DELAY_MS = 60_000;
/** 起動したのに受け取られない時は、この時間の後にもう一度起動する */
export const CLOUD_REDISPATCH_MS = 15 * 60_000;
const ONLINE_MS = 2 * 60_000;
const MAX_PER_TICK = 5;

export function cloudLabels(env: Env): string[] {
  return (env.CLOUD_RUNNER_LABELS ?? "linux")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

export function cloudConfigured(env: Env): boolean {
  return !!(env.GCP_PROJECT && env.GCP_REGION && env.CLOUD_RUN_JOB && env.GCP_SERVICE_ACCOUNT_KEY);
}

const gcpFetch = (env: Env) => (u: string, i?: RequestInit) => (env.GCP_API ? env.GCP_API.fetch(u, i) : fetch(u, i));

let cachedToken: { token: string; exp: number } | null = null;

/** サービスアカウントの鍵で Google のアクセストークンを得る（1 時間。少し前に取り直す） */
async function googleToken(env: Env, now: number): Promise<string> {
  if (cachedToken && cachedToken.exp > now + 5 * 60_000) return cachedToken.token;
  const key = JSON.parse(env.GCP_SERVICE_ACCOUNT_KEY!) as { client_email: string; private_key: string; token_uri?: string };
  const tokenUri = env.GCP_TOKEN_URL || key.token_uri || "https://oauth2.googleapis.com/token";
  const iat = Math.floor(now / 1000);
  const head = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const body = b64url(JSON.stringify({ iss: key.client_email, scope: "https://www.googleapis.com/auth/cloud-platform", aud: tokenUri, iat, exp: iat + 3600 }));
  const k = await crypto.subtle.importKey("pkcs8", pemToPkcs8(key.private_key), { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["sign"]);
  const sig = b64url(await crypto.subtle.sign("RSASSA-PKCS1-v1_5", k, new TextEncoder().encode(`${head}.${body}`)));
  const res = await gcpFetch(env)(tokenUri, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion: `${head}.${body}.${sig}` }).toString(),
  });
  const t = (await res.json().catch(() => ({}))) as { access_token?: string; expires_in?: number };
  if (!res.ok || !t.access_token) throw new Error(`Google のトークンを得られません（${res.status}）`);
  cachedToken = { token: t.access_token, exp: now + (t.expires_in ?? 3600) * 1000 };
  return t.access_token;
}

export function clearCloudTokenCache(): void {
  cachedToken = null;
}

/** 待っている Linux のジョブに、クラウド Runner を起動する。起動した数を返す */
export async function dispatchCloudRunners(env: Env, hubUrl: string, now = Date.now()): Promise<number> {
  if (!cloudConfigured(env)) return 0;
  const labels = cloudLabels(env);
  const rows = await env.DB.prepare(
    `SELECT j.* FROM jobs j WHERE j.status = 'queued' AND j.updated_at < ?
       AND (j.cloud_dispatched_at IS NULL OR j.cloud_dispatched_at < ?)
       AND NOT EXISTS (SELECT 1 FROM json_each(j.runs_on) l WHERE l.value NOT IN (SELECT value FROM json_each(?)))
     ORDER BY j.created_at LIMIT ${MAX_PER_TICK}`,
  )
    .bind(now - CLOUD_RUNNER_DELAY_MS, now - CLOUD_REDISPATCH_MS, JSON.stringify(labels))
    .all<JobRow>();
  let started = 0;
  for (const j of rows.results) {
    // 受け取れる常駐 Runner が動いていれば任せる（手元の Runner を優先する）
    const local = await env.DB.prepare(
      `SELECT 1 FROM runners n WHERE n.owner_id = ? AND n.ephemeral = 0 AND n.revoked_at IS NULL AND n.last_seen_at > ?
         AND NOT EXISTS (SELECT 1 FROM json_each(?) l WHERE l.value NOT IN (SELECT value FROM json_each(n.labels)))`,
    )
      .bind(j.owner_id, now - ONLINE_MS, j.runs_on)
      .first();
    if (local) continue;
    // 先に印を付ける（二重に起動しない）
    const claimed = await env.DB.prepare("UPDATE jobs SET cloud_dispatched_at = ? WHERE id = ? AND status = 'queued' AND (cloud_dispatched_at IS NULL OR cloud_dispatched_at < ?)")
      .bind(now, j.id, now - CLOUD_REDISPATCH_MS)
      .run();
    if ((claimed.meta.changes ?? 0) !== 1) continue;
    const spec = JSON.parse(j.spec) as JobSpec;
    const runnerId = crypto.randomUUID();
    const token = randomToken(RUNNER_TOKEN_PREFIX);
    const expires = now + (spec.timeout + 30) * 60_000;
    await env.DB.prepare(
      "INSERT INTO runners (id, owner_id, name, labels, token_hash, created_at, last_seen_at, ephemeral, job_id, expires_at) VALUES (?, ?, ?, ?, ?, ?, NULL, 1, ?, ?)",
    )
      .bind(runnerId, j.owner_id, `cloud-${j.id.slice(0, 8)}`, JSON.stringify(labels), await sha256Hex(token), now, j.id, expires)
      .run();
    try {
      const access = await googleToken(env, now);
      const base = (env.GCP_RUN_BASE || "https://run.googleapis.com").replace(/\/$/, "");
      const url = `${base}/v2/projects/${encodeURIComponent(env.GCP_PROJECT!)}/locations/${encodeURIComponent(env.GCP_REGION!)}/jobs/${encodeURIComponent(env.CLOUD_RUN_JOB!)}:run`;
      const res = await gcpFetch(env)(url, {
        method: "POST",
        headers: { authorization: `Bearer ${access}`, "content-type": "application/json" },
        body: JSON.stringify({
          overrides: {
            containerOverrides: [
              {
                env: [
                  { name: "UPBEATER_HUB_URL", value: hubUrl },
                  { name: "UPBEATER_RUNNER_ID", value: runnerId },
                  { name: "UPBEATER_RUNNER_TOKEN", value: token },
                  { name: "UPBEATER_RUNNER_LABELS", value: labels.join(",") },
                ],
              },
            ],
            taskCount: 1,
            timeout: `${(spec.timeout + 10) * 60}s`,
          },
        }),
      });
      if (!res.ok) throw new Error(`Cloud Run の起動に失敗しました（${res.status}）`);
      started++;
      await recordOperation(env, { owner_id: j.owner_id, repo_id: j.repo_id, run_id: j.run_id, job_id: j.id, kind: "job", stage: "cloud_dispatched", status: "ok", detail: { runner: `cloud-${j.id.slice(0, 8)}` } });
    } catch (e) {
      // 起動できなかった：印を外して次の回にもう一度試す。使い捨ての Runner は消す
      await env.DB.batch([
        env.DB.prepare("UPDATE jobs SET cloud_dispatched_at = NULL WHERE id = ?").bind(j.id),
        env.DB.prepare("UPDATE runners SET revoked_at = ? WHERE id = ?").bind(now, runnerId),
        operationStatement(env, { owner_id: j.owner_id, repo_id: j.repo_id, run_id: j.run_id, job_id: j.id, kind: "job", stage: "cloud_dispatch", status: "retry", reason: e instanceof Error ? e.message : "クラウド Runner を起動できません", retryable: true }, now),
      ]);
    }
  }
  return started;
}
