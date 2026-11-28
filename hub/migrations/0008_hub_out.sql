-- LOVE connect HUB への知らせ（失敗した実行を WORLD ruler. へ event.upbeater.run.failed で送る）。
-- 送り損ねても失われないよう、封筒を作って預け（outbox）、定期処理（Cron）で送る。同じ封筒（番号・時刻・署名）のまま送り直す。
CREATE TABLE hub_outbox (
  id TEXT PRIMARY KEY,              -- 封筒の番号（実行の番号と完了の時刻から決まる。同じ失敗は同じ番号）
  envelope TEXT NOT NULL,           -- 署名済みの封筒（JSON。本文にログ・秘密の値は入れない）
  attempts INTEGER NOT NULL DEFAULT 0,
  next_at INTEGER NOT NULL,
  sent_at INTEGER,                  -- 届いた時刻（届いたとみなした時も入る）
  dead_reason TEXT,                 -- 送り直しても通らないと分かった理由（鍵の誤り・形の誤り・上限）
  created_at INTEGER NOT NULL
);
CREATE INDEX hub_outbox_pending ON hub_outbox (next_at) WHERE sent_at IS NULL AND dead_reason IS NULL;

-- 読み進めた位置（どの時刻までの失敗を預けたか）
CREATE TABLE hub_out_state (
  k TEXT PRIMARY KEY,
  v INTEGER NOT NULL
);
