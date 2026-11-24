-- 検査通過後の自動マージ：持ち主が有効にした規則に従い、Upbeater 自身がマージする（設計は docs/DESIGN.md）

-- リポジトリごとの設定（有効にできるのは持ち主だけ。既定は無効）
ALTER TABLE repos ADD COLUMN auto_merge_enabled INTEGER NOT NULL DEFAULT 0;
ALTER TABLE repos ADD COLUMN auto_merge_method TEXT NOT NULL DEFAULT 'squash';

-- 自動マージの予約（リポジトリ × PR 番号で 1 件）
CREATE TABLE auto_merges (
  owner_id TEXT NOT NULL,
  repo_id TEXT NOT NULL,
  pr_number INTEGER NOT NULL,
  method TEXT,                              -- 予約で指定されたマージの方法（空ならリポジトリの設定）
  request_id TEXT,
  status TEXT NOT NULL CHECK (status IN ('waiting', 'merging', 'merged', 'cancelled', 'closed', 'stopped')),
  head_sha TEXT NOT NULL,                   -- 検査を待っているコミット（新しいコミットで更新し、待ち直す）
  head_updated_at INTEGER NOT NULL,
  code TEXT,                                -- いま待っている／止まっている理由の種類
  reason TEXT,
  reported_key TEXT,                        -- needs_human を記録済みの「種類:コミット」（同じものを何度も記録しない）
  attempts INTEGER NOT NULL DEFAULT 0,      -- GitHub の判定待ちで先送りした回数
  update_attempted_sha TEXT,                -- main の取り込みを試したコミット
  merge_commit_sha TEXT,
  next_check_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (repo_id, pr_number)
);
CREATE INDEX auto_merges_due ON auto_merges (status, next_check_at);
CREATE INDEX auto_merges_head ON auto_merges (repo_id, head_sha);
CREATE INDEX auto_merges_request ON auto_merges (owner_id, request_id);
