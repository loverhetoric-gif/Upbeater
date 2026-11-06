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
5. 結果を GitHub に表示する（Checks。GitHub App に Checks の権限が無い時はコミットの状態で代わりに表示する。PR に成功／失敗が出る）
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
- **クラウド Runner**：Mac が停止していても Linux のジョブを実行できるよう、Google Cloud Run Jobs 上で必要な時だけ起動する仕組みを持つ。**課金が発生するため既定では使わない**（設定が空なら何もしない）。使わない間は、Linux のジョブも手元の常駐 Runner が受け取る
- **費用の原則**：Upbeater は無料で動くこと。課金が発生する外部サービスに依存しない（任意の追加にとどめ、既定では無効）
- クラウド Runner の実装（開発順序5）：Hub は毎分、待ち行列に 1 分以上残り、受け取れる常駐 Runner が動いていない `linux`（`CLOUD_RUNNER_LABELS`）のジョブごとに、Cloud Run Job を 1 回起動する。起動のたびに、そのジョブだけを受け取れる期限つき（時間の上限＋30 分）の使い捨て Runner を作り、トークンは実行の環境変数で渡す（Hub にはハッシュだけ）。起動に失敗したら次の分にもう一度、起動しても 15 分受け取られなければ起動し直す。コンテナ（`cloud-runner/Dockerfile`）は `upbeater-runner run` が環境変数から設定を作り、1 件実行して終わる（ジョブが来なければ 3 分で終わる）。用意は `cloud-runner/deploy.sh <GCP のプロジェクト>`
- 各ジョブは使い捨ての作業場所で実行する（Linux はコンテナ、macOS は専用の一時ディレクトリ。Linux でコンテナの道具が無い時は一時ディレクトリで実行し、ログにその旨を書く）

## 秘密情報

- Hub に暗号化して保存する。値は LININGS. 経由で投入し、チャットに出さない
- ジョブの実行時だけ Runner へ渡し、ログからは自動で伏せる
- 既存の Actions Secrets と同じ名前で使えるようにする（GitHub から値は取り出せないため、LININGS. 経由で再登録する）
- **入力ページ**（MCP・管理画面ができるまでの入口）：管理用トークンで、リポジトリと名前を決めた一回限りのページ（`/secret-form/<鍵>`）を発行する。スマホでも開け、伏せ字の欄に値を入れて送ると、決めた名前の分だけ暗号化して保存する。鍵は 256 ビットの乱数で、Hub にはハッシュだけを置く。期限は設けない。一度送ったら使えず、同じリポジトリに新しいページを発行すると、まだ使っていない前のページは使えなくなる。使い終わった記録は 1 日で消す。ページには値も、登録済みの値の一部も出さない（登録済みかどうかだけ）。JavaScript を使わず、`Content-Security-Policy`・`Cache-Control: no-store`・`Referrer-Policy: no-referrer` を付ける。発行：`node hub/scripts/admin.mjs secret-form --repo <owner/name> <名前>…`

## 端末への配布（組み込み機能 `distribute`）

- 成果物を R2 に置き、Hub が Ed25519 で署名したマニフェストを発行し、各端末の Upbeater アプリへ通知する（Android：FCM、iOS・macOS：APNs、Linux：WebSocket）
- 端末は署名と SHA-256 を検証してからインストールし、結果を報告する
- **Android**：PackageInstaller。Android 12 以降、Upbeater が導入元なら確認なしで更新できる
- **macOS**：`.app` を差し替えて再起動
- **Linux**：AppImage を差し替えて再起動
- **iOS**：組み込み部品 `install-ios`（macOS の Runner）で、Mac とペアリング済みの iPhone・iPad に同じ Wi-Fi 越しで `.app` を入れる（`xcrun devicectl`）。有料の Apple Developer 登録は使わず、Xcode に入れた Apple ID（無料）で署名する。Runner は証明書のチーム ID を `$UPBEATER_APPLE_TEAM` で渡す（例 `xcodebuild … -allowProvisioningUpdates DEVELOPMENT_TEAM=$UPBEATER_APPLE_TEAM`）。無料の署名は 7 日で切れるため、定期実行（例 `schedule: ['0 3 */3 * *']`）で組み立て直して入れ直す。`with`：`app`（.app のパス・必須）、`device`（名前か UDID。改行で複数。省くとペアリング済みで届くすべて）。届かない時は手順を失敗にし、次の実行で入れる。無料の署名で入れられるアプリは 1 台に 3 つまで（Apple の制限）。上限に達して断られた時は、その理由を日本語でログに出す

