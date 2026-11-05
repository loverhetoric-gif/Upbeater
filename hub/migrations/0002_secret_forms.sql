-- 秘密情報の入力ページ（一回限り。鍵はハッシュだけを置く）
CREATE TABLE secret_forms (
  token_hash TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  repo_id TEXT NOT NULL,
  names TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  used_at INTEGER,
  created_at INTEGER NOT NULL
);
CREATE INDEX secret_forms_expires ON secret_forms (expires_at);
