-- 配布先の端末の指定（リポジトリ × OS ごと）。
-- 1 行でもあれば、その端末だけに配る。行が無ければ、その OS の登録端末すべてに配る（従来どおり）。
CREATE TABLE dist_targets (
  owner_id TEXT NOT NULL,
  repo_id TEXT NOT NULL,
  platform TEXT NOT NULL,
  device_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (repo_id, platform, device_id)
);
CREATE INDEX dist_targets_device ON dist_targets (device_id);

-- 端末の鍵（LOVE connect HUB 規格 第21章：ECDSA P-256 の公開鍵。非圧縮 65 バイトの base64url）。登録時に送ったときだけ入る（任意）
ALTER TABLE devices ADD COLUMN pub TEXT;
