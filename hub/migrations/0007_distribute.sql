-- 開発順序6：端末への配布（通知サービスは使わず、端末から定期的に照合する。費用は 0 円）

-- 版：distribute の手順で送られたファイル。ジョブが成功し、既定ブランチの push・手動・定期実行のときだけ ready にする
ALTER TABLE releases ADD COLUMN job_id TEXT;
ALTER TABLE releases ADD COLUMN filename TEXT;
ALTER TABLE releases ADD COLUMN install TEXT;            -- 導入の設定（JSON。署名に含めて端末に届ける）
ALTER TABLE releases ADD COLUMN updated_at INTEGER;
CREATE INDEX releases_repo_platform ON releases (repo_id, platform, status, seq);
CREATE INDEX releases_job ON releases (job_id);

-- 端末の一回限りの登録コード（ハッシュのみ保存）
CREATE TABLE device_registration_codes (
  code_hash TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  used_at INTEGER,
  device_id TEXT,
  created_at INTEGER NOT NULL
);

-- リポジトリ × OS ごとの配布の設定
CREATE TABLE dist_settings (
  owner_id TEXT NOT NULL,
  repo_id TEXT NOT NULL,
  platform TEXT NOT NULL,
  paused INTEGER NOT NULL DEFAULT 0,        -- 配布の一時停止
  pinned_seq INTEGER,                       -- 巻き戻し（この版に固定）
  staged INTEGER NOT NULL DEFAULT 0,        -- 段階配信：先行する 1 台で成功してから残り全台
  canary_device_id TEXT,                    -- 先行する端末（空なら、その OS で最初に登録した端末）
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (repo_id, platform)
);
