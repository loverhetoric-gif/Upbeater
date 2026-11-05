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
| 作業場所の汚染 | Runner 側：`runner/internal/job`・`workspace`・`archive`（開発順序2） |

**RESILIENCE.md（GitHub と Hub）**：重複・順序の入れ替わり（`webhook.test.ts`）、取りこぼし（`checks-cron.test.ts`）、強制プッシュ（`webhook.test.ts`）、連続した更新（concurrency：`runs.test.ts`）、GitHub の障害・回数制限（`checks-cron.test.ts`）、署名用の鍵の世代交代（`manifest.test.ts`）。

## 終わったこと：開発順序2「runner」

`cd runner && go vet ./... && go test -race ./...` がすべて通る（2 回繰り返して安定）。macOS（arm64・amd64）・Linux（arm64・amd64）向けにビルドできる。Hub は成果物・キャッシュの API を足し、`npm test` で 55 件が通る。

| 項目 | 実装 |
| --- | --- |
| 実行ファイル | `runner/main.go`：`register`・`run`・`service install`・`uninstall`・`print`・`version`。外部の部品なし |
| 設定 | `internal/config`：権限 600・ディレクトリ 700、一時ファイルから置き換え。緩い権限は読む時に直す。Hub の URL は https に限る（localhost を除く） |
| 作業場所 | `internal/workspace`：Linux はコンテナ（uid を合わせ、同じパスで入れる）、macOS は一時ディレクトリ。起動時に残骸を片付ける |
| 取得 | `internal/job/builtins.go`：`repo.auth_header` は git の環境変数だけに渡す。コミットを直接取れなければブランチから |
| 手順 | `internal/job`：`run`・`if`（`internal/expr`、Hub と同じ式）・`${{ }}` の置き換え・`continue-on-error`・手順の `timeout`・組み込み部品・`distribute` |
| 子プロセス | `internal/proc`：プロセスグループ＋環境変数の印で、setsid で抜けたものまで止める |
| ログ | `internal/mask`（Hub と同じ変形・境目で分かれた値）→ `internal/logship`（ディスクに保持・`missing` の再送・次の起動で送る） |
| 常駐 | `internal/agent`（取りに行く間隔・Hub の停止中は間隔を広げて待つ・二重起動の防止）、`internal/service`（launchd・systemd） |
| Hub | `hub/src/routes/blobs.ts`：成果物・キャッシュの保存と取り出し（R2 が SHA-256 を照合、フォークはキャッシュを保存できない）。`test/blobs.test.ts` |

受け入れ条件の Runner 側（作業場所の汚染・時間超過での子プロセスの終了・ログの保持と再送）は `runner/README.md` の表のテストで確かめている。旧 `builder/`（Node 製）は削除した。

## 旧設計からの変更

- hub は「アプリ単位の配布」の旧設計から、Actions の代替の設計に作り直した。旧実装（MCP・OAuth・GitHub 操作・端末への配布の API）は git の履歴（コミット 44c1af8）に残っており、開発順序4（MCP と GitHub 操作）・6（端末への配布）で新しい表に合わせて移植する。マニフェスト署名（`src/manifest.ts`）と GitHub App 認証（`src/github-app.ts`）はそのまま残した
- `builder/`（Node 製）は開発順序2の Go 製 Runner に置き換えて削除した
- `app/` は開発順序6で新しい Hub に合わせる

## 公開の準備の進み具合

| 項目 | 状態 |
| --- | --- |
| GitHub App の作成 | 済み：`upbeater-loverhetoric`（App ID 5623766、`hub/wrangler.jsonc` に記載）。権限：Checks・Contents・Pull requests・Commit statuses は読み書き、Metadata は読み取り。入れられる先はこのアカウントのみ |
| 秘密鍵 | 発行済み（利用者の PC に .pem で保管）。Hub の公開時に LININGS. 経由で Secret `GITHUB_APP_PRIVATE_KEY` に入れる |
| Webhook | 済み：送り先とシークレットを設定。合図（push・pull_request・delete）の選択は利用者が GitHub の画面で行う |
| App のインストール・リポジトリの登録 | 未：GitHub の画面でインストールし、`node scripts/admin.mjs repo <owner/name>` で Hub に登録する |
| Runner | 未：利用者の Mac で組み立てて登録する（`runner/README.md`） |
| D1 | 作成済み：`upbeater`（APAC、ID は `hub/wrangler.jsonc`）。スキーマは公開の手順で適用する |
| R2 | 済み：`upbeater-blobs` |
| 公開・Secret の投入・Webhook の設定 | 済み：`https://upbeater-hub.twilight-star-9d9d.workers.dev`（`hub/scripts/deploy.mjs` を利用者の Mac で実行。秘密情報は `~/.upbeater/hub-secrets.json`） |

## 残り（hub）

