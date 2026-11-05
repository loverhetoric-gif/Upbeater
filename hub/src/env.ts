/** Worker に渡される束縛（バインディング）と設定 */
export interface Env {
  DB: D1Database;
  ARTIFACTS: R2Bucket;
  APP_COORDINATOR: DurableObjectNamespace;

  /** GitHub API への接続口。未設定なら通常の fetch を使う（テストでは模擬実装を束縛する） */
  GITHUB_API?: Fetcher;
  GITHUB_API_BASE?: string;

  // Secret
  WEBHOOK_SECRET?: string;
  MANIFEST_SIGNING_KEYS?: string;
  DOWNLOAD_TOKEN_SECRET?: string;
  ADMIN_TOKEN?: string;
  GITHUB_TOKEN?: string;
  GITHUB_APP_PRIVATE_KEY?: string;
  /** GitHub App のユーザー認証（MCP の OAuth で利用者を確かめる） */
  GITHUB_APP_CLIENT_SECRET?: string;

  // 設定値
  GITHUB_APP_ID?: string;
  GITHUB_APP_CLIENT_ID?: string;
  /** GitHub の Web 側（OAuth の画面・トークン交換） */
  GITHUB_WEB_BASE?: string;
  /** MCP を使える GitHub アカウント（ログイン名または数値 ID、カンマ区切り）。空なら誰も使えない */
  ALLOWED_GITHUB_USERS?: string;
  /** マージ可否の再確認の間隔（ミリ秒） */
  GITHUB_POLL_MS?: string;
  MANIFEST_REVOKED_GENERATIONS?: string;
  ARTIFACT_URL_TTL_SECONDS?: string;
}

export const SUPPORTED_OS = ["android", "ios", "macos", "linux"] as const;
export type DeviceOs = (typeof SUPPORTED_OS)[number];
export const APP_KINDS = ["direct", "build", "release"] as const;
export type AppKind = (typeof APP_KINDS)[number];

export interface AppRow {
  id: string;
  owner_id: string;
  name: string;
  repo_full_name: string;
  branch: string;
  kind: AppKind;
  target_os: string;
  install_steps: string;
  last_seq: number;
  current_sha: string | null;
  pinned_seq: number | null;
  last_checked_at: number | null;
  created_at: number;
  updated_at: number;
}

export interface ReleaseRow {
  id: string;
  owner_id: string;
  app_id: string;
  seq: number;
  commit_sha: string;
  os: string;
  r2_key: string | null;
  sha256: string | null;
  size: number | null;
  status: "pending" | "ready" | "failed" | "cancelled" | "halted";
  created_at: number;
  updated_at: number;
}

export interface DeviceRow {
  id: string;
  owner_id: string;
  name: string;
  os: DeviceOs;
  push_token: string | null;
  token_hash: string;
  created_at: number;
  last_seen_at: number | null;
}
