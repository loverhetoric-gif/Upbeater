-- 接続の事前の許可（管理者が「次の接続を 1 回だけ通す」と決めておく。GitHub でのログインを使わずに claude.ai をつなぐ）
CREATE TABLE oauth_preapprovals (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  used_at INTEGER,
  client_id TEXT,
  created_at INTEGER NOT NULL
);
