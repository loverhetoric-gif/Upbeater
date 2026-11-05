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

export type MergeResult = { merged: true; sha: string } | { merged: false; reason: "head_changed" | "not_mergeable"; message: string };

/** GitHub 操作の抽象 */
export interface GitHubClient {
  getBranchHead(repo: RepoRef, branch: string): Promise<string | null>;
  /** 指定のコミットの .upbeater/*.yml。フォルダが無ければ空 */
  listWorkflowFiles(repo: RepoRef, sha: string): Promise<WorkflowFile[]>;
  /** 指定のコミット（またはブランチ）のフォルダ直下の YAML。フォルダが無ければ空 */
  listYamlFiles(repo: RepoRef, ref: string, dir: string): Promise<WorkflowFile[]>;
  createCheckRun(repo: RepoRef, input: CheckRunInput): Promise<number>;
  updateCheckRun(repo: RepoRef, id: number, input: CheckRunInput): Promise<void>;
  /** コミットの状態（Checks の権限が無い時の代わり。Commit statuses の権限で書ける） */
  setCommitStatus(repo: RepoRef, sha: string, input: CommitStatusInput): Promise<void>;

  // ── GitHub 操作（ブランチ → コミット → PR → マージ） ──
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
  mergePull(repo: RepoRef, n: number, p: { sha: string; method: "merge" | "squash" | "rebase" }): Promise<MergeResult>;
  listPullFiles(repo: RepoRef, n: number): Promise<string[]>;
  compareFiles(repo: RepoRef, base: string, head: string): Promise<string[]>;
  getChecks(repo: RepoRef, sha: string): Promise<CheckState[]>;
  /** コミットを含む PR の番号 */
  listCommitPulls(repo: RepoRef, sha: string): Promise<number[]>;
}

function toPull(v: unknown): PullRequest {
  const p = v as {
    number: number;
    state: string;
    merged?: boolean;
    mergeable?: boolean | null;
    mergeable_state?: string;
    draft?: boolean;
    head: { ref: string; sha: string };
    base: { ref: string };
    html_url: string;
    merge_commit_sha?: string | null;
  };
  if (!p || typeof p.number !== "number" || !p.head || !p.base) throw new GitHubError("GitHub の応答の形式が想定外です", 200, true);
  return {
    number: p.number,
    state: p.state,
    merged: p.merged === true,
    mergeable: p.mergeable ?? null,
    mergeable_state: p.draft ? "draft" : (p.mergeable_state ?? "unknown"),
    head_ref: p.head.ref,
    head_sha: p.head.sha,
    base_ref: p.base.ref,
    html_url: p.html_url,
    merge_commit_sha: p.merge_commit_sha ?? null,
  };
}

function extractMessage(text: string): string {
  try {
    const j = JSON.parse(text) as { message?: string; errors?: { message?: string }[] };
    return [j.message, ...(j.errors ?? []).map((e) => e.message)].filter(Boolean).join("：").slice(0, 300);
  } catch {
    return text.slice(0, 300);
  }
}

export interface CommitStatusInput {
  state: "pending" | "success" | "failure" | "error";
  context: string;
  description: string;
  target_url?: string;
}

