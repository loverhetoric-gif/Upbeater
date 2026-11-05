# 引き継ぎ

Upbeater は GitHub Actions の代替（`docs/DESIGN.md`）。開発順序は DESIGN.md の「開発の順序」に従う。

## 終わったこと：開発順序1「hub」

`cd hub && npm test` で 50 件のテストがすべて通る（3 回繰り返して安定）。型検査と `wrangler deploy --dry-run` も成功。本番への公開は行っていない。

| 項目 | 実装 |
| --- | --- |
| 土台 | `wrangler.jsonc`（D1・R2・Durable Object・毎分の Cron）、vitest（`@cloudflare/vitest-pool-workers`）、`migrations/0001_init.sql`（DESIGN.md「データ」の全テーブル＋補助のテーブル、全テーブルに owner_id） |
| 合図 | `POST /webhook/github`（定数時間の署名検証・配信 ID での重複除去・push／pull_request／delete）、Cron の schedule（抜けた回は一度だけ補う）、手動実行の API |
| 定義ファイル | `src/workflow/`：`.upbeater/*.yml` の取得・解析・検証。誤りはファイル名・行・列つき。on・jobs・needs・if・runs-on・env・secrets・steps（run・組み込み部品・distribute）・timeout・concurrency・matrix・artifacts・cache・rerun に対応。Workers に依存しない部品で、Actions の書き方（`strategy.matrix`・`timeout-minutes`・`schedule: - cron:`）も受け付ける |
| 実行の管理 | needs の順に待ち行列へ、matrix の展開、concurrency の取り消しと直列化（リポジトリごとの Durable Object）、取り消し・失敗したジョブの再実行 |
| Runner 用 API | 登録（一回限りのコード → トークン、ハッシュのみ保存）、ラベルに合うジョブの受け取り（二重に渡さない）、心拍、ログの逐次受信（通番で並べ直し・欠けた通番を返す）、手順の状態、終了の報告。ジョブトークンで古い実行の報告を拒否 |
| 心拍・時間超過 | Cron で検知。心拍の途絶は再実行（`rerun: false` と上限 3 回を除く）、時間超過は打ち切って Runner に中断を指示 |
| 秘密情報 | AES-GCM で暗号化して保存（鍵は Secret `SECRETS_KEY`）。指定された分だけ渡す。フォークからの PR には渡さない。ログ上で値と変形（base64・長い base64 の途中・URL 符号化・JSON・16 進）を伏せる。断片の境目で分かれた値も、つないだ時に伏せる |
| 結果表示 | GitHub の Checks。待ち行列に積み、失敗しても実行は止めずに間隔を広げて再試行。最新の状態だけを送る。上限で諦めたら人の判断が要るものとして記録 |
| GitHub | `src/github.ts`：差し替え可能なインターフェース（テストは `test/github-mock.js` の模擬 GitHub）。GitHub App の JWT → インストールトークン |

### 受け入れ条件との対応

**RESILIENCE-JOBS.md**

| 局面 | テスト |
| --- | --- |
| Runner が停止中（待ち行列に保持、一定時間で通知） | `test/runner.test.ts` |
| 実行中に Runner が落ちる（心拍の途絶 → 再実行、再実行しない指定） | `test/runner.test.ts` |
| 時間超過（打ち切り・中断の指示） | `test/runner.test.ts` |
| 新しい更新が来た（concurrency の取り消し・公開系の直列化） | `test/runs.test.ts` |
| ログ送信の途切れ（再送・通番で並べ直し） | `test/logs-secrets.test.ts` |
| 秘密情報の露出（変形も伏せる） | `test/logs-secrets.test.ts` |
| 定義ファイルの誤り（行番号つき・GitHub にも失敗として表示） | `test/workflow.test.ts`・`test/runs.test.ts` |
| GitHub への結果表示の失敗（再試行・実行は止めない） | `test/checks-cron.test.ts` |
| フォークからの PR（秘密情報を渡さない） | `test/logs-secrets.test.ts` |
| 無限の連鎖（自分のコミットを合図にしない） | `test/webhook.test.ts` |
| 定期実行の取りこぼし（一度だけ補う） | `test/checks-cron.test.ts` |
| Hub の停止中の Webhook（GitHub の再送・定期照合） | `test/webhook.test.ts`（受け付け失敗時は記録を消して再送に任せる）・`test/checks-cron.test.ts`（照合） |
| 同じジョブの二重実行（ジョブトークンで排他） | `test/runner.test.ts` |
| 作業場所の汚染 | Runner 側（開発順序2） |

