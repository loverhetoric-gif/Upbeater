/**
 * GitHub との通信。
 * 認証（GitHub App）は開発順序2で入れるため、トークンの取得と通信の実体を差し替え可能にしている。
 */
import type { Env } from "./env";

export interface RepoRef {
  owner: string;
  name: string;
}

export function parseRepo(fullName: string): RepoRef {
  const [owner, name, ...rest] = fullName.split("/");
  if (!owner || !name || rest.length) throw new Error("リポジトリ名の形式が正しくありません");
  return { owner, name };
}

/** GitHub 操作の抽象。テストや GitHub App 版で差し替える */
export interface GitHubClient {
  /** 対象ブランチの現在のコミット SHA。ブランチ・リポジトリが無ければ null */
  getBranchHead(repo: RepoRef, branch: string): Promise<string | null>;
}

/** 認証トークンの取得方法（開発順序2で GitHub App のインストールトークンに差し替える） */
export interface GitHubTokenProvider {
  getToken(repo: RepoRef): Promise<string | null>;
}

export class StaticTokenProvider implements GitHubTokenProvider {
  constructor(private readonly token: string | undefined) {}
  async getToken(): Promise<string | null> {
    return this.token ? this.token : null;
  }
}

/** GitHub 側の失敗。retryable なら待ち行列に残して再試行する */
export class GitHubError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly retryable: boolean,
    /** GitHub が指定した待ち時間（回数制限など） */
    public readonly retryAfterMs?: number,
    public readonly needsHuman = false,
  ) {
    super(message);
    this.name = "GitHubError";
  }
}

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export class HttpGitHubClient implements GitHubClient {
  constructor(
    private readonly fetchImpl: FetchLike,
    private readonly baseUrl: string,
    private readonly tokens: GitHubTokenProvider,
    private readonly now: () => number = Date.now,
  ) {}

  async getBranchHead(repo: RepoRef, branch: string): Promise<string | null> {
    const ref = branch.split("/").map(encodeURIComponent).join("/");
    const path = `/repos/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.name)}/git/ref/heads/${ref}`;
    const res = await this.request(repo, path);
    if (res.status === 404 || res.status === 409) return null; // ブランチ削除・空のリポジトリ
    const body = (await res.json()) as { object?: { sha?: unknown; type?: unknown } };
    const sha = body.object?.sha;
    if (typeof sha !== "string" || !/^[0-9a-f]{40}([0-9a-f]{24})?$/.test(sha)) {
      throw new GitHubError("GitHub の応答の形式が想定外です", res.status, true);
    }
    return sha;
  }

  private async request(repo: RepoRef, path: string): Promise<Response> {
    const headers: Record<string, string> = {
      accept: "application/vnd.github+json",
      "x-github-api-version": "2022-11-28",
      "user-agent": "upbeater-hub",
    };
    const token = await this.tokens.getToken(repo);
    if (token) headers.authorization = `Bearer ${token}`;

    let res: Response;
    try {
      res = await this.fetchImpl(this.baseUrl.replace(/\/$/, "") + path, { headers });
    } catch {
      throw new GitHubError("GitHub に接続できません", 0, true);
    }
    if (res.ok || res.status === 404 || res.status === 409) return res;

    const wait = this.retryAfter(res);
    const remaining = res.headers.get("x-ratelimit-remaining");
    if (res.status === 429 || (res.status === 403 && (remaining === "0" || wait !== undefined))) {
      throw new GitHubError("GitHub の回数制限", res.status, true, wait);
    }
    if (res.status >= 500) throw new GitHubError("GitHub の障害", res.status, true, wait);
    if (res.status === 401 || res.status === 403) {
      throw new GitHubError("GitHub の権限がありません（資格情報の失効・権限不足）", res.status, false, undefined, true);
    }
    throw new GitHubError(`GitHub が想定外の応答（${res.status}）`, res.status, false, undefined, true);
  }

  private retryAfter(res: Response): number | undefined {
    const ra = res.headers.get("retry-after");
    if (ra && /^\d+$/.test(ra)) return Number(ra) * 1000;
    const reset = res.headers.get("x-ratelimit-reset");
    if (res.headers.get("x-ratelimit-remaining") === "0" && reset && /^\d+$/.test(reset)) {
      return Math.max(0, Number(reset) * 1000 - this.now());
    }
    return undefined;
  }
}

export function createGitHubClient(env: Env): GitHubClient {
  const binding = env.GITHUB_API;
  const fetchImpl: FetchLike = binding ? (u, i) => binding.fetch(u, i) : (u, i) => fetch(u, i);
  return new HttpGitHubClient(fetchImpl, env.GITHUB_API_BASE || "https://api.github.com", new StaticTokenProvider(env.GITHUB_TOKEN));
}
