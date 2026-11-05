-- MCP の接続用トークン（Claude Code などに直接登録する。ハッシュのみ保存。期限なし・取り消せる）
CREATE TABLE mcp_tokens (
  token_hash TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  name TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  last_used_at INTEGER,
  revoked_at INTEGER
);
