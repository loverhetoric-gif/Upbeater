# Upbeater 設計書

## 目的

GitHub 上の自作リポジトリの main が更新されたら、登録したすべての端末（macOS・Linux・Android・iOS）へ最新版を自動で届け、入れ替える。
**GitHub Actions は一切使わない。**

## 方式：プッシュ型

各端末が GitHub を見に行く（クローン・定期確認）のではなく、更新の瞬間に Hub から各端末へ通知して届ける。

1. GitHub → Webhook（push イベント、main のみ）→ Hub
2. Hub → ビルド担当（Mac 上の Builder）へビルド指示
3. Builder → `git fetch` → 対象 OS ごとにビルド → 成果物を R2 へアップロード → Hub へ完了報告（版＝コミット SHA、SHA-256、サイズ）
   - ビルド不要のアプリ（Web 等）はこの段を省く
4. Hub → 各端末へ更新通知（Android：FCM、iOS・macOS：APNs、Linux：WebSocket）
5. 端末の Upbeater → マニフェスト取得・署名検証 → 成果物取得・SHA-256 照合 → インストール → 結果を Hub へ報告

※ GitHub の Webhook は Actions とは別の仕組みで、Actions の実行時間を消費しない。

## 構成

| 部品 | 技術 | 役割 |
| --- | --- | --- |
| `hub/` | Cloudflare Workers（TypeScript）＋ D1 ＋ R2 ＋ Durable Objects | Webhook 受信、版と端末の管理、通知、マニフェスト署名、成果物の配布 |
| `builder/` | TypeScript（Node）、Mac で launchd 常駐 | ビルド指示の受信、ビルド、R2 へのアップロード |
| `app/` | Flutter（macOS・Linux・Android・iOS） | 端末登録、通知受信、取得、検証、インストール、管理画面 |

Hub の公開は Cloudflare 側（Workers Builds または wrangler）で行い、Actions は使わない。

## データ（D1）

- `apps`：id、名前、リポジトリ、ブランチ、対象 OS、OS ごとのビルド手順
- `releases`：app_id、commit_sha、OS、R2 のキー、SHA-256、サイズ、作成日時、状態
- `devices`：id、名前、OS、通知トークン、認証トークンのハッシュ、最終接続
- `installs`：device_id、app_id、commit_sha、状態、メッセージ、更新日時

## 安全

- Webhook：`X-Hub-Signature-256` を HMAC-SHA256 で検証。シークレットは Worker の Secret に置く（LININGS. 経由で投入し、値をチャットに出さない）
- マニフェスト：Hub が Ed25519 で署名し、端末アプリに埋め込んだ公開鍵で検証
- 成果物：SHA-256 を照合。R2 からの取得は有効期限の短い署名付き URL
- 端末認証：登録時に発行するトークン。Hub はハッシュだけを保存
- GitHub のトークンは Builder の Mac だけが持つ。Hub は持たない

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
2. builder：指示の受信 → ビルド → R2 へのアップロード → 報告
3. app（Android・macOS）：登録、通知受信、取得、検証、インストール、報告
4. app（Linux・iOS）
5. 管理画面：アプリ一覧、端末ごとの版、失敗の一覧、前の版へ戻す

## 未決事項

- iOS：有料の Apple Developer 登録の有無（第 1 段階の前提）
- 最初に対象とするアプリ
