/**
 * GitHub との通信。
 * - 通信の実体（fetch）とトークンの取得方法を差し替え可能にしている（テストでは模擬 GitHub を束縛する）
 * - 失敗は GitHubError に統一する。retryable なら待ち行列に残して再試行、needsHuman なら利用者の判断が要る
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

/** 認証トークンの取得方法 */
export interface GitHubTokenProvider {
  getToken(repo: RepoRef): Promise<string | null>;
  /** トークンが拒否された時に呼ばれる（取り直しのため） */
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
    /** GitHub が指定した待ち時間（回数制限など） */
    public readonly retryAfterMs?: number,
    public readonly needsHuman = false,
  ) {
    super(message);
    this.name = "GitHubError";
  }
}

export interface PullRequest {
  number: number;
  state: string;
  merged: boolean;
  mergeable: boolean | null;
  mergeable_state: string;
  head_ref: string;
  head_sha: string;
  base_ref: string;
  html_url: string;
  merge_commit_sha: string | null;
}

export interface CheckState {
  name: string;
  state: "success" | "pending" | "failure";
}

export interface TreeEntry {
  path: string;
  /** null は削除 */
  sha: string | null;
  mode?: string;
}

/** GitHub 操作の抽象 */
export interface GitHubClient {
  /** 対象ブランチの現在のコミット SHA。ブランチ・リポジトリが無ければ null */
  getBranchHead(repo: RepoRef, branch: string): Promise<string | null>;
  getDefaultBranch(repo: RepoRef): Promise<string>;
  createBranch(repo: RepoRef, branch: string, sha: string): Promise<"created" | "exists">;
  getCommitTree(repo: RepoRef, sha: string): Promise<string>;
  createBlob(repo: RepoRef, base64: string): Promise<string>;
  createTree(repo: RepoRef, baseTree: string, entries: TreeEntry[]): Promise<string>;
  createCommit(repo: RepoRef, message: string, tree: string, parents: string[]): Promise<string>;
  /** 早送りでのみ更新する。先に進んでいて早送りできなければ "not_fast_forward" */
  updateBranch(repo: RepoRef, branch: string, sha: string): Promise<"updated" | "not_fast_forward">;
  findOpenPull(repo: RepoRef, head: string, base: string): Promise<PullRequest | null>;
  createPull(repo: RepoRef, p: { head: string; base: string; title: string; body: string }): Promise<PullRequest | "exists">;
  getPull(repo: RepoRef, n: number): Promise<PullRequest>;
  /** base を取り込む。衝突すれば "conflict" */
  updatePullBranch(repo: RepoRef, n: number, expectedHeadSha: string): Promise<"updated" | "conflict">;
  mergePull(
    repo: RepoRef,
    n: number,
    p: { sha: string; method: "merge" | "squash" | "rebase"; title?: string },
  ): Promise<{ merged: true; sha: string } | { merged: false; reason: "head_changed" | "not_mergeable"; message: string }>;
  listPullFiles(repo: RepoRef, n: number): Promise<string[]>;
  compareFiles(repo: RepoRef, base: string, head: string): Promise<string[]>;
  getChecks(repo: RepoRef, sha: string): Promise<CheckState[]>;
}

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

interface RequestOptions {
  method?: string;
  body?: unknown;
  /** エラーとして扱わず、呼び出し側に返す状態番号 */
  pass?: number[];
}

const enc = (s: string) => encodeURIComponent(s);
const refPath = (branch: string) => branch.split("/").map(enc).join("/");

export class HttpGitHubClient implements GitHubClient {
  constructor(
    private readonly fetchImpl: FetchLike,
    private readonly baseUrl: string,
    private readonly tokens: GitHubTokenProvider,
    private readonly now: () => number = Date.now,
  ) {}

  private base(repo: RepoRef): string {
    return `/repos/${enc(repo.owner)}/${enc(repo.name)}`;
  }

  async getBranchHead(repo: RepoRef, branch: string): Promise<string | null> {
    const res = await this.request(repo, `${this.base(repo)}/git/ref/heads/${refPath(branch)}`, { pass: [404, 409] });
    if (res.status === 404 || res.status === 409) return null; // ブランチ削除・空のリポジトリ
    const sha = ((await res.json()) as { object?: { sha?: unknown } }).object?.sha;
    return this.sha(sha, res.status);
  }

  async getDefaultBranch(repo: RepoRef): Promise<string> {
    const res = await this.request(repo, this.base(repo), { pass: [404] });
    if (res.status === 404) throw new GitHubError("リポジトリが見つかりません（権限不足の可能性）", 404, false, undefined, true);
    const b = ((await res.json()) as { default_branch?: unknown }).default_branch;
    if (typeof b !== "string") throw new GitHubError("GitHub の応答の形式が想定外です", 200, true);
    return b;
  }

