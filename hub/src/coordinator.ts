/**
 * AppCoordinator（Durable Object、アプリごとに 1 つ）
 * - 同じアプリの照合を直列化する
 * - 処理中に届いた依頼は 1 回の再照合にまとめる（連続した更新は最新だけを扱う）
 * - GitHub の障害・回数制限時は待ち行列（DO の永続領域と alarm）に残し、間隔を広げて再試行する
 */
import { DurableObject } from "cloudflare:workers";
import type { Env } from "./env";
import { createGitHubClient, GitHubError } from "./github";
import { recordOperation } from "./operations";
import { getApp, syncApp, type SyncResult } from "./versions";

export type CoordinatorOutcome =
  | SyncResult
  | { status: "retry_scheduled"; attempt: number; retry_at: number; reason: string }
  | { status: "queued"; retry_at: number }
  | { status: "failed"; reason: string };

/** 再試行の間隔：30 秒から倍々、上限 1 時間。GitHub の指定があればそれ以上待つ。ゆらぎは 0〜20% を加える */
export const RETRY_BASE_MS = 30_000;
export const RETRY_MAX_MS = 60 * 60_000;
/** 処理中に Worker が落ちた場合の保険（この時間後に alarm で再開する） */
export const SAFETY_ALARM_MS = 5 * 60_000;

export function backoffDelay(attempt: number, retryAfterMs?: number, rand: () => number = Math.random): number {
  const exp = Math.min(RETRY_MAX_MS, RETRY_BASE_MS * 2 ** Math.max(0, attempt - 1));
  const delay = Math.round(exp * (1 + rand() * 0.2));
  return Math.max(delay, retryAfterMs ?? 0);
}

export class AppCoordinator extends DurableObject<Env> {
  private running: Promise<CoordinatorOutcome> | null = null;
  private pending = false;
  private pendingSource = "webhook";

  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);
    if (req.method !== "POST" || url.pathname !== "/sync") return new Response("not found", { status: 404 });
    const body = (await req.json()) as { app_id?: unknown; source?: unknown };
    if (typeof body.app_id !== "string") return new Response("bad request", { status: 400 });
    await this.ctx.storage.put("app_id", body.app_id);
    const source = typeof body.source === "string" ? body.source : "webhook";
    return Response.json(await this.requestSync(source, false));
  }

  async alarm(): Promise<void> {
    await this.requestSync("retry", true);
  }

  private async requestSync(source: string, fromAlarm: boolean): Promise<CoordinatorOutcome> {
    // 回数制限などで待機中なら、GitHub に問い合わせず待ち行列に残すだけにする
    if (!fromAlarm) {
      const blockedUntil = (await this.ctx.storage.get<number>("blocked_until")) ?? 0;
      if (blockedUntil > Date.now()) {
        await this.ctx.storage.put("dirty", true);
        return { status: "queued", retry_at: blockedUntil };
      }
    }
    this.pending = true;
    this.pendingSource = source;
    if (!this.running) this.running = this.drain();
    return this.running;
  }

  private async drain(): Promise<CoordinatorOutcome> {
    let out: CoordinatorOutcome = { status: "failed", reason: "実行されませんでした" };
    try {
      while (this.pending) {
        this.pending = false;
        out = await this.runOnce(this.pendingSource);
        if (out.status === "retry_scheduled") {
          this.pending = false;
          break;
        }
      }
    } finally {
      // 判定と解除の間に await を挟まない（取りこぼし防止）
      this.running = null;
    }
    return out;
  }

  private async runOnce(source: string): Promise<CoordinatorOutcome> {
    const storage = this.ctx.storage;
    const appId = await storage.get<string>("app_id");
    if (!appId) return { status: "app_missing" };

    await storage.put("dirty", true);
    const existing = await storage.getAlarm();
    if (existing === null) await storage.setAlarm(Date.now() + SAFETY_ALARM_MS);

    try {
      const result = await syncApp(this.env, createGitHubClient(this.env), appId, source);
      await storage.delete(["dirty", "attempt", "blocked_until"]);
      await storage.deleteAlarm();
      return result;
    } catch (e) {
      const app = await getApp(this.env, appId).catch(() => null);
      const owner = app?.owner_id ?? "";
      if (e instanceof GitHubError && !e.retryable) {
        await storage.delete(["dirty", "attempt", "blocked_until"]);
        await storage.deleteAlarm();
        await recordOperation(this.env, {
          owner_id: owner,
          app_id: appId,
          kind: "sync",
          stage: "branch_head",
          status: "failed",
          reason: e.message,
          needs_human: e.needsHuman,
          detail: { http_status: e.status, source },
        });
        return { status: "failed", reason: e.message };
      }
      // GitHub の障害・回数制限・D1 の一時的な失敗は再試行する
      const attempt = ((await storage.get<number>("attempt")) ?? 0) + 1;
      const delay = backoffDelay(attempt, e instanceof GitHubError ? e.retryAfterMs : undefined);
      const retryAt = Date.now() + delay;
      await storage.put({ attempt, blocked_until: retryAt, dirty: true });
      await storage.setAlarm(retryAt);
      const reason = e instanceof GitHubError ? e.message : "一時的な内部エラー";
      await recordOperation(this.env, {
        owner_id: owner,
        app_id: appId,
        kind: "sync",
        stage: "branch_head",
        status: "retry",
        reason,
        retryable: true,
        detail: { attempt, retry_at: retryAt, http_status: e instanceof GitHubError ? e.status : null, source },
      });
      return { status: "retry_scheduled", attempt, retry_at: retryAt, reason };
    }
  }
}

/** Worker からアプリの照合を依頼する */
export async function requestAppSync(env: Env, appId: string, source: string): Promise<CoordinatorOutcome> {
  const stub = env.APP_COORDINATOR.get(env.APP_COORDINATOR.idFromName(appId));
  const res = await stub.fetch("https://coordinator/sync", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ app_id: appId, source }),
  });
  if (!res.ok) throw new Error(`照合の依頼に失敗しました（${res.status}）`);
  return (await res.json()) as CoordinatorOutcome;
}
