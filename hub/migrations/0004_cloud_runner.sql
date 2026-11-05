-- 開発順序5：クラウド Runner（Cloud Run Jobs）

-- 使い捨ての Runner（クラウドで 1 件のジョブのためだけに起動する。期限を過ぎたら使えない）
ALTER TABLE runners ADD COLUMN ephemeral INTEGER NOT NULL DEFAULT 0;
ALTER TABLE runners ADD COLUMN job_id TEXT;
ALTER TABLE runners ADD COLUMN expires_at INTEGER;

-- クラウド Runner を起動した時刻（二重に起動しない）
ALTER TABLE jobs ADD COLUMN cloud_dispatched_at INTEGER;