- 管理 API は暫定（`ADMIN_TOKEN`）。開発順序4で MCP（OAuth）に置き換える
- 成果物・キャッシュの古いものの削除（期限・容量の上限）
- `linux` のジョブをクラウド Runner へ回す仕組み（開発順序5）
- 失敗の通知（いまは operations の `needs_human` に記録）
- 本番公開（利用者の操作が要る）：R2 を Cloudflare の画面で有効にし、`hub/scripts/deploy.mjs` を利用者の PC で実行する。その後、GitHub App の画面で Webhook を Active にして合図（push・pull_request・delete）を選び、対象のリポジトリにインストールする

## 残り（runner）

- 実機の Hub（`wrangler dev`）と GitHub App を使った通しの確認（本番公開と合わせて）
- 実行ファイルの配布と自己更新（署名と SHA-256 を検証してから差し替える。開発順序6の配布の仕組みを使う）
- `setup-*` で道具を自動で入れること（いまは版の確認のみ）

## 進行中：開発順序3「移行ツール ＋ LIFElive の移行で実地検証」

`cd hub && npm test` で 66 件、`cd runner && go test ./...` が通る（`internal/proc` の `TestTimeoutKillsDescendants` だけは macOS に `setsid` が無いため失敗する。Linux では通る。今回の変更の前から同じ）。

| 項目 | 実装 |
| --- | --- |
| 変換の部品 | `hub/src/workflow/convert.ts`：合図・ジョブ・部品・式の変換。変換できないものは行番号つきの「変換できません」にし、定義ではその手順を失敗させる。書いた定義は `parseWorkflow` で検証。`test/convert.test.ts` |
| 利用者の PC の道具 | `hub/scripts/migrate.mjs <フォルダ> [--check] [--label linux=macos] [--force]`（`cd hub && npm ci` が先に要る） |
| 定義の追加 | 手順の `id`（`steps.<id>.outputs.<名前>`・`outcome`・`conclusion`）、concurrency の group の `${{ ref }}`・`${{ branch }}`・`${{ event }}` |
| Runner の互換 | `runner/internal/job/compat.go`：`CI`・`GITHUB_SHA` などの環境変数、`GITHUB_OUTPUT`・`GITHUB_ENV`・`GITHUB_PATH`・`GITHUB_STEP_SUMMARY`。ジョブの env の `${{ secrets.X }}` を値にする。成果物は Actions と同じく、指定したものに共通するフォルダを起点にまとめる |

### 残り

1. この変更を Hub に公開し（`hub/scripts/deploy.mjs`）、Runner を組み立て直す（`sh runner/install.sh`）
2. GitHub App に Checks の読み書きの権限を足す（結果を PR に出すため。利用者が GitHub の画面で行う）
3. LIFElive の `.upbeater/build.yml`・`deploy.yml`（ブランチ `upbeater-migration`）を PR にし、Runner で動くのを確かめる。Runner の Mac には Flutter 3.47.7 と Java 17 が要る
4. 秘密情報を Hub に登録する（`node hub/scripts/admin.mjs secret <名前> --repo loverhetoric-gif/LIFElive`）：FIREBASE_*・CLOUDFLARE_API_TOKEN・LIFELIVE_GITHUB_TOKEN・MCP_TOKEN・MUSE_TOKEN・ANTHROPIC_API_KEY・FIREBASE_SERVICE_ACCOUNT、リリース用の GITHUB_TOKEN（contents の書き込み）
5. 動くのを確かめてから、LIFElive の `.github/workflows` を消して Actions を止める（利用者の確認の後）

## 終わったこと：開発順序3の実地検証

LIFElive の main に `.upbeater/build.yml`・`deploy.yml` が入り、`.github/workflows` は削除済み。Upbeater の Runner で実行され、結果がコミットの状態として GitHub に出ている。

## 終わったこと：開発順序4「MCP と GitHub 操作」

`cd hub && npm test` で 99 件が通る。旧実装（44c1af8）の OAuth・GitHub 操作を新しい Hub に移植し、Actions の代替の道具（実行・ログ・再実行・取り消し・一時停止・移行・秘密情報）を足した（DESIGN.md「MCP の実装」）。
あわせて、Upbeater 自身の push を定期照合が 10 分後に拾ってしまう不具合（無限の連鎖になりうる）を直した。

### 残り

- GitHub App の Client secret を作り、Secret `GITHUB_APP_CLIENT_SECRET` に入れる。`wrangler.jsonc` の `GITHUB_APP_CLIENT_ID` を App の Client ID にする。App の Callback URL に `https://upbeater-hub.twilight-star-9d9d.workers.dev/oauth/github/callback` を入れる。済めば claude.ai のコネクタに `https://upbeater-hub.twilight-star-9d9d.workers.dev/mcp` を足せる

## 終わったこと：開発順序5「クラウド Runner」（コード）

Hub（`src/cloud.ts`・テスト `test/cloud.test.ts`、計 103 件）、Runner（環境変数での起動・1 件で終わる）、`cloud-runner/Dockerfile`・`deploy.sh`。

### 残り

- GCP 側の用意（課金が発生する）：`sh cloud-runner/deploy.sh <課金が有効なプロジェクト>` を実行し、出た値を `hub/wrangler.jsonc` に入れて公開する。それまでは Linux のジョブは Mac の Runner が受け取る
