# Upbeater Hub

Cloudflare Workers（TypeScript）＋ D1 ＋ R2 ＋ Durable Objects。設計は `../docs/DESIGN.md`、受け入れ条件は `../docs/RESILIENCE.md`。

## 動作確認

```sh
cd hub
npm install        # .npmrc で legacy-peer-deps を有効にしている（npm の相互依存の解決の不具合を避けるため）
npm test           # vitest（@cloudflare/vitest-pool-workers）。D1・R2・DO・模擬 GitHub をすべてローカルで起動する
npm run typecheck
```

テストは本番の資源に一切触れない。署名鍵はテストのたびに使い捨てで生成する。

## API

| 経路 | 内容 |
| --- | --- |
| `POST /webhook/github` | GitHub の Webhook（push）。署名検証・重複除去の後、対象アプリの照合を依頼する |
| `POST /v1/devices/register` | 登録コード → 端末トークン（`{code, name, os, push_token?}`） |
| `POST /v1/devices/check` | 端末の現在の通番を受け取り、適用すべき最新版の署名付きマニフェストを返す（`{app_id, current_seq}`） |
| `POST /v1/devices/report` | 導入結果の報告（`{app_id, seq, status, message?, stage?}`） |
| `GET /v1/artifacts/:release_id?t=…` | 成果物の取得（短期限トークン、Range 対応） |
| `GET /v1/keys` | マニフェスト検証用の公開鍵（世代番号と状態つき） |
| `POST /v1/admin/apps` | アプリの登録（暫定。開発順序2で MCP に置き換え） |
| `POST /v1/admin/registration-codes` | 登録コードの発行（暫定） |
| `PUT /v1/admin/apps/:app_id/versions/:seq/artifacts/:os` | 成果物の登録（暫定。開発順序3で Builder の完了報告に置き換え） |

## Secret（名前と置き場所のみ。値はここに書かない）

すべて Worker の Secret（`wrangler secret put <名前>`）に置き、値は LININGS. 経由で投入する。

| 名前 | 用途 |
| --- | --- |
| `WEBHOOK_SECRET` | GitHub Webhook の署名検証。未設定の間は Webhook を受け付けない |
| `MANIFEST_SIGNING_KEYS` | Ed25519 秘密鍵（JWK）を世代番号つきで並べた JSON：`{"active":2,"keys":[{"gen":1,"jwk":{…}},{"gen":2,"jwk":{…}}]}` |
| `DOWNLOAD_TOKEN_SECRET` | 成果物の短期限 URL の署名 |
| `ADMIN_TOKEN` | 管理 API の暫定トークン |
| `GITHUB_TOKEN` | （任意）GitHub API の暫定トークン。開発順序2で GitHub App に置き換える |

設定値（`wrangler.jsonc` の `vars`）：`GITHUB_API_BASE`、`MANIFEST_REVOKED_GENERATIONS`（失効させた世代。カンマ区切り）、`ARTIFACT_URL_TTL_SECONDS`。

### 署名鍵の世代交代

1. 新しい世代の鍵を `keys` に追加し、`active` を新しい世代にする（旧世代は残す）
2. 端末が新しい公開鍵を受け取ったら、旧世代を `keys` から外す
3. 漏えい時は、その世代を `MANIFEST_REVOKED_GENERATIONS` に加える。端末はその世代の署名を拒否する

## 公開（今回は行っていない）

D1・R2 の作成、`database_id` の置き換え、`wrangler d1 migrations apply`、Secret の投入、`wrangler deploy` は別の段階で行う。GitHub Actions は使わない。