### 配布の実装（開発順序6）

- 費用 0 円にするため、通知サービス（FCM・APNs）は使わない。端末のアプリが起動時・復帰時・15 分ごとに Hub に照合する。iOS はこの照合の仕組みではなく、`install-ios`（同じ Wi-Fi 越しの導入）で配る
- 版：`distribute` の手順で Runner が送ったファイル（成果物の名前 `distribute-<OS>`）を候補にし、ジョブが成功して、既定ブランチの push・手動・定期実行のときだけ配布できる版（ready）にする。通番はリポジトリ × OS ごと。PR・フォーク・失敗したジョブの成果物は捨てる。`distribute.install` に導入の設定（`package`・`bundle`・`bundle_id`・`when_running`・`health_seconds`）を書くと、署名に含めて端末に届く
- 端末 API：`POST /v1/devices/register`（一回限りの登録コード → 端末トークン。ハッシュのみ保存）・`GET /v1/devices/apps`（app_id はリポジトリの ID）・`POST /v1/devices/check`（途中の版を飛ばして最新の版の署名つきマニフェスト。取得の URL は 10 分の短期限で、鍵は SECRETS_KEY から導く）・`POST /v1/devices/report`・`GET /v1/artifacts/:id`（Range・If-Range に対応）
- 安全装置（`dist_settings`）：OS ごとの一時停止・巻き戻し（指定の版に固定し、署名つきの巻き戻しの指示を出す）・段階配信（先行する 1 台が入れ終えてから残り全台）。同じ版が 2 台以上で失敗したら、その版を止め（halted）、人の判断が要るものとして記録する
- MCP：`get_install_status`・`push_update`・`rollback`・`set_distribution`・`list_devices`・`create_device_code`

## 接続口：MCP コネクタ

Hub に MCP サーバー（`/mcp`）を持たせ、claude.ai のコネクタとして接続する。Claude が会話から、いつでも実行・配信できる。

- 実行：`run_workflow`（手動実行）・`rerun`・`cancel`・`pause`
- 確認：`list_runs`・`get_run`・`get_logs`・`list_runners`
- 移行：`migrate_workflows`（Actions の定義を変換して PR を作る）
- 配布：`push_update`・`rollback`・`get_install_status`
- 秘密情報：`list_secrets`（名前のみ）
- GitHub 操作：`create_branch`・`commit_files`・`open_pr`・`merge_pr`

### MCP の実装（開発順序4）

