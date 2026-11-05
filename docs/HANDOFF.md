# 引き継ぎ（開発順序1：hub の基盤）

## 終わったこと

`hub/`（Cloudflare Workers・TypeScript）の基盤。テスト 40 件がすべて通る（`cd hub && npm test`）。

| 項目 | 実装 |
| --- | --- |
| 土台 | `wrangler.jsonc`（D1・R2・Durable Object・Cron）、TypeScript、vitest（`@cloudflare/vitest-pool-workers`） |
| D1 | `migrations/0001_init.sql`：apps・app_versions・releases・devices・registration_codes・installs・operations・webhook_deliveries（全テーブルに owner_id） |
| Webhook | `src/routes/webhook.ts`：HMAC-SHA256 の定数時間比較、配信 ID での重複除去、登録済みアプリの対象ブランチだけを扱う |
| 照合の直列化 | `src/coordinator.ts`：アプリごとの Durable Object。連続した依頼は 1 回の再照合にまとめる |
| 版の管理 | `src/versions.ts`：GitHub に現在のコミットを照会して判断。コミット SHA ＋ 単調増加の通番。古い版の未完了の配布物は取り消す |
| 署名 | `src/manifest.ts`：Ed25519（WebCrypto）、鍵の世代番号、失効、巻き戻し指示なしの古い版を無効とする判定（端末側の基準実装を兼ねる） |
| 端末 API | `src/routes/devices.ts`：登録（一回限りのコード、トークンはハッシュのみ保存）、照合（途中の版を飛ばす）、結果報告 |
| 成果物の配信 | `src/routes/artifacts.ts`：短期限トークン付き URL、Worker 経由で R2 から、Range・If-Range 対応 |
| 巡回 | Cron（15 分ごと）で全アプリを照合。古い受信記録の削除 |
| GitHub | `src/github.ts`：差し替え可能なインターフェース。障害・回数制限は待ち行列（DO の alarm）に残し、間隔を広げて再試行 |

### 受け入れ条件（RESILIENCE.md）との対応

| 局面 | テスト |
| --- | --- |
| 署名不一致の拒否 | `test/webhook.test.ts` |
| Webhook の重複 | `test/webhook.test.ts` |
| 順序の逆転 | `test/sync.test.ts` |
| 取りこぼし（Cron で回復） | `test/sync.test.ts` |
| 強制プッシュ | `test/sync.test.ts` |
| 連続更新の統合・古い配布物の取り消し | `test/sync.test.ts` |
| GitHub の障害・回数制限時の再試行 | `test/sync.test.ts` |
| 権限の失効の検知（人の判断が要るものとして記録） | `test/sync.test.ts` |
| 古い版へのすり替えの拒否 | `test/manifest.test.ts` |
| 鍵の世代交代・失効 | `test/manifest.test.ts` |
| 長期間オフライン（途中の版を飛ばす） | `test/devices.test.ts` |
| ダウンロードの途中再開 | `test/download.test.ts` |

## 残り（hub に関わる受け入れ条件のうち、後の段階で満たすもの）

- GitHub App の認証（インストールトークン）と、権限失効・秘密鍵の期限の利用者への通知・予告（開発順序2）
- 段階配信・一時停止・失敗の連鎖を止める仕組み（`releases.status = 'halted'` と `apps.pinned_seq` の土台のみ実装済み。操作の入口は MCP で作る）
- 同じ版の署名・SHA-256 不一致の繰り返し時の自動配信停止（端末の報告を集計する処理）
- 端末への更新通知（FCM・APNs・WebSocket）
- Builder への指示と完了報告（開発順序3。暫定の管理 API `PUT /v1/admin/.../artifacts/:os` で代替中）
- 本番公開：D1・R2 の作成、`database_id` の置き換え、マイグレーション適用、Secret の投入、`wrangler deploy`

## 次にやること（開発順序2：MCP と GitHub 操作）

1. `/mcp`（MCP サーバー）を追加し、claude.ai のコネクタが対応する OAuth で認証する。暫定の `ADMIN_TOKEN` と `/v1/admin/*` を置き換える
2. ツール：`list_apps`・`get_app`・`register_app`・`push_update`・`rollback`（`apps.pinned_seq` を使う）・`list_devices`・`get_install_status`
3. `src/github.ts` の `GitHubTokenProvider` を GitHub App のインストールトークン版に差し替える（秘密鍵は Secret、LININGS. 経由で投入）
4. `GitHubClient` にブランチ作成・コミット・PR・マージを追加。各段階を冪等にし、依頼 ID で重複を検知、`operations` に段階ごとに記録して途中から再開できるようにする
5. 許可リストによるリポジトリの限定、main への直接書き込みの禁止、マージ前の衝突確認
6. テストは今回と同じく `test/github-mock.js`（模擬 GitHub）を拡張して、故障を意図的に起こして確かめる

## 注意

- `npm install` は `hub/.npmrc` の `legacy-peer-deps=true` を前提にしている（npm 10 の相互依存の解決の不具合を避けるため）
- `@cloudflare/vitest-pool-workers` は `@cloudflare/vitest-plugin` に改名された。指定どおり旧名を使っているが、後で移行を検討する
