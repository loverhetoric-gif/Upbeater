/** Worker に渡される束縛（バインディング）と設定 */
export interface Env {
  DB: D1Database;
  /** ログ・成果物・キャッシュ */
  BLOBS: R2Bucket;
  REPO_COORDINATOR: DurableObjectNamespace;

  /** GitHub API への接続口。未設定なら通常の fetch（テストでは模擬実装を束縛する） */
  GITHUB_API?: Fetcher;
  GITHUB_API_BASE?: string;
  GITHUB_WEB_BASE?: string;
  GITHUB_APP_ID?: string;
  /** Upbeater 自身（GitHub App）のログイン名。自分のコミットを合図にしないために使う */
  UPBEATER_BOT_LOGIN?: string;
  MANIFEST_REVOKED_GENERATIONS?: string;
  /** GitHub App の Client ID（MCP の OAuth で GitHub にログインしてもらう。秘密情報ではない） */
  GITHUB_APP_CLIENT_ID?: string;
  /** MCP に接続できる GitHub のアカウント（ログイン名か数値 ID をカンマ区切り） */
  ALLOWED_GITHUB_USERS?: string;
  /** マージの可否の判定を待つ間隔（ミリ秒。テストで短くする） */
  GITHUB_POLL_MS?: string;

  // Secret
  WEBHOOK_SECRET?: string;
  /** 秘密情報を暗号化する鍵（32 バイトを base64） */
  SECRETS_KEY?: string;
  ADMIN_TOKEN?: string;
  GITHUB_APP_PRIVATE_KEY?: string;
  /** GitHub App の Client secret（MCP の OAuth） */
  GITHUB_APP_CLIENT_SECRET?: string;
  GITHUB_TOKEN?: string;
  MANIFEST_SIGNING_KEYS?: string;
}

export interface RepoRow {
  id: string;
  owner_id: string;
  full_name: string;
  default_branch: string;
  trigger_on_own_commits: number;
  last_seen_sha: string | null;
  last_reconciled_at: number | null;
  next_run_number: number;
  paused: number;
  created_at: number;
}

export type JobStatus = "waiting" | "blocked" | "queued" | "claimed" | "succeeded" | "failed" | "cancelled" | "skipped";
export const TERMINAL: readonly JobStatus[] = ["succeeded", "failed", "cancelled", "skipped"];

export interface JobRow {
  id: string;
  owner_id: string;
  run_id: string;
  repo_id: string;
  job_key: string;
  name: string;
  matrix: string | null;
  needs: string;
  if_expr: string | null;
  runs_on: string;
  spec: string;
  concurrency_group: string | null;
  cancel_in_progress: number;
  rerunnable: number;
  status: JobStatus;
  reason: string | null;
  attempt: number;
  runner_id: string | null;
  job_token_hash: string | null;
  cancel_requested: number;
  claimed_at: number | null;
  heartbeat_at: number | null;
  finished_at: number | null;
  waiting_notified: number;
  created_at: number;
  updated_at: number;
}

export interface RunRow {
  id: string;
  owner_id: string;
  repo_id: string;
  number: number;
  workflow_file: string;
  workflow_name: string;
  event: string;
  ref: string | null;
  branch: string | null;
  sha: string;
  actor: string | null;
  is_fork: number;
  status: "queued" | "running" | "completed";
  conclusion: string | null;
  problems: string | null;
  inputs: string | null;
  created_at: number;
  updated_at: number;
}

/** ジョブの中身（jobs.spec） */
export interface JobSpec {
  steps: unknown[];
  env: Record<string, string>;
  secrets: string[];
  timeout: number;
  artifacts: { name: string; path: string }[];
  cache?: { key: string; paths: string[] };
}
