-- 管理アプリ（コンソール）の接続コード（一回限り・15 分。ハッシュのみ保存）
CREATE TABLE console_registration_codes (
  code_hash TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  used_at INTEGER,
  created_at INTEGER NOT NULL
);