- `/mcp`（Streamable HTTP・JSON 応答）。認証は OAuth 2.1（動的クライアント登録・PKCE（S256）・リフレッシュトークンの回転・コードの再使用でその認可を失効）。利用者の確認は GitHub App のユーザー認証（`GITHUB_APP_CLIENT_ID`・Secret `GITHUB_APP_CLIENT_SECRET`）で行い、`ALLOWED_GITHUB_USERS` のアカウントだけを通す。利用者は `gh:<GitHub のユーザー ID>`。GitHub でのログインを使わない道として、管理者が「次の 1 回」を許可しておくと（`admin.mjs mcp-approve`、期限つき・一回限り・戻り先が claude.ai のときだけ）、claude.ai のコネクタはログインなしでつながる。Claude Code には接続用トークン（`admin.mjs mcp-connect`）を直接登録する
- 道具：`list_repos`・`register_repo`・`pause`（合図での実行を止める。手動実行は止めない。再開後は照合で最新に追いつく）・`run_workflow`・`list_runs`・`get_run`・`get_logs`・`rerun`・`cancel`・`list_runners`・`list_operations`・`migrate_workflows`（変換して PR。マージはしない）・`list_secrets`・`request_secrets`（入力ページの URL を発行。値はチャットに出さない）・`create_branch`・`commit_files`・`open_pr`・`merge_pr`・`ship_change`・`get_request`。配布の道具は開発順序6
- 自分のコミット：MCP で依頼したコミット・PR は `requested_refs` に記録し、Upbeater 自身の書き込みでも合図にする（マージの push は、コミットに対応する PR でも確かめる）。それ以外の自分の push は合図にせず、既定ブランチなら処理済み（`last_seen_sha`）にして、定期照合が取りこぼしとして拾わないようにする

## GitHub 操作の内製化

claude.ai の GitHub コネクタでは、PR 作成時の確認画面が読み込めず作業が止まる事象が起きた。Upbeater は自前の GitHub App で、ブランチ作成 → コミット → PR → マージを一続きで実行する。失敗しても止まらず、段階・理由・再試行の可否を返す。操作できるリポジトリは Hub に登録したものに限定し、main への直接書き込みは禁止する。

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

## Runner の処理（開発順序2で実装）

- 単一の実行ファイル（`runner/`、Go、外部の部品なし）。`register`（一回限りのコード → トークンを権限 600 の設定ファイルへ）・`run`（常駐）・`service install`（macOS は launchd、Linux は systemd のユーザー単位）
- 作業場所：ジョブごとに `<状態>/work/<ジョブ>-<回>-<乱数>/{work,tmp,home}` を作り、終わったら消す（`<状態>` のパスに空白があれば、空白の無いキャッシュの場所 `~/Library/Caches/upbeater-runner/work-<識別>` などに置く。file:// の %20 や引用符の無い台本が壊れるため）。Linux の既定はコンテナ（docker・podman。作業場所を同じパスで入れ、利用者の uid で実行）、macOS の既定は専用の一時ディレクトリ。起動時に前の実行の残骸（作業場所・ラベル付きのコンテナ）を片付ける
- 取得：`repo.auth_header` は git の子プロセスの環境変数（`GIT_CONFIG_*`）にだけ渡し、`.git/config` にも手順の環境にも残さない。手順に `checkout` が無ければ最初に取得する
- 手順：`run` は `bash -eo pipefail`（無ければ `sh -e`）。`if` は Hub と同じ式（`runner/internal/expr`）。`${{ secrets.X }}`・`${{ env.X }}` は台本の中では環境変数の参照に置き換え、値をファイルに書かない。`continue-on-error`・手順の `timeout`・`working-directory` に対応
- 組み込み部品：`checkout`・`setup-*`（道具が入っていて版が合うかを確かめる。道具は Runner の端末・コンテナのイメージに入れておく。普段使いと違う版が要る時は `~/.upbeater/tools/<名前>/` に置くと、`install.sh` がその bin を Runner の PATH の先頭に足す）・`cache`・`upload-artifact`・`download-artifact`。`distribute` はファイルを Hub に送る（署名・通知は開発順序6）
- 子プロセス：手順ごとにプロセスグループを作り、ジョブの終わり・時間超過・中断でグループごと止める（TERM → 5 秒 → KILL）。setsid で抜けたものは環境変数の印（`UPBEATER_JOB_MARK`）で探して止める
- ログ：Runner でも伏せてから（Hub と同じ変形。書き込みの境目で分かれた値も）通番つきの断片にし、ディスクに保持して送る。Hub が連続して受け取った通番までを消す。届かなかったログと終了の報告は次の起動で送る
- 心拍：`heartbeat_interval_ms` ごと。`continue: false` なら止める。`stale_job` なら止めて報告しない。Runner の停止（SIGTERM）では報告せず、Hub が心拍の途絶として扱う（`rerun` の指定に従う）
- 成果物・キャッシュの Hub API：`PUT/GET /v1/runners/jobs/:id/artifacts/:name`（同じ実行の中）・`/cache/:key`（同じリポジトリの中、一度保存したら変えない、フォークからは保存できない）。送る時は SHA-256 を付け、R2 が照合してから保存する。取り出した Runner も照合してから展開する。展開では置き場所の外へ書くもの（`..`・絶対パス・外を指すリンク）を拒否する

