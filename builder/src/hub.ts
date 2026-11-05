/** Hub との通信 */
import { createReadStream } from "node:fs";
import { Readable } from "node:stream";

export interface BuildSteps {
  requires: string[];
  build: string[];
  artifact: string;
  timeout_minutes: number;
}

export interface ClaimedJob {
  job: { id: string; app_id: string; app_name: string; kind: string; seq: number; commit_sha: string; os: string; attempt: number; lease_ms: number };
  source: { clone_url: string; auth_header: string | null };
  steps: BuildSteps;
}

export interface FailReport {
  stage: "preflight" | "fetch" | "build" | "artifact" | "upload" | "interrupted";
  reason: string;
  log_tail?: string;
  retryable: boolean;
}

/** Hub に届かない・Hub が一時的に応答できない */
export class HubUnavailable extends Error {
  constructor(
    message: string,
    public readonly retryAfterMs?: number,
  ) {
    super(message);
  }
}

export class HubClient {
  constructor(
    private readonly baseUrl: string,
    private readonly token: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  private async send(path: string, init: RequestInit & { duplex?: "half" }): Promise<Response> {
    let res: Response;
    try {
      res = await this.fetchImpl(this.baseUrl.replace(/\/$/, "") + path, {
        ...init,
        headers: { authorization: `Bearer ${this.token}`, "user-agent": "upbeater-builder", ...(init.headers as Record<string, string>) },
      });
    } catch {
      throw new HubUnavailable("Hub に接続できません");
    }
    if (res.status >= 500 || res.status === 429) {
      const ra = Number(res.headers.get("retry-after"));
      await res.body?.cancel();
      throw new HubUnavailable(`Hub が応答できません（${res.status}）`, Number.isFinite(ra) && ra > 0 ? ra * 1000 : undefined);
    }
    if (res.status === 401) {
      await res.body?.cancel();
      throw new Error("Builder のトークンが無効です。MCP の create_builder で発行し直してください");
    }
    return res;
  }

  private json(path: string, body: unknown): Promise<Response> {
    return this.send(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  }

  /** 次の指示。無ければ null */
  async claim(os: string[]): Promise<ClaimedJob | null> {
    const res = await this.json("/v1/builder/claim", { os });
    if (res.status === 204 || res.status === 409) {
      await res.body?.cancel();
      return null;
    }
    if (!res.ok) throw new HubUnavailable(`指示を受け取れません（${res.status}）`);
    return (await res.json()) as ClaimedJob;
  }

  /** 続けてよいか（取り消されていれば false） */
  async heartbeat(id: string, stage: string): Promise<boolean> {
    const res = await this.json(`/v1/builder/jobs/${id}/heartbeat`, { stage });
    if (res.status === 404) return false;
    const b = (await res.json()) as { continue?: boolean };
    return b.continue === true;
  }

  async upload(id: string, file: string, sha256: string, size: number): Promise<void> {
    const res = await this.send(`/v1/builder/jobs/${id}/artifact`, {
      method: "PUT",
      headers: { "content-type": "application/octet-stream", "content-length": String(size), "x-upbeater-sha256": sha256 },
      body: Readable.toWeb(createReadStream(file)) as ReadableStream,
      duplex: "half",
    });
    if (res.status !== 201) {
      const text = await res.text().catch(() => "");
      throw new Error(`成果物を受け付けられませんでした（${res.status}）：${text.slice(0, 300)}`);
    }
    await res.body?.cancel();
  }

  async fail(id: string, report: FailReport): Promise<void> {
    const res = await this.json(`/v1/builder/jobs/${id}/fail`, report);
    await res.body?.cancel();
  }
}
