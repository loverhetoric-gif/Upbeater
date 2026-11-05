-- 開発順序3：Builder

-- Builder（Mac などのビルド機。トークンはハッシュのみ保存）
CREATE TABLE builders (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  name TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  os TEXT NOT NULL DEFAULT '[]',          -- 最後に申告したビルドできる OS（JSON 配列）
  created_at INTEGER NOT NULL,
  last_seen_at INTEGER,
  revoked_at INTEGER
);

-- ビルド指示（配布物 1 件につき 1 件。アプリごとに最新の版だけが待ち行列に残る）
CREATE TABLE build_jobs (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  app_id TEXT NOT NULL REFERENCES apps (id),
  release_id TEXT NOT NULL UNIQUE REFERENCES releases (id),
  seq INTEGER NOT NULL,
  commit_sha TEXT NOT NULL,
  os TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('queued', 'claimed', 'succeeded', 'failed', 'cancelled')),
  builder_id TEXT,
  attempt INTEGER NOT NULL DEFAULT 0,
  lease_until INTEGER,
  stage TEXT,                              -- 失敗した段階（preflight・fetch・build・artifact・upload）
  reason TEXT,
  log_tail TEXT,                           -- 失敗時の末尾ログ（秘密情報は伏せる）
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX build_jobs_queue ON build_jobs (owner_id, status, created_at);
CREATE INDEX build_jobs_app ON build_jobs (app_id, seq);
