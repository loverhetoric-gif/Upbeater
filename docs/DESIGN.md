# Upbeater 設計書

## 目的

**GitHub Actions の代替。** GitHub 上の任意のリポジトリについて、Actions が担っていた自動処理（更新を合図にした検査・ビルド・公開、定期実行、手動実行）を、Actions を一切使わずに実行する。
さらに、各端末（macOS・Linux・Android・iOS）への最新版の自動配布を、この自動処理の一つとして標準で備える。

## GitHub の self-hosted runner を使わない理由

GitHub の実行基盤に乗る限り、課金方針の変更（2025 年 12 月に発表され延期中の、self-hosted runner への分単位課金など）に左右される。
Upbeater は実行の制御をすべて自前で持ち、GitHub には「Webhook の送信」と「結果の表示（コミットの状態・Checks）」だけを依存する。

## 最優先：汎用性

- 任意のリポジトリ・言語・公開先に対応する。処理の中身は各リポジトリの定義ファイルに書き、Upbeater 本体には書かない
- 定義の書式は GitHub Actions の書式に寄せ、既存の `.github/workflows` を自動変換して移行できるようにする
- 実行環境はラベルで振り分け、自由に追加・削除できる
- 複数の利用者に対応できるデータ構造にする（全テーブルに owner_id）

## 動作の流れ

1. **合図**：GitHub の Webhook（push・pull_request・ブランチ削除など）／定期実行（Hub の Cron）／手動実行（MCP・管理画面）
2. Hub が該当リポジトリの定義ファイルを読み、ジョブを作って待ち行列へ入れる
3. Runner が Hub からジョブを取りに行き、実行する（Runner 側から接続する方式。受け口を外部に開けない）
4. ログを逐次 Hub へ送る。成果物とキャッシュは R2 へ保存する
5. 結果を GitHub に表示する（コミットの状態・Checks。PR に成功／失敗が出る）
6. 失敗時は通知し、MCP・管理画面から再実行できる

## 定義ファイル（各リポジトリの `.upbeater/*.yml`）

```yaml
name: 公開
on:
  push: { branches: [main] }
  pull_request: {}
  schedule: ["0 3 * * *"]
  manual: {}
jobs:
  test:
    runs-on: linux
    steps:
      - run: npm ci && npm test
  deploy:
    needs: test
    if: event == 'push'
    runs-on: linux
    secrets: [CLOUDFLARE_API_TOKEN]
    concurrency: deploy
    steps:
      - run: npx wrangler deploy
  distribute:
    needs: test
    if: event == 'push'
    runs-on: macos
    steps:
      - run: flutter build apk --release
      - distribute: { platform: android, file: build/app/outputs/flutter-apk/app-release.apk }
```

- 対応する要素：`on`・`jobs`・`needs`・`if`・`runs-on`・`env`・`secrets`・`steps`（`run`・組み込み部品・`distribute`）・`timeout`・`concurrency`・`matrix`・`artifacts`・`cache`
- **移行ツール**：既存の `.github/workflows/*.yml` を読み、変換できる部分を変換し、変換できない部分を具体的に一覧で報告する。よく使われる部品（checkout・setup-node・setup-java・Flutter の準備・cache・upload-artifact）は同等の組み込み部品を用意する

## 実行環境（Runner）

- **Upbeater Runner**：macOS・Linux に常駐する（launchd・systemd）。単一の実行ファイルで配布する（Go）。ラベル例：`macos`・`linux`
- **クラウド Runner**：Mac が停止していても Linux のジョブを実行できるよう、Google Cloud Run Jobs 上で必要な時だけ起動する
- 各ジョブは使い捨ての作業場所で実行する（Linux はコンテナ、macOS は専用の一時ディレクトリ）

## 秘密情報

- Hub に暗号化して保存する。値は LININGS. 経由で投入し、チャットに出さない
- ジョブの実行時だけ Runner へ渡し、ログからは自動で伏せる
- 既存の Actions Secrets と同じ名前で使えるようにする（GitHub から値は取り出せないため、LININGS. 経由で再登録する）

## 端末への配布（組み込み機能 `distribute`）

- 成果物を R2 に置き、Hub が Ed25519 で署名したマニフェストを発行し、各端末の Upbeater アプリへ通知する（Android：FCM、iOS・macOS：APNs、Linux：WebSocket）
- 端末は署名と SHA-256 を検証してからインストールし、結果を報告する
- **Android**：PackageInstaller。Android 12 以降、Upbeater が導入元なら確認なしで更新できる
- **macOS**：`.app` を差し替えて再起動
- **Linux**：AppImage を差し替えて再起動
- **iOS**：第 1 段階は通知＋ワンタップ導入（`itms-services`。Ad Hoc 署名と UDID 登録が必要）。第 2 段階で端末内での署名・導入（SideStore と同じ方式）を検討

