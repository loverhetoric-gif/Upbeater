-- 開発順序2：MCP（OAuth）と GitHub 操作

-- 利用者（GitHub のアカウントで識別する）
CREATE TABLE owners (
  id TEXT PRIMARY KEY,                     -- gh:<GitHub のユーザー ID>
  owner_id TEXT NOT NULL,                  -- 自分自身（全テーブルに owner_id を持たせる規約に合わせる）
  github_user_id INTEGER NOT NULL UNIQUE,
  github_login TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

-- OAuth のクライアント（claude.ai のコネクタなど。動的に登録される）
CREATE TABLE oauth_clients (
  client_id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL DEFAULT '',       -- 登録時点では利用者が決まらないため空
  client_name TEXT NOT NULL,
  redirect_uris TEXT NOT NULL,             -- JSON 配列
  created_at INTEGER NOT NULL
);

-- 認可の途中経過（GitHub でのログインと同意の画面のあいだ）
CREATE TABLE oauth_requests (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL DEFAULT '',       -- GitHub でのログイン後に決まる
  client_id TEXT NOT NULL,
  redirect_uri TEXT NOT NULL,
  state TEXT,
  code_challenge TEXT NOT NULL,
  scope TEXT,
  resource TEXT,
  csrf_hash TEXT,
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);

-- 認可コード（ハッシュのみ保存・一回限り）
CREATE TABLE oauth_codes (
  code_hash TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  grant_id TEXT NOT NULL,
  client_id TEXT NOT NULL,
  redirect_uri TEXT NOT NULL,
  code_challenge TEXT NOT NULL,
  scope TEXT,
  resource TEXT,
  expires_at INTEGER NOT NULL,
  used_at INTEGER,
  created_at INTEGER NOT NULL
);

-- アクセストークン・リフレッシュトークン（ハッシュのみ保存）
CREATE TABLE oauth_tokens (
  token_hash TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  grant_id TEXT NOT NULL,
  client_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('access', 'refresh')),
  scope TEXT,
  expires_at INTEGER NOT NULL,
  revoked_at INTEGER,
  created_at INTEGER NOT NULL
);
CREATE INDEX oauth_tokens_grant ON oauth_tokens (grant_id);

-- GitHub 操作を許可するリポジトリ
CREATE TABLE repo_allowlist (
  owner_id TEXT NOT NULL,
  repo_full_name TEXT NOT NULL,            -- 小文字の owner/repo
  created_at INTEGER NOT NULL,
  PRIMARY KEY (owner_id, repo_full_name)
);

-- GitHub 操作の依頼（依頼 ID で重複を検知し、失敗した段階から再開する）
CREATE TABLE github_requests (
  owner_id TEXT NOT NULL,
  request_id TEXT NOT NULL,
  tool TEXT NOT NULL,
  input_hash TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('running', 'succeeded', 'failed')),
  stage TEXT,
  state TEXT NOT NULL DEFAULT '{}',        -- 段階ごとの途中結果（JSON）
  result TEXT,
  error TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (owner_id, request_id)
);
