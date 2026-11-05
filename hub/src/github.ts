/**
 * GitHub との通信。認証（GitHub App）と通信の実体を差し替え可能にしている（テストでは模擬 GitHub を束縛する）。
 * Upbeater が GitHub に依存するのは「Webhook の受信」「定義ファイルの読み込み」「結果の表示」と、Runner の取得用トークンだけ。
 */
import type { Env } from "./env";
import { GitHubAppTokenProvider } from "./github-app";

export interface RepoRef {
  owner: string;
  name: string;
}

export function parseRepo(fullName: string): RepoRef {
  const [owner, name, ...rest] = fullName.split("/");
  if (!owner || !name || rest.length) throw new Error("リポジトリ名の形式が正しくありません");
  return { owner, name };
}

export interface GitHubTokenProvider {
  getToken(repo: RepoRef): Promise<string | null>;
  invalidate?(repo: RepoRef): void;
}

export class StaticTokenProvider implements GitHubTokenProvider {
  constructor(private readonly token: string | undefined) {}
  async getToken(): Promise<string | null> {
    return this.token ? this.token : null;
  }
}

export class GitHubError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly retryable: boolean,
    public readonly retryAfterMs?: number,
    public readonly needsHuman = false,
  ) {
    super(message);
    this.name = "GitHubError";
  }
}

export interface WorkflowFile {
  path: string;
  text: string;
}

export interface CheckRunInput {
  name: string;
  head_sha: string;
  external_id: string;
  status: "queued" | "in_progress" | "completed";
  conclusion?: "success" | "failure" | "cancelled" | "skipped" | "neutral";
  started_at?: string;
  completed_at?: string;
  details_url?: string;
  output?: {
    title: string;
    summary: string;
    annotations?: { path: string; start_line: number; end_line: number; annotation_level: "failure" | "warning" | "notice"; message: string }[];
  };
}

/** GitHub 操作の抽象 */
export interface GitHubClient {
  getBranchHead(repo: RepoRef, branch: string): Promise<string | null>;
  /** 指定のコミットの .upbeater/*.yml。フォルダが無ければ空 */
  listWorkflowFiles(repo: RepoRef, sha: string): Promise<WorkflowFile[]>;
  createCheckRun(repo: RepoRef, input: CheckRunInput): Promise<number>;
  updateCheckRun(repo: RepoRef, id: number, input: CheckRunInput): Promise<void>;
}

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

const enc = (s: string) => encodeURIComponent(s);
const segs = (p: string) => p.split("/").map(enc).join("/");

export class HttpGitHubClient implements GitHubClient {
  constructor(
    private readonly fetchImpl: FetchLike,
    private readonly baseUrl: string,
    private readonly tokens: GitHubTokenProvider,
    private readonly now: () => number = Date.now,
  ) {}

  private base(r: RepoRef) {
    return `/repos/${enc(r.owner)}/${enc(r.name)}`;
  }

  async getBranchHead(repo: RepoRef, branch: string): Promise<string | null> {
    const res = await this.request(repo, `${this.base(repo)}/git/ref/heads/${segs(branch)}`, { pass: [404, 409] });
    if (res.status === 404 || res.status === 409) return null;
    const sha = ((await res.json()) as { object?: { sha?: unknown } }).object?.sha;
    if (typeof sha !== "string" || !/^[0-9a-f]{40}([0-9a-f]{24})?$/.test(sha)) throw new GitHubError("GitHub の応答の形式が想定外です", 200, true);
    return sha;
  }

  async listWorkflowFiles(repo: RepoRef, sha: string): Promise<WorkflowFile[]> {
    const res = await this.request(repo, `${this.base(repo)}/contents/.upbeater?ref=${enc(sha)}`, { pass: [404] });
    if (res.status === 404) return [];
    const list = (await res.json()) as { type?: string; name?: string; path?: string }[];
    if (!Array.isArray(list)) return [];
    const files = list.filter((f) => f.type === "file" && typeof f.path === "string" && /\.ya?ml$/i.test(f.name ?? "")).slice(0, 50);
    const out: WorkflowFile[] = [];
    for (const f of files) {
      const r = await this.request(repo, `${this.base(repo)}/contents/${segs(f.path!)}?ref=${enc(sha)}`, { accept: "application/vnd.github.raw+json" });
      out.push({ path: f.path!, text: await r.text() });
    }
    return out.sort((a, b) => a.path.localeCompare(b.path));
  }