## 移行ツール（開発順序3で実装）

- 変換の部品は `hub/src/workflow/convert.ts`（Workers に依存しない。開発順序4の MCP `migrate_workflows` でも使う）。利用者の PC では `node hub/scripts/migrate.mjs <リポジトリのフォルダ>` で `.github/workflows/*.yml` を読み、`.upbeater/*.yml` を書き、報告を出す。`--check` は書かずに報告だけ。`--label 元=先` は runs-on のラベルを置き換える（例：Linux の Runner がまだ無い時に `linux=macos`）
- 報告は「変換できません」（そのままでは同じ動きにならない。定義では、その手順を失敗させる `run` に置き換えて、黙って抜け落ちないようにする）と「注意」（動きは変わらないか、差が小さい）の 2 段階。どちらも元のファイルの行番号つき。書いた定義は `parseWorkflow` で検証する
- 対応：`on`（`workflow_dispatch` → `manual`。`branches-ignore`・`paths-ignore` は `!` の型に直す）、ワークフロー全体の `concurrency`・`defaults.run.working-directory` は各ジョブへ移す（concurrency の group はジョブ名を足し、同じ実行のジョブ同士で取り消し合わないようにする）、`runs-on`（`ubuntu-*` → `linux`、`macos-*` → `macos`）、`timeout-minutes`、`strategy.matrix`、`secrets.X` の参照からジョブの `secrets` を集める、式の `github.*`（`event_name` → `event`、`ref`・`sha`・`repository` → `repo`・`actor`・`event.inputs.x` → `inputs.x`）、`github.token` → `secrets.GITHUB_TOKEN`（利用者が登録していなければ、Hub がジョブの受け取り時に GitHub App のインストールトークン（そのリポジトリだけ・約 1 時間）を渡し、ログでは伏せる。フォークからの PR には渡さない）
- 部品：`actions/checkout`・`setup-node`・`setup-java`・`setup-go`・`setup-python`・`subosito/flutter-action`（→ `setup-flutter`）・`cache`・`upload-artifact`・`download-artifact`（name を省いたものは、依存先が保存した成果物ごとに分けて取り出す）。そのほかの部品は「変換できません」
- Actions の台本との互換（Runner）：環境変数 `CI`・`GITHUB_SHA`・`GITHUB_REF`・`GITHUB_REF_NAME`・`GITHUB_EVENT_NAME`（Actions の名前。manual は `workflow_dispatch`）・`GITHUB_REPOSITORY`・`GITHUB_ACTOR`・`GITHUB_RUN_NUMBER`、手順ごとのファイル `GITHUB_OUTPUT`（→ 後の手順の式で `steps.<id>.outputs.<名前>`）・`GITHUB_ENV`（後の手順の環境変数）・`GITHUB_PATH`・`GITHUB_STEP_SUMMARY`（ログに写す）。手順の `id` と `steps.<id>.outcome` を使える。ジョブの env の `${{ secrets.X }}` などは Runner が値にする。成果物は Actions と同じく、指定したものに共通する一番近いフォルダを起点にまとめる（`path: app/build/x.apk` なら、取り出すと `<取り出し先>/x.apk`）
- concurrency の group には `${{ matrix.x }}` のほか、`${{ ref }}`・`${{ branch }}`・`${{ event }}` を書ける（Hub が実行の値に置き換える）

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