**RESILIENCE.md（GitHub と Hub）**：重複・順序の入れ替わり（`webhook.test.ts`）、取りこぼし（`checks-cron.test.ts`）、強制プッシュ（`webhook.test.ts`）、連続した更新（concurrency：`runs.test.ts`）、GitHub の障害・回数制限（`checks-cron.test.ts`）、署名用の鍵の世代交代（`manifest.test.ts`）。

## 旧設計からの変更

- hub は「アプリ単位の配布」の旧設計から、Actions の代替の設計に作り直した。旧実装（MCP・OAuth・GitHub 操作・端末への配布の API）は git の履歴（コミット 44c1af8）に残っており、開発順序4（MCP と GitHub 操作）・6（端末への配布）で新しい表に合わせて移植する。マニフェスト署名（`src/manifest.ts`）と GitHub App 認証（`src/github-app.ts`）はそのまま残した
- `builder/`（Node 製）は旧設計の Hub API 向けで、新しい Hub とは接続できない。開発順序2の Go 製 Runner に置き換えたら削除する
- `app/` は開発順序6で新しい Hub に合わせる

## 公開の準備の進み具合

| 項目 | 状態 |
| --- | --- |
| GitHub App の作成 | 済み：`upbeater-loverhetoric`（App ID 5623766、`hub/wrangler.jsonc` に記載）。権限：Checks・Contents・Pull requests・Commit statuses は読み書き、Metadata は読み取り。入れられる先はこのアカウントのみ |
| 秘密鍵 | 発行済み（利用者の PC に .pem で保管）。Hub の公開時に LININGS. 経由で Secret `GITHUB_APP_PRIVATE_KEY` に入れる |
| Webhook | 未設定（無効）。Hub の公開後に送り先 `https://<Hub>/webhook/github`、シークレット（`WEBHOOK_SECRET` と同じ値）、合図（push・pull_request・delete）を設定して有効にする |
| App のインストール | 未（対象のリポジトリに入れる） |
| D1 | 作成済み：`upbeater`（APAC、ID は `hub/wrangler.jsonc`）。スキーマは公開の手順で適用する |
| R2 | 未：アカウントで R2 が有効になっていない。Cloudflare の画面で有効にする必要がある |
| 公開・Secret の投入・Webhook の設定 | `hub/scripts/deploy.mjs` を利用者の PC で実行する（秘密情報はその PC で生成・投入し、チャットに出さない） |

## 残り（hub）

- 管理 API は暫定（`ADMIN_TOKEN`）。開発順序4で MCP（OAuth）に置き換える
- 成果物（artifacts）とキャッシュ（cache）の R2 への保存・取得の API（定義の解析と受け渡しは実装済み。Runner と合わせて開発順序2で）
- `linux` のジョブをクラウド Runner へ回す仕組み（開発順序5）
- 失敗の通知（いまは operations の `needs_human` に記録）
- 本番公開（利用者の操作が要る）：GitHub App の作成、D1・R2 の作成、Secret の投入（LININGS. 経由）、`wrangler deploy`

## 次にやること：開発順序2「runner」（Go、macOS・Linux）

1. `runner/`：単一の実行ファイル（Go）。`go test` で確かめる
2. 登録（`POST /v1/runners/register`）→ トークンを権限 600 のファイルに保存
3. 受け取り（`/claim`）→ 使い捨ての作業場所（Linux はコンテナ、macOS は一時ディレクトリ）→ `repo.auth_header` を git にだけ渡して取得 → 手順の実行（`run`・組み込み部品・`distribute`）
4. 心拍（`heartbeat_interval_ms` ごと。`continue: false` なら子プロセスまで止める）、ログの逐次送信（通番つき。応答の `missing` を再送。送れない間は手元に保持）、手順の状態、終了の報告
5. 秘密情報は環境変数で渡し、Runner でもログを伏せる（Hub と同じ変形を含む）
6. 常駐（launchd・systemd）。RESILIENCE-JOBS.md の Runner 側の局面（作業場所の汚染・時間超過での子プロセスの終了・ログの保持と再送）を故障テストで確かめる
