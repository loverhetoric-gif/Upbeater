/** 常駐の繰り返し：指示を受け取り、1 件ずつ順番に実行する */
import { mkdir, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { HubUnavailable, type HubClient } from "./hub.js";
import { runJob, type JobDeps, type JobOutcome } from "./job.js";

export interface BuilderOptions {
  hub: HubClient;
  workRoot: string;
  os: string[];
  pollMs: number;
  maxBackoffMs?: number;
  log?: (line: string) => void;
  jobDeps?: Partial<JobDeps>;
}

export type TickResult = { kind: "idle" } | { kind: "job"; outcome: JobOutcome } | { kind: "hub_unavailable"; retryAfterMs?: number };

export class Builder {
  constructor(private readonly o: BuilderOptions) {}

  /** 前回の中断で残った作業場所を消す（中途半端な成果物を残さない） */
  async cleanupStale(): Promise<number> {
    await mkdir(this.o.workRoot, { recursive: true });
    let n = 0;
    for (const name of await readdir(this.o.workRoot)) {
      if (!name.startsWith("job-")) continue;
      await rm(join(this.o.workRoot, name), { recursive: true, force: true });
      n++;
    }
    return n;
  }

  async tick(shutdown?: AbortSignal): Promise<TickResult> {
    let claimed;
    try {
      claimed = await this.o.hub.claim(this.o.os);
    } catch (e) {
      if (e instanceof HubUnavailable) return { kind: "hub_unavailable", retryAfterMs: e.retryAfterMs };
      throw e;
    }
    if (!claimed) return { kind: "idle" };
    const outcome = await runJob(claimed, { hub: this.o.hub, workRoot: this.o.workRoot, shutdown, log: this.o.log, ...this.o.jobDeps });
    return { kind: "job", outcome };
  }

  /** 停止の合図まで繰り返す。Hub に届かない間は間隔を広げて待つ */
  async loop(shutdown: AbortSignal): Promise<void> {
    const log = this.o.log ?? (() => undefined);
    const removed = await this.cleanupStale();
    if (removed) log(`前回の中断で残った作業場所を ${removed} 件消しました`);
    let backoff = this.o.pollMs;
    while (!shutdown.aborted) {
      let wait = this.o.pollMs;
      try {
        const r = await this.tick(shutdown);
        if (r.kind === "job") {
          wait = 0; // 続けて次の指示を見る
          backoff = this.o.pollMs;
        } else if (r.kind === "hub_unavailable") {
          backoff = Math.min(backoff * 2, this.o.maxBackoffMs ?? 5 * 60_000);
          wait = Math.max(backoff, r.retryAfterMs ?? 0);
          log(`Hub に届きません。${Math.round(wait / 1000)} 秒後に再試行します`);
        } else {
          backoff = this.o.pollMs;
        }
      } catch (e) {
        log(`停止します：${e instanceof Error ? e.message : String(e)}`);
        throw e;
      }
      if (wait > 0) await sleep(wait, shutdown);
    }
  }
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((res) => {
    const t = setTimeout(res, ms);
    signal.addEventListener("abort", () => (clearTimeout(t), res()), { once: true });
  });
}