  async createCheckRun(repo: RepoRef, input: CheckRunInput): Promise<number> {
    const res = await this.request(repo, `${this.base(repo)}/check-runs`, { method: "POST", body: input });
    const id = ((await res.json()) as { id?: unknown }).id;
    if (typeof id !== "number") throw new GitHubError("GitHub の応答の形式が想定外です", res.status, true);
    return id;
  }

  async updateCheckRun(repo: RepoRef, id: number, input: CheckRunInput): Promise<void> {
    const { head_sha: _h, ...rest } = input;
    await this.request(repo, `${this.base(repo)}/check-runs/${id}`, { method: "PATCH", body: rest });
  }

  private async request(
    repo: RepoRef,
    path: string,
    opts: { method?: string; body?: unknown; pass?: number[]; accept?: string } = {},
    retried = false,
  ): Promise<Response> {
    const headers: Record<string, string> = {
      accept: opts.accept ?? "application/vnd.github+json",
      "x-github-api-version": "2022-11-28",
      "user-agent": "upbeater-hub",
    };
    const token = await this.tokens.getToken(repo);
    if (token) headers.authorization = `Bearer ${token}`;
    if (opts.body !== undefined) headers["content-type"] = "application/json";
    let res: Response;
    try {
      res = await this.fetchImpl(this.baseUrl.replace(/\/$/, "") + path, {
        method: opts.method ?? "GET",
        headers,
        body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
      });
    } catch {
      throw new GitHubError("GitHub に接続できません", 0, true);
    }
    if (res.ok || opts.pass?.includes(res.status)) return res;
    if (res.status === 401 && token && this.tokens.invalidate && !retried) {
      this.tokens.invalidate(repo);
      return this.request(repo, path, opts, true);
    }
    const ra = res.headers.get("retry-after");
    let wait = ra && /^\d+$/.test(ra) ? Number(ra) * 1000 : undefined;
    const remaining = res.headers.get("x-ratelimit-remaining");
    const reset = res.headers.get("x-ratelimit-reset");
    if (wait === undefined && remaining === "0" && reset && /^\d+$/.test(reset)) wait = Math.max(0, Number(reset) * 1000 - this.now());
    if (res.status === 429 || (res.status === 403 && (remaining === "0" || wait !== undefined))) throw new GitHubError("GitHub の回数制限", res.status, true, wait);
    if (res.status >= 500) throw new GitHubError("GitHub の障害", res.status, true, wait);
    const text = await res.text().catch(() => "");
    if (res.status === 401 || res.status === 403) throw new GitHubError(`GitHub の権限がありません：${text.slice(0, 200)}`, res.status, false, undefined, true);
    throw new GitHubError(`GitHub が想定外の応答（${res.status}）：${text.slice(0, 200)}`, res.status, false, undefined, true);
  }
}

export function githubFetch(env: Env): FetchLike {
  const binding = env.GITHUB_API;
  return binding ? (u, i) => binding.fetch(u, i) : (u, i) => fetch(u, i);
}

export function createGitHubTokenProvider(env: Env): GitHubTokenProvider {
  const base = env.GITHUB_API_BASE || "https://api.github.com";
  return env.GITHUB_APP_ID && env.GITHUB_APP_PRIVATE_KEY
    ? new GitHubAppTokenProvider(githubFetch(env), base, env.GITHUB_APP_ID, env.GITHUB_APP_PRIVATE_KEY)
    : new StaticTokenProvider(env.GITHUB_TOKEN);
}

export function createGitHubClient(env: Env): GitHubClient {
  return new HttpGitHubClient(githubFetch(env), env.GITHUB_API_BASE || "https://api.github.com", createGitHubTokenProvider(env));
}
