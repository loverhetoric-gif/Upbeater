-- Upbeater Hub 初期スキーマ
-- 全テーブルに owner_id を持たせ、複数の利用者に対応する。時刻はすべてミリ秒の UNIX 時刻。

-- 配信対象のアプリ
CREATE TABLE apps (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  name TEXT NOT NULL,
  repo_full_name TEXT NOT NULL,            -- 小文字の owner/repo
  branch TEXT NOT NULL DEFAULT 'main',     -- 対象ブランチ
  kind TEXT NOT NULL CHECK (kind IN ('direct', 'build', 'release')),
  target_os TEXT NOT NULL DEFAULT '[]',    -- JSON 配列
  install_steps TEXT NOT NULL DEFAULT '{}',-- OS ごとの手順（JSON）
  last_seq INTEGER NOT NULL DEFAULT 0,     -- Hub が発行した最新の通番
  current_sha TEXT,                        -- 最新の通番に対応するコミット
  pinned_seq INTEGER,                      -- 明示的な巻き戻し先（NULL なら最新）
  last_checked_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (owner_id, name)
);
CREATE INDEX apps_repo_branch ON apps (repo_full_name, branch);

-- 版（コミット SHA と単調増加の通番）。強制プッシュで過去のコミットに戻っても新しい通番になる
CREATE TABLE app_versions (
  owner_id TEXT NOT NULL,
  app_id TEXT NOT NULL REFERENCES apps (id),
  seq INTEGER NOT NULL,
  commit_sha TEXT NOT NULL,
  source TEXT NOT NULL,                    -- webhook / cron / retry など
  created_at INTEGER NOT NULL,
  PRIMARY KEY (app_id, seq)
);

-- OS ごとの配布物
CREATE TABLE releases (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  app_id TEXT NOT NULL REFERENCES apps (id),
  seq INTEGER NOT NULL,
  commit_sha TEXT NOT NULL,
  os TEXT NOT NULL,
  r2_key TEXT,
  sha256 TEXT,
  size INTEGER,
  status TEXT NOT NULL CHECK (status IN ('pending', 'ready', 'failed', 'cancelled', 'halted')),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (app_id, seq, os)
);
CREATE INDEX releases_lookup ON releases (app_id, os, status, seq);

-- 端末（認証トークンはハッシュのみ保存）
CREATE TABLE devices (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  name TEXT NOT NULL,
  os TEXT NOT NULL CHECK (os IN ('android', 'ios', 'macos', 'linux')),
  push_token TEXT,
  token_hash TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL,
  last_seen_at INTEGER
);

-- 一回限りの登録コード（ハッシュのみ保存）
CREATE TABLE registration_codes (
  code_hash TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  used_at INTEGER,
  device_id TEXT,
  created_at INTEGER NOT NULL
);

-- 端末ごとの現在の導入状態
CREATE TABLE installs (
  owner_id TEXT NOT NULL,
  device_id TEXT NOT NULL REFERENCES devices (id),
  app_id TEXT NOT NULL REFERENCES apps (id),
  seq INTEGER NOT NULL,
  commit_sha TEXT,
  status TEXT NOT NULL,
  message TEXT,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (device_id, app_id)
);

-- GitHub 操作・同期・配信の履歴（段階・結果・理由・再試行の可否）
CREATE TABLE operations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  owner_id TEXT NOT NULL,
  app_id TEXT,
  device_id TEXT,
  kind TEXT NOT NULL,
  stage TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('ok', 'retry', 'failed')),
  reason TEXT,
  retryable INTEGER NOT NULL DEFAULT 0,
  needs_human INTEGER NOT NULL DEFAULT 0,
  detail TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX operations_app ON operations (app_id, created_at);

-- 受信済みの Webhook（重複を捨てるため）
CREATE TABLE webhook_deliveries (
  delivery_id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL DEFAULT '',       -- 対象アプリの所有者（該当なしは空）
  event TEXT NOT NULL,
  received_at INTEGER NOT NULL
);
CREATE INDEX webhook_deliveries_received ON webhook_deliveries (received_at);
