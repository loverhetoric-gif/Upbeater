-- Upbeater Hub 初期スキーマ（GitHub Actions の代替）
-- 全テーブルに owner_id を持たせ、複数の利用者に対応する。時刻はすべてミリ秒の UNIX 時刻。

-- 対象のリポジトリ
CREATE TABLE repos (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  full_name TEXT NOT NULL,                  -- 小文字の owner/name
  default_branch TEXT NOT NULL DEFAULT 'main',
  trigger_on_own_commits INTEGER NOT NULL DEFAULT 0, -- Upbeater 自身のコミットを合図にするか（既定はしない）
  last_seen_sha TEXT,                       -- 既定ブランチで最後に処理したコミット
  last_reconciled_at INTEGER,
  next_run_number INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  UNIQUE (owner_id, full_name)
);
CREATE INDEX repos_full_name ON repos (full_name);

-- 定義ファイルの写し（既定ブランチの内容。定期実行・手動実行・ブランチ削除の合図で使う）
CREATE TABLE workflows (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  repo_id TEXT NOT NULL REFERENCES repos (id),
  file TEXT NOT NULL,
  commit_sha TEXT NOT NULL,
  name TEXT,
  definition TEXT,                          -- 解析済みの定義（JSON）。誤りがあれば NULL
  problems TEXT,                            -- 誤り（JSON）
  updated_at INTEGER NOT NULL,
  UNIQUE (repo_id, file)
);

-- 定期実行の実行履歴（抜けた回を一度だけ補うため）
CREATE TABLE schedules (
  owner_id TEXT NOT NULL,
  workflow_id TEXT NOT NULL REFERENCES workflows (id),
  cron TEXT NOT NULL,
  last_due INTEGER NOT NULL,
  PRIMARY KEY (workflow_id, cron)
);

-- 実行（1 つの合図 × 1 つの定義ファイル）
CREATE TABLE runs (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  repo_id TEXT NOT NULL REFERENCES repos (id),
  number INTEGER NOT NULL,                  -- リポジトリごとに単調増加
  workflow_file TEXT NOT NULL,
  workflow_name TEXT NOT NULL,
  event TEXT NOT NULL,                      -- push・pull_request・delete・schedule・manual
  ref TEXT,
  branch TEXT,
  sha TEXT NOT NULL,
  actor TEXT,
  is_fork INTEGER NOT NULL DEFAULT 0,       -- フォークからの PR（秘密情報を渡さない）
  status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'completed')),
  conclusion TEXT CHECK (conclusion IN ('success', 'failure', 'cancelled', 'definition_error')),
  problems TEXT,                            -- 定義ファイルの誤り（JSON）
  inputs TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (repo_id, number)
);
CREATE INDEX runs_repo_sha ON runs (repo_id, sha);

