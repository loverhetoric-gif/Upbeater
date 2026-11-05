# Upbeater 設計書

## 目的

GitHub 上のリポジトリの main が更新されたら、登録したすべての端末（macOS・Linux・Android・iOS）へ最新版を自動で届け、入れ替える。
**GitHub Actions は一切使わない。**

## 最優先：汎用性

- 特定のアプリ・言語・リポジトリに依存しない。対象は GitHub 上の任意のリポジトリ（公開・非公開）
- アプリの追加は設定だけで行い、Upbeater 本体のコードは変えない（リポジトリ直下の `upbeater.yml`、または Hub への登録）
- 配布物の種類を抽象化する
  - `direct`：ビルド不要。リポジトリの内容をそのまま配る（Web・スクリプト等）
  - `build`：Builder がビルドして配る
  - `release`：GitHub Releases に既にある成果物を配る
- インストール方法は「OS × 形式」の差し替え可能な部品として実装する（apk・app・appimage・ipa・web・script）
- 複数の利用者に対応できるデータ構造で作る（全テーブルに owner_id）

## 方式：プッシュ型

各端末が GitHub を見に行くのではなく、更新の瞬間に Hub から各端末へ通知して届ける。

1. GitHub → Webhook（push イベント、main のみ）→ Hub
2. Hub → Builder（Mac 上）へビルド指示（`build` の場合のみ）
3. Builder → `git fetch` → 対象 OS ごとにビルド → 成果物を R2 へ → Hub へ完了報告（版＝コミット SHA、SHA-256、サイズ）
4. Hub → 各端末へ更新通知（Android：FCM、iOS・macOS：APNs、Linux：WebSocket）
5. 端末の Upbeater → マニフェスト取得・署名検証 → 成果物取得・SHA-256 照合 → インストール → 結果を Hub へ報告

※ GitHub の Webhook は Actions とは別の仕組みで、Actions の実行時間を消費しない。

## 接続口：MCP コネクタ

Hub に MCP サーバー（`/mcp`）を持たせ、claude.ai のコネクタとして接続する。Claude が会話の中から、いつでも配信を実行できるようにする。

| ツール | 内容 |
| --- | --- |
| `list_apps` / `get_app` | アプリ一覧、端末ごとの版と状態 |
| `register_app` | リポジトリと設定からアプリを登録 |
| `push_update` | アプリ・版・対象端末を指定して即時配信（省略時は最新版を全端末へ） |
| `rollback` | 指定した版へ戻す |
| `list_devices` / `get_install_status` | 端末一覧、配信結果 |
| `create_branch` / `commit_files` / `open_pr` / `merge_pr` | GitHub 操作（次節） |

認証は claude.ai のコネクタが対応する OAuth で行う。

## GitHub 操作の内製化

claude.ai の GitHub コネクタでは、PR 作成時の確認画面が読み込めず作業が止まる事象が起きた。Upbeater は自前の資格情報（GitHub App。秘密情報は LININGS. で保管）で、ブランチ作成 → コミット → PR → マージを一続きで実行し、この役割を担う。

- 失敗しても止まらない：失敗した段階・理由・再試行できるかを返す。確認画面を介さない
- マージ後は自動で配信へつながる（main へのマージ → Webhook → 配信）
- 安全：操作できるリポジトリは許可リストで限定する。main への直接書き込みは禁止し、PR 経由のみとする。マージ前に衝突の有無を確認する

## 構成

| 部品 | 技術 | 役割 |
| --- | --- | --- |
| `hub/` | Cloudflare Workers（TypeScript）＋ D1 ＋ R2 ＋ Durable Objects | Webhook 受信、MCP、GitHub 操作、版と端末の管理、通知、マニフェスト署名、成果物の配布 |
| `builder/` | TypeScript（Node）、Mac で launchd 常駐 | ビルド指示の受信、ビルド、R2 へのアップロード |
| `app/` | Flutter（macOS・Linux・Android・iOS） | 端末登録、通知受信、取得、検証、インストール、管理画面 |

Hub の公開は Cloudflare 側（Workers Builds または wrangler）で行い、Actions は使わない。

## データ（D1）

- `apps`：id、owner_id、名前、リポジトリ、ブランチ、配布の種類、対象 OS、OS ごとの手順
- `releases`：app_id、commit_sha、OS、R2 のキー、SHA-256、サイズ、作成日時、状態
- `devices`：id、owner_id、名前、OS、通知トークン、認証トークンのハッシュ、最終接続
- `installs`：device_id、app_id、commit_sha、状態、メッセージ、更新日時
- `operations`：GitHub 操作と配信の履歴（段階、結果、理由）

## 安全

- Webhook：`X-Hub-Signature-256` を HMAC-SHA256 で検証
- マニフェスト：Hub が Ed25519 で署名し、端末アプリに埋め込んだ公開鍵で検証
- 成果物：SHA-256 を照合。R2 からの取得は有効期限の短い署名付き URL
- 端末認証：登録時に発行するトークン。Hub はハッシュだけを保存
- 秘密情報（Webhook のシークレット、署名用の秘密鍵、GitHub App の秘密鍵、APNs・FCM の資格情報）は Worker の Secret に置き、LININGS. 経由で投入する。リポジトリ・ログ・チャットに出さない

## OS ごとのインストール

- **Android**：PackageInstaller のセッションで導入。Android 12 以降、Upbeater がそのアプリの導入元であれば確認なしで更新できる（`USER_ACTION_NOT_REQUIRED`）。初回のみ「不明なアプリのインストール」の許可が必要
- **macOS**：取得した `.app` を検証後、`/Applications` 内を差し替え、隔離属性を外して再起動
- **Linux**：AppImage を差し替え、`systemd --user` で再起動
- **iOS**：段階的に実装する
  - 第 1 段階：通知＋ワンタップ導入（`itms-services` の OTA 配布。Ad Hoc 署名と端末の UDID 登録が必要）
  - 第 2 段階：端末内での署名・導入（SideStore と同じ方式）を検討
- Upbeater 自身も同じ仕組みで更新する

## 開発の順序

1. hub：Webhook の受信と検証、D1、R2、マニフェスト署名、端末登録 API
2. hub：MCP サーバーと GitHub 操作（コネクタとして接続できる状態にする）
3. builder：指示の受信 → ビルド → R2 へのアップロード → 報告
4. app（Android・macOS）：登録、通知受信、取得、検証、インストール、報告
5. app（Linux・iOS）
6. 管理画面：アプリ一覧、端末ごとの版、失敗の一覧、前の版へ戻す

## 未決事項

- iOS：有料の Apple Developer 登録の有無（第 1 段階の前提）
- 最初に対象とするアプリ