/** Checks の表示を、コミットの状態の形にする */
export function toCommitStatus(c: CheckRunInput): CommitStatusInput {
  const state: CommitStatusInput["state"] =
    c.status !== "completed" ? "pending" : c.conclusion === "failure" ? "failure" : c.conclusion === "cancelled" ? "error" : "success";
  const desc = (c.output?.title ?? (c.status === "completed" ? (c.conclusion ?? "") : c.status === "queued" ? "待っています" : "実行中")).replace(/\s+/g, " ");
  return { state, context: `Upbeater / ${c.name}`.slice(0, 255), description: [...desc].slice(0, 140).join(""), ...(c.details_url ? { target_url: c.details_url } : {}) };
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
    return this.listYamlFiles(repo, sha, ".upbeater");
  }

  async listYamlFiles(repo: RepoRef, sha: string, dir: string): Promise<WorkflowFile[]> {
    const res = await this.request(repo, `${this.base(repo)}/contents/${segs(dir)}?ref=${enc(sha)}`, { pass: [404] });
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

  async setCommitStatus(repo: RepoRef, sha: string, input: CommitStatusInput): Promise<void> {
    await this.request(repo, `${this.base(repo)}/statuses/${enc(sha)}`, { method: "POST", body: input });
  }

  async updateCheckRun(repo: RepoRef, id: number, input: CheckRunInput): Promise<void> {
    const { head_sha: _h, ...rest } = input;
    await this.request(repo, `${this.base(repo)}/check-runs/${id}`, { method: "PATCH", body: rest });
  }

  async getDefaultBranch(repo: RepoRef): Promise<string> {
    const res = await this.request(repo, this.base(repo), { pass: [404] });
    if (res.status === 404) throw new GitHubError("リポジトリが見つかりません（GitHub App が入っていない可能性）", 404, false, undefined, true);
    const b = ((await res.json()) as { default_branch?: unknown }).default_branch;
    if (typeof b !== "string") throw new GitHubError("GitHub の応答の形式が想定外です", 200, true);
    return b;
  }

  async createBranch(repo: RepoRef, branch: string, sha: string): Promise<"created" | "exists"> {
    const res = await this.request(repo, `${this.base(repo)}/git/refs`, { method: "POST", body: { ref: `refs/heads/${branch}`, sha }, pass: [422] });
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
    const res = await this.request(repo, `${this.base(repo)}/git/refs/heads/${segs(branch)}`, { method: "PATCH", body: { sha, force: false }, pass: [422] });
    return res.status === 422 ? "not_fast_forward" : "updated";
  }

  async findOpenPull(repo: RepoRef, head: string, base: string): Promise<PullRequest | null> {
    const res = await this.request(repo, `${this.base(repo)}/pulls?state=open&head=${enc(`${repo.owner}:${head}`)}&base=${enc(base)}`);
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
    const res = await this.request(repo, `${this.base(repo)}/pulls/${n}/update-branch`, { method: "PUT", body: { expected_head_sha: expectedHeadSha }, pass: [422] });
    return res.status === 422 ? "conflict" : "updated";
  }

  async mergePull(repo: RepoRef, n: number, p: { sha: string; method: "merge" | "squash" | "rebase" }): Promise<MergeResult> {
    const res = await this.request(repo, `${this.base(repo)}/pulls/${n}/merge`, { method: "PUT", body: { sha: p.sha, merge_method: p.method }, pass: [405, 409] });
    if (res.status === 409) return { merged: false, reason: "head_changed", message: extractMessage(await res.text()) };
    if (res.status === 405) return { merged: false, reason: "not_mergeable", message: extractMessage(await res.text()) };
    return { merged: true, sha: this.sha(((await res.json()) as { sha?: unknown }).sha, res.status) };
  }

  async listPullFiles(repo: RepoRef, n: number): Promise<string[]> {
    const res = await this.request(repo, `${this.base(repo)}/pulls/${n}/files?per_page=100`);
    return ((await res.json()) as { filename?: string }[]).map((f) => f.filename ?? "").filter(Boolean);
  }

  async compareFiles(repo: RepoRef, base: string, head: string): Promise<string[]> {
    const res = await this.request(repo, `${this.base(repo)}/compare/${enc(base)}...${enc(head)}`);
    return (((await res.json()) as { files?: { filename?: string }[] }).files ?? []).map((f) => f.filename ?? "").filter(Boolean);
  }

  async getChecks(repo: RepoRef, sha: string): Promise<CheckState[]> {
    const out: CheckState[] = [];
    const runs = await this.request(repo, `${this.base(repo)}/commits/${enc(sha)}/check-runs?per_page=100`);
    for (const r of ((await runs.json()) as { check_runs?: { name: string; status: string; conclusion: string | null }[] }).check_runs ?? []) {
      out.push({ name: r.name, state: r.status !== "completed" ? "pending" : ["success", "neutral", "skipped"].includes(r.conclusion ?? "") ? "success" : "failure" });
    }
    const st = await this.request(repo, `${this.base(repo)}/commits/${enc(sha)}/status`);
    for (const s of ((await st.json()) as { statuses?: { context: string; state: string }[] }).statuses ?? []) {
      out.push({ name: s.context, state: s.state === "success" ? "success" : s.state === "pending" ? "pending" : "failure" });
    }
    return out;
  }

  async listCommitPulls(repo: RepoRef, sha: string): Promise<number[]> {
    const res = await this.request(repo, `${this.base(repo)}/commits/${enc(sha)}/pulls?per_page=20`, { pass: [404, 422] });
    if (!res.ok) return [];
    const list = (await res.json()) as { number?: unknown }[];
    return Array.isArray(list) ? list.map((x) => x.number).filter((n): n is number => typeof n === "number") : [];
  }

  private sha(v: unknown, status: number): string {
    if (typeof v !== "string" || !/^[0-9a-f]{40}([0-9a-f]{24})?$/.test(v)) throw new GitHubError("GitHub の応答の形式が想定外です", status, true);
    return v;
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