-- ジョブ（matrix は展開済み）
CREATE TABLE jobs (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  run_id TEXT NOT NULL REFERENCES runs (id),
  repo_id TEXT NOT NULL REFERENCES repos (id),
  job_key TEXT NOT NULL,                    -- 定義ファイル上のジョブ名
  name TEXT NOT NULL,
  matrix TEXT,
  needs TEXT NOT NULL DEFAULT '[]',
  if_expr TEXT,
  runs_on TEXT NOT NULL,                    -- ラベル（JSON 配列）
  spec TEXT NOT NULL,                       -- 手順・環境変数・秘密情報の名前・時間の上限など（JSON）
  concurrency_group TEXT,
  cancel_in_progress INTEGER NOT NULL DEFAULT 1,
  rerunnable INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL CHECK (status IN ('waiting', 'blocked', 'queued', 'claimed', 'succeeded', 'failed', 'cancelled', 'skipped')),
  reason TEXT,
  attempt INTEGER NOT NULL DEFAULT 0,
  runner_id TEXT,
  job_token_hash TEXT,                      -- 受け取った Runner だけが報告できるようにする（ハッシュのみ）
  cancel_requested INTEGER NOT NULL DEFAULT 0,
  claimed_at INTEGER,
  heartbeat_at INTEGER,
  finished_at INTEGER,
  waiting_notified INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX jobs_queue ON jobs (owner_id, status, created_at);
CREATE INDEX jobs_run ON jobs (run_id);
CREATE INDEX jobs_group ON jobs (repo_id, concurrency_group, status);

-- 手順ごとの状態（ログ本体は R2）
CREATE TABLE steps (
  owner_id TEXT NOT NULL,
  job_id TEXT NOT NULL REFERENCES jobs (id),
  attempt INTEGER NOT NULL,
  idx INTEGER NOT NULL,
  name TEXT,
  status TEXT NOT NULL,
  exit_code INTEGER,
  started_at INTEGER,
  finished_at INTEGER,
  PRIMARY KEY (job_id, attempt, idx)
);

-- ログの断片（通番で並べ直す。本体は R2）
CREATE TABLE log_chunks (
  owner_id TEXT NOT NULL,
  job_id TEXT NOT NULL REFERENCES jobs (id),
  attempt INTEGER NOT NULL,
  seq INTEGER NOT NULL,
  r2_key TEXT NOT NULL,
  size INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (job_id, attempt, seq)
);

-- Runner（トークンはハッシュのみ保存）
CREATE TABLE runners (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  name TEXT NOT NULL,
  labels TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL,
  last_seen_at INTEGER,
  revoked_at INTEGER
);

-- Runner の一回限りの登録コード（ハッシュのみ保存）
CREATE TABLE runner_registration_codes (
  code_hash TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  used_at INTEGER,
  runner_id TEXT,
  created_at INTEGER NOT NULL
);

-- 秘密情報（AES-GCM で暗号化。repo_id が空ならその利用者の全リポジトリで使える）
CREATE TABLE secrets (
  owner_id TEXT NOT NULL,
  repo_id TEXT NOT NULL DEFAULT '',
  name TEXT NOT NULL,
  ciphertext TEXT NOT NULL,
  iv TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (owner_id, repo_id, name)
);

-- 成果物（本体は R2）
CREATE TABLE artifacts (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  job_id TEXT NOT NULL REFERENCES jobs (id),
  name TEXT NOT NULL,
  r2_key TEXT NOT NULL,
  size INTEGER NOT NULL,
  sha256 TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

-- GitHub への結果表示の待ち行列（失敗しても再試行し、実行は止めない）
CREATE TABLE check_updates (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  owner_id TEXT NOT NULL,
  repo_id TEXT NOT NULL,
  target TEXT NOT NULL,                     -- ジョブ ID（定義ファイルの誤りは実行 ID）
  payload TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  next_at INTEGER NOT NULL,
  last_error TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX check_updates_next ON check_updates (next_at);
CREATE TABLE check_runs (
  owner_id TEXT NOT NULL,
  target TEXT PRIMARY KEY,
  check_run_id INTEGER NOT NULL
);

-- 端末への配布（開発順序6で使う）
CREATE TABLE releases (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  repo_id TEXT NOT NULL,
  run_id TEXT,
  platform TEXT NOT NULL,
  seq INTEGER NOT NULL,
  commit_sha TEXT NOT NULL,
  r2_key TEXT,
  sha256 TEXT,
  size INTEGER,
  status TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE TABLE devices (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  name TEXT NOT NULL,
  os TEXT NOT NULL,
  push_token TEXT,
  token_hash TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL,
  last_seen_at INTEGER
);
CREATE TABLE installs (
  owner_id TEXT NOT NULL,
  device_id TEXT NOT NULL,
  repo_id TEXT NOT NULL,
  platform TEXT NOT NULL,
  seq INTEGER NOT NULL,
  status TEXT NOT NULL,
  message TEXT,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (device_id, repo_id, platform)
);

-- すべての操作の段階・結果・理由
CREATE TABLE operations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  owner_id TEXT NOT NULL,
  repo_id TEXT,
  run_id TEXT,
  job_id TEXT,
  kind TEXT NOT NULL,
  stage TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('ok', 'retry', 'failed')),
  reason TEXT,
  retryable INTEGER NOT NULL DEFAULT 0,
  needs_human INTEGER NOT NULL DEFAULT 0,
  detail TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX operations_owner ON operations (owner_id, created_at);

-- 受信済みの Webhook（重複を捨てる）
CREATE TABLE webhook_deliveries (
  delivery_id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL DEFAULT '',
  event TEXT NOT NULL,
  received_at INTEGER NOT NULL
);
CREATE INDEX webhook_deliveries_received ON webhook_deliveries (received_at);