  async createBranch(repo: RepoRef, branch: string, sha: string): Promise<"created" | "exists"> {
    const res = await this.request(repo, `${this.base(repo)}/git/refs`, {
      method: "POST",
      body: { ref: `refs/heads/${branch}`, sha },
      pass: [422],
    });
    return res.status === 422 ? "exists" : "created";
  }

  async getCommitTree(repo: RepoRef, sha: string): Promise<string> {
    const res = await this.request(repo, `${this.base(repo)}/git/commits/${enc(sha)}`);
    return this.sha(((await res.json()) as { tree?: { sha?: unknown } }).tree?.sha, res.status);
  }

  async createBlob(repo: RepoRef, base64: string): Promise<string> {
    const res = await this.request(repo, `${this.base(repo)}/git/blobs`, { method: "POST", body: { content: base64, encoding: "base64" } });
    return this.sha(((await res.json()) as { sha?: unknown }).sha, res.status);
  }

  async createTree(repo: RepoRef, baseTree: string, entries: TreeEntry[]): Promise<string> {
    const tree = entries.map((e) => ({ path: e.path, mode: e.mode ?? "100644", type: "blob", sha: e.sha }));
    const res = await this.request(repo, `${this.base(repo)}/git/trees`, { method: "POST", body: { base_tree: baseTree, tree } });
    return this.sha(((await res.json()) as { sha?: unknown }).sha, res.status);
  }

  async createCommit(repo: RepoRef, message: string, tree: string, parents: string[]): Promise<string> {
    const res = await this.request(repo, `${this.base(repo)}/git/commits`, { method: "POST", body: { message, tree, parents } });
    return this.sha(((await res.json()) as { sha?: unknown }).sha, res.status);
  }

  async updateBranch(repo: RepoRef, branch: string, sha: string): Promise<"updated" | "not_fast_forward"> {
    const res = await this.request(repo, `${this.base(repo)}/git/refs/heads/${refPath(branch)}`, {
      method: "PATCH",
      body: { sha, force: false },
      pass: [422],
    });
    return res.status === 422 ? "not_fast_forward" : "updated";
  }

  async findOpenPull(repo: RepoRef, head: string, base: string): Promise<PullRequest | null> {
    const q = `?state=open&head=${enc(`${repo.owner}:${head}`)}&base=${enc(base)}`;
    const res = await this.request(repo, `${this.base(repo)}/pulls${q}`);
    const list = (await res.json()) as unknown[];
    return Array.isArray(list) && list[0] ? toPull(list[0]) : null;
  }

  async createPull(repo: RepoRef, p: { head: string; base: string; title: string; body: string }): Promise<PullRequest | "exists"> {
    const res = await this.request(repo, `${this.base(repo)}/pulls`, { method: "POST", body: p, pass: [422] });
    if (res.status === 422) {
      const text = await res.text();
      if (/already exists/i.test(text)) return "exists";
      throw new GitHubError(`PR を作成できません：${extractMessage(text)}`, 422, false, undefined, true);
    }
    return toPull(await res.json());
  }

  async getPull(repo: RepoRef, n: number): Promise<PullRequest> {
    const res = await this.request(repo, `${this.base(repo)}/pulls/${n}`, { pass: [404] });
    if (res.status === 404) throw new GitHubError(`PR #${n} が見つかりません`, 404, false, undefined, true);
    return toPull(await res.json());
  }

  async updatePullBranch(repo: RepoRef, n: number, expectedHeadSha: string): Promise<"updated" | "conflict"> {
    const res = await this.request(repo, `${this.base(repo)}/pulls/${n}/update-branch`, {
      method: "PUT",
      body: { expected_head_sha: expectedHeadSha },
      pass: [422],
    });
    return res.status === 422 ? "conflict" : "updated";
  }

  async mergePull(
    repo: RepoRef,
    n: number,
    p: { sha: string; method: "merge" | "squash" | "rebase"; title?: string },
  ): Promise<{ merged: true; sha: string } | { merged: false; reason: "head_changed" | "not_mergeable"; message: string }> {
    const res = await this.request(repo, `${this.base(repo)}/pulls/${n}/merge`, {
      method: "PUT",
      body: { sha: p.sha, merge_method: p.method, ...(p.title ? { commit_title: p.title } : {}) },
      pass: [405, 409],
    });
    if (res.status === 409) return { merged: false, reason: "head_changed", message: extractMessage(await res.text()) };
    if (res.status === 405) return { merged: false, reason: "not_mergeable", message: extractMessage(await res.text()) };
    const b = (await res.json()) as { merged?: unknown; sha?: unknown };
    return { merged: true, sha: this.sha(b.sha, res.status) };
  }

  async listPullFiles(repo: RepoRef, n: number): Promise<string[]> {
    const res = await this.request(repo, `${this.base(repo)}/pulls/${n}/files?per_page=100`);
    return ((await res.json()) as { filename?: string }[]).map((f) => f.filename ?? "").filter(Boolean);
  }

