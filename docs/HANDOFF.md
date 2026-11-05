# 引き継ぎ

## 終わったこと

`cd hub && npm test` でテスト 64 件がすべて通る（型検査・`wrangler deploy --dry-run` も成功）。本番への公開はまだ行っていない。

### 開発順序1：hub の基盤（PR #1）

Webhook の検証と重複除去、GitHub への照会による版の判定、アプリごとの直列化と連続更新の統合、コミット SHA ＋通番による版の管理、Ed25519 のマニフェスト署名（世代・失効・すり替えの拒否）、端末 API（登録・照合・報告）、Range 対応の成果物配信、Cron による巡回、GitHub 障害時の再試行。

### 開発順序2：MCP と GitHub 操作

| 項目 | 実装 |
| --- | --- |
| MCP サーバー | `src/mcp.ts`：`POST /mcp`（Streamable HTTP、JSON 応答、状態なし）。版の交渉、tools/list・tools/call、Origin の検査 |
| OAuth 2.1 | `src/oauth.ts`：メタデータ、動的クライアント登録、PKCE（S256）、GitHub でのログイン → 同意の画面、コードの一回限りと再使用時の失効、リフレッシュトークンの回転 |
| 同意の画面 | `src/pages.ts`：スマホ・タブレット・PC と暗い表示に対応 |
| 道具 | `src/tools.ts`：list_apps・get_app・register_app・push_update・rollback・list_devices・create_registration_code・get_install_status・list_operations・create_branch・commit_files・open_pr・merge_pr・ship_change・get_request |
| GitHub 操作 | `src/gitops.ts`：段階ごとに途中結果を保存し、失敗した段階から再開。依頼 ID で重複を検知。許可リスト、main への直接書き込みの禁止、main を取り込んでの再試行、衝突箇所・満たせない条件の返却 |
| GitHub App | `src/github-app.ts`：JWT（RS256、PKCS#1 の鍵をそのまま使える）→ インストールトークン、失効時の取り直し |
| 模擬 GitHub | `test/github-mock.js`：コミット・ツリー・PR・マージ・衝突・保護規則・App 認証・OAuth を再現 |

### 受け入れ条件（RESILIENCE.md「GitHub 操作（MCP 経由）」）との対応

| 局面 | テスト |
| --- | --- |
| 途中の段階で失敗 → 失敗した段階から再開 | `test/gitops.test.ts` |
| マージ時の衝突（main を取り込んで再試行／解消できなければ PR を残し衝突箇所を返す） | `test/gitops.test.ts` |
| ブランチ保護・必須の検査（満たせない条件を返す） | `test/gitops.test.ts` |
| 同じ依頼の重複実行（既存の結果を返す） | `test/gitops.test.ts` |
| GitHub App の権限失効の検知 | `test/gitops.test.ts`・`test/mcp.test.ts` |

## 残り

- 本番公開（利用者の操作が要る）：GitHub App の作成、D1・R2 の作成、`database_id` の置き換え、マイグレーション適用、Secret の投入（LININGS. 経由）、`wrangler deploy`、claude.ai へのコネクタ追加
- 人の判断が要る失敗の利用者への通知（いまは `list_operations` の `needs_human_only` で確かめる）。GitHub App の秘密鍵の期限の予告
- 段階配信・一時停止・失敗の連鎖を止める仕組み
- 端末への更新通知（FCM・APNs・WebSocket）

## 次にやること（開発順序3：Builder）

1. `builder/`（TypeScript・Node、Mac で launchd 常駐）を作る
2. Hub 側：ビルド指示の待ち行列（アプリごとに最新だけを残す）、Builder の認証、完了報告の受付（暫定の `PUT /v1/admin/.../artifacts/:os` を置き換える）
3. 開始前の道具の点検、作業場所の使い捨て、失敗時の末尾ログの記録（MCP から取得できるように）
4. RESILIENCE.md「ビルド（Builder）」の全局面を故障テストで確かめる

## 注意

- `npm install` は `hub/.npmrc` の `legacy-peer-deps=true` を前提にしている
- `@cloudflare/vitest-pool-workers` は `@cloudflare/vitest-plugin` に改名された。後で移行を検討する
