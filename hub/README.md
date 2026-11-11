# Upbeater Hub

GitHub Actions の代替の中枢。Cloudflare Workers（TypeScript）＋ D1 ＋ R2 ＋ Durable Objects ＋ Cron。設計は `../docs/DESIGN.md`、受け入れ条件は `../docs/RESILIENCE-JOBS.md` と `../docs/RESILIENCE.md`。

## 動作確認

```sh
cd hub
npm install        # .npmrc で legacy-peer-deps を有効にしている
npm test           # vitest（@cloudflare/vitest-pool-workers）。D1・R2・DO・模擬 GitHub をローカルで起動する
npm run typecheck
```

テストは本番の資源に触れない。鍵はテストのたびに使い捨てで生成する。

## 構成

| 場所 | 役割 |
| --- | --- |
| `src/workflow/` | 定義ファイル（`.upbeater/*.yml`）の解析・検証・式・matrix・cron・合図との照合（Workers に依存しない部品） |
| `src/routes/webhook.ts` | `POST /webhook/github`：署名の検証、重複の除去、push・pull_request・delete |
| `src/coordinator.ts` | リポジトリごとの Durable Object：合図の処理、定義ファイルの取得と再試行、状態の遷移を直列に |
| `src/runs.ts` | run と job の作成、needs の順、matrix、concurrency の取り消しと直列化、再実行・取り消し |
| `src/routes/runner.ts` | Runner 用 API：登録・受け取り・心拍・ログ・手順・終了の報告 |
| `src/secrets.ts` | 秘密情報の暗号化と、ログ上の伏せ字（変形を含む） |
| `src/checks.ts` | GitHub への結果表示（Checks）の待ち行列と再試行 |
| `src/scheduled.ts` | Cron（毎分）：定期実行・心拍の途絶と時間超過・Runner 不在の通知・取りこぼしの照合・結果表示の再試行 |
| `src/routes/admin.ts` | 管理 API（暫定。開発順序4で MCP から呼ぶ） |

## API

| 経路 | 内容 |
| --- | --- |
| `POST /webhook/github` | GitHub の Webhook |
| `POST /v1/runners/register` | 登録コード → Runner トークン |
| `POST /v1/runners/claim` | ラベルに合うジョブを 1 件受け取る（204 なら無し） |
| `POST /v1/runners/jobs/:id/heartbeat` | 心拍（`continue: false` なら中断する） |
| `POST /v1/runners/jobs/:id/logs` | ログの断片 `{chunks:[{seq,text}], last_seq}` → 欠けた通番を返す |
| `POST /v1/runners/jobs/:id/steps` | 手順ごとの状態 |
| `POST /v1/runners/jobs/:id/complete` | 終了の報告 `{conclusion, reason, last_seq}` → 欠けた通番を返す |
| `POST /v1/admin/repos` | リポジトリの登録 |
| `PUT・GET /v1/admin/secrets` | 秘密情報の登録・名前の一覧（値は返さない） |
| `POST /v1/admin/runner-codes` | Runner の登録コード |
| `POST /v1/admin/runs` | 手動実行 |
| `GET /v1/admin/runs/:id`・`POST …/cancel`・`POST …/rerun` | 状況・取り消し・失敗したジョブの再実行 |
| `GET /v1/admin/jobs/:id/logs` | ログ（通番の順。欠落は印、秘密情報は伏せ字） |

Runner のジョブごとの報告には、受け取った時の `job_token` を `x-upbeater-job-token` で付ける。

## Secret（名前と置き場所のみ。値はここに書かない）

すべて Worker の Secret（`wrangler secret put <名前>`）に置き、値は UnderTalk 経由で投入する。

| 名前 | 用途 |
| --- | --- |
| `WEBHOOK_SECRET` | GitHub Webhook の署名検証。未設定の間は受け付けない |
| `SECRETS_KEY` | 秘密情報を暗号化する鍵（32 バイトを base64） |
| `ADMIN_TOKEN` | 管理 API の暫定トークン |
| `GITHUB_APP_PRIVATE_KEY` | GitHub App の秘密鍵（PEM。PKCS#1 のままでよい） |
| `MANIFEST_SIGNING_KEYS` | 端末への配布のマニフェスト署名（開発順序6） |

設定値（`wrangler.jsonc` の `vars`）：`GITHUB_API_BASE`・`GITHUB_WEB_BASE`・`GITHUB_APP_ID`・`UPBEATER_BOT_LOGIN`（自分のコミットを見分けるためのログイン名）・`MANIFEST_REVOKED_GENERATIONS`。

## 公開

D1 は作成済み。R2 を Cloudflare の画面で有効にしてから、利用者の PC で次を実行する（何度実行してもよい）。

```sh
git clone https://github.com/loverhetoric-gif/Upbeater.git
cd Upbeater/hub && npm install
node scripts/deploy.mjs --pem <GitHub App の秘密鍵 .pem のパス>
```

Cloudflare へのログイン、R2 のバケットの作成、D1 のスキーマの適用、公開、Secret の投入（`WEBHOOK_SECRET`・`SECRETS_KEY`・`ADMIN_TOKEN` はその PC で生成。既にあるものは変えない）、GitHub App の Webhook の設定までを行う。生成した値は `~/.upbeater/hub-secrets.json`（権限 600）に保存し、画面には出さない。

## 管理（MCP ができるまでの暫定）

管理用トークンは `~/.upbeater/hub-secrets.json` から読み、画面に出さない。

```sh
node scripts/admin.mjs repo <owner/name> [--branch main]   # リポジトリを登録
node scripts/admin.mjs runner-code                          # Runner の登録コード
node scripts/admin.mjs secret <名前> [--repo owner/name]    # 秘密情報（値は伏せて入力）
node scripts/admin.mjs run <owner/name> <定義ファイル>       # 手動実行
```

## 公開の前提

GitHub App の作成（Webhook：push・pull_request・delete、権限：Checks 書き込み・Contents 読み取り・Metadata 読み取り）、D1・R2 の作成、`database_id` の置き換え、`wrangler d1 migrations apply`、Secret の投入、`wrangler deploy`。GitHub Actions も self-hosted runner も使わない。