  async compareFiles(repo: RepoRef, base: string, head: string): Promise<string[]> {
    const res = await this.request(repo, `${this.base(repo)}/compare/${enc(base)}...${enc(head)}`);
    const files = ((await res.json()) as { files?: { filename?: string }[] }).files ?? [];
    return files.map((f) => f.filename ?? "").filter(Boolean);
  }

  async getChecks(repo: RepoRef, sha: string): Promise<CheckState[]> {
    const out: CheckState[] = [];
    const runs = await this.request(repo, `${this.base(repo)}/commits/${enc(sha)}/check-runs?per_page=100`);
    for (const r of ((await runs.json()) as { check_runs?: { name: string; status: string; conclusion: string | null }[] }).check_runs ?? []) {
      out.push({
        name: r.name,
        state: r.status !== "completed" ? "pending" : ["success", "neutral", "skipped"].includes(r.conclusion ?? "") ? "success" : "failure",
      });
    }
    const st = await this.request(repo, `${this.base(repo)}/commits/${enc(sha)}/status`);
    for (const s of ((await st.json()) as { statuses?: { context: string; state: string }[] }).statuses ?? []) {
      out.push({ name: s.context, state: s.state === "success" ? "success" : s.state === "pending" ? "pending" : "failure" });
    }
    return out;
  }

  private sha(v: unknown, status: number): string {
    if (typeof v !== "string" || !/^[0-9a-f]{40}([0-9a-f]{24})?$/.test(v)) {
      throw new GitHubError("GitHub の応答の形式が想定外です", status, true);
    }
    return v;
  }

  private async request(repo: RepoRef, path: string, opts: RequestOptions = {}, retried = false): Promise<Response> {
    const headers: Record<string, string> = {
      accept: "application/vnd.github+json",
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

    // 期限切れ・取り消されたトークンは一度だけ取り直す
    if (res.status === 401 && token && this.tokens.invalidate && !retried) {
      this.tokens.invalidate(repo);
      return this.request(repo, path, opts, true);
    }
    const wait = this.retryAfter(res);
    const remaining = res.headers.get("x-ratelimit-remaining");
    if (res.status === 429 || (res.status === 403 && (remaining === "0" || wait !== undefined))) {
      throw new GitHubError("GitHub の回数制限", res.status, true, wait);
    }
    if (res.status >= 500) throw new GitHubError("GitHub の障害", res.status, true, wait);
    const message = extractMessage(await res.text().catch(() => ""));
    if (res.status === 401 || res.status === 403) {
      throw new GitHubError(`GitHub の権限がありません（資格情報の失効・権限不足）：${message}`, res.status, false, undefined, true);
    }
    throw new GitHubError(`GitHub が想定外の応答（${res.status}）：${message}`, res.status, false, undefined, true);
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

function extractMessage(text: string): string {
  try {
    const v = JSON.parse(text) as { message?: unknown; errors?: { message?: unknown }[] };
    const detail = v.errors?.map((e) => e.message).filter((m) => typeof m === "string").join("、");
    return [typeof v.message === "string" ? v.message : "", detail].filter(Boolean).join("：").slice(0, 500);
  } catch {
    return text.slice(0, 200);
  }
}

function toPull(v: unknown): PullRequest {
  const p = v as {
    number: number;
    state: string;
    merged?: boolean;
    mergeable?: boolean | null;
    mergeable_state?: string;
    head: { ref: string; sha: string };
    base: { ref: string };
    html_url: string;
    merge_commit_sha?: string | null;
  };
  return {
    number: p.number,
    state: p.state,
    merged: p.merged ?? false,
    mergeable: p.mergeable ?? null,
    mergeable_state: p.mergeable_state ?? "unknown",
    head_ref: p.head.ref,
    head_sha: p.head.sha,
    base_ref: p.base.ref,
    html_url: p.html_url,
    merge_commit_sha: p.merge_commit_sha ?? null,
  };
}

export function githubFetch(env: Env): FetchLike {
  const binding = env.GITHUB_API;
  return binding ? (u, i) => binding.fetch(u, i) : (u, i) => fetch(u, i);
}

export function createGitHubClient(env: Env): GitHubClient {
  const base = env.GITHUB_API_BASE || "https://api.github.com";
  const f = githubFetch(env);
  // GitHub App が設定されていればインストールトークン、なければ暫定トークン（または認証なし）
  const tokens: GitHubTokenProvider =
    env.GITHUB_APP_ID && env.GITHUB_APP_PRIVATE_KEY
      ? new GitHubAppTokenProvider(f, base, env.GITHUB_APP_ID, env.GITHUB_APP_PRIVATE_KEY)
      : new StaticTokenProvider(env.GITHUB_TOKEN);
  return new HttpGitHubClient(f, base, tokens);
}