## 接続口：MCP コネクタ

Hub に MCP サーバー（`/mcp`）を持たせ、claude.ai のコネクタとして接続する。Claude が会話から、いつでも実行・配信できる。

- 実行：`run_workflow`（手動実行）・`rerun`・`cancel`・`pause`
- 確認：`list_runs`・`get_run`・`get_logs`・`list_runners`
- 移行：`migrate_workflows`（Actions の定義を変換して PR を作る）
- 配布：`push_update`・`rollback`・`get_install_status`
- 秘密情報：`list_secrets`（名前のみ）
- GitHub 操作：`create_branch`・`commit_files`・`open_pr`・`merge_pr`

## GitHub 操作の内製化

claude.ai の GitHub コネクタでは、PR 作成時の確認画面が読み込めず作業が止まる事象が起きた。Upbeater は自前の GitHub App で、ブランチ作成 → コミット → PR → マージを一続きで実行する。失敗しても止まらず、段階・理由・再試行の可否を返す。操作できるリポジトリは許可リストで限定し、main への直接書き込みは禁止する。

## 構成

| 部品 | 技術 | 役割 |
| --- | --- | --- |
| `hub/` | Cloudflare Workers（TypeScript）＋ D1 ＋ R2 ＋ Durable Objects ＋ Cron | 合図の受信、定義の解釈、待ち行列、ログ、GitHub への結果表示、秘密情報、MCP、配布 |
| `runner/` | Go（macOS・Linux 用の単一実行ファイル） | ジョブの取得・実行・ログ送信 |
| `cloud-runner/` | runner のコンテナ版（Cloud Run Jobs） | Mac 停止時の Linux ジョブ |
| `app/` | Flutter（macOS・Linux・Android・iOS） | 管理画面、端末への配布の受け手 |

Upbeater 自身の検査・公開も Upbeater で行い、Actions は使わない。

## データ（D1）

- `repos`・`workflows`（定義の写し）・`runs`・`jobs`・`steps`（ログ本体は R2）・`runners`・`secrets`（暗号化）・`artifacts`
- 配布用：`releases`・`devices`・`installs`
- 共通：`operations`（すべての操作の段階・結果・理由）・`webhook_deliveries`
- 補助（開発順序1で追加）：`schedules`（定期実行の最後の予定時刻。抜けた回を一度だけ補う）・`log_chunks`（ログの断片の索引。本体は R2）・`runner_registration_codes`（一回限りの登録コード）・`check_updates`／`check_runs`（GitHub への結果表示の待ち行列と対応表）

## Hub の処理（開発順序1で実装）

- 定義ファイルの部品（`hub/src/workflow/`）は Workers に依存しない。解析・検証（ファイル名・行・列つきの誤り）・if の式・matrix の展開・cron・合図との照合を持ち、Actions 書式の変換にも使う
- 合図の処理と状態の遷移は、リポジトリごとの Durable Object（`RepoCoordinator`）で直列に行う。GitHub の障害時は合図を DO の待ち行列に残して再試行する
- ジョブの状態：`waiting`（needs 待ち）→ `blocked`（concurrency の順番待ち）→ `queued` → `claimed` → `succeeded`・`failed`・`cancelled`・`skipped`
- concurrency：同じ group で同時に動くのは常に 1 つ。`cancel-in-progress`（既定 true）なら古いものを取り消し、実行中のものには心拍の応答で中断を指示する
- Runner はジョブを受け取る時にジョブトークンを受け取り、以後の報告に付ける。心拍の途絶で再実行に移ったジョブの古い実行の報告は受け付けない（二重実行の防止）
- 秘密情報は AES-GCM で暗号化し、ジョブの `secrets` に書かれた分だけ渡す。ログは受け取った時と、つないだ時の両方で伏せる
- 自分のコミット：送り主が `UPBEATER_BOT_LOGIN` のものは、リポジトリの設定（`trigger_on_own_commits`）が無い限り合図にしない

## 移行計画

1. 最大の消費源である LIFElive の `build.yml`・`deploy.yml` を最初に置き換え、実地で検証する
2. 全リポジトリの `.github/workflows` を変換し、Actions 側を停止する
3. 端末への配布を有効にする

## 開発の順序

1. hub：Webhook、定義の読み込みと検証、ジョブの待ち行列、ログ、GitHub への結果表示
2. runner（macOS・Linux）
3. 移行ツール ＋ LIFElive の移行で実地検証
4. MCP と GitHub 操作
5. クラウド Runner
6. 端末への配布（app）
7. 管理画面

## 未決事項

- GitHub App の作成（Webhook・Checks・コミットの状態・PR 操作の権限）
- iOS への配布：有料の Apple Developer 登録の有無
