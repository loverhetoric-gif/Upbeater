# 引き継ぎ

## 終わったこと

`cd hub && npm test`（77 件）、`cd builder && npm test`（15 件）、`cd app && flutter test`（40 件）がすべて通る（型検査・`flutter analyze`・`wrangler deploy --dry-run`・Builder の組み立ても成功）。本番への公開はまだ行っていない。

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

### 開発順序3：Builder

| 項目 | 実装 |
| --- | --- |
| 待ち行列（Hub） | `migrations/0003_builder.sql`、`src/versions.ts`：版ができたら配布物ごとに指示を積み、古い版の指示は取り消す |
| Builder API（Hub） | `src/routes/builder.ts`：受け取り（古い順・OS で絞る・二重に渡さない）、生存の連絡と中断の指示、成果物の提出（SHA-256 の照合）、失敗の報告、連絡の途絶えた指示の回収 |
| 成果物の保存（Hub） | `src/artifact-store.ts`：受け取りながら SHA-256 を計算し、一致したものだけを ready にする。途中で切れた・不一致・取り消し済みは R2 から消す |
| MCP の道具 | `create_builder`・`list_builders`・`list_builds`（失敗の段階・理由・末尾ログ）・`set_build_steps`、`register_app` に `install_steps` を追加 |
| Builder 本体 | `builder/src/`：点検 → 取得 → コミットの照合 → ビルド → 成果物の確認 → 提出。作業場所は使い捨て、子プロセスはグループごと停止、秘密情報はログから伏せる |
| 常駐 | `builder/launchd/`・`builder/install.sh`：launchd で常駐し、落ちたら起動し直す |

### 受け入れ条件（RESILIENCE.md「ビルド（Builder）」）との対応

| 局面 | テスト |
| --- | --- |
| Mac が停止・スリープ中（指示を残し、復帰時は最新版だけ） | `hub/test/builder-api.test.ts`・`builder/test/builder.test.ts` |
| ビルド失敗（配信しない・現行版を維持・末尾ログを MCP から取得） | 同上 |
| 途中で中断（作業場所を破棄し最初から。中途半端な成果物を上げない） | 同上 |
| 複数アプリの同時更新（順番に処理・古い指示は統合） | 同上 |
| ビルドに必要な道具の不足（開始前に点検し具体的に報告） | 同上 |
| 署名の資格情報（保管の二重化・期限の予告） | 未対応（下の「残り」） |

### 開発順序4：app（Android・macOS）

| 項目 | 実装 |
| --- | --- |
| 署名の検証 | `app/lib/core/manifest.dart`：Hub の `acceptManifest` と同じ規則。Hub（TypeScript）が作った署名で照合を確かめた（`app/test/fixtures/manifests.json` は公開鍵と署名のみ） |
| 取得 | `app/lib/core/downloader.dart`：Range・If-Range で続きから再開、SHA-256 とサイズの照合、不一致は破棄 |
| 更新の手順 | `app/lib/core/updater.dart`：事前確認（許可・回線・空き容量・使用中）→ 取得 → 導入 → 起動の確認 → 報告。失敗・起動しない場合は前の版に戻す |
| Android | `app/lib/platform/android.dart`・`MainActivity.kt`：PackageInstaller、パッケージ名・署名鍵・versionCode の事前照合、導入の許可の案内（一度だけ） |
| macOS | `app/lib/platform/macos.dart`：展開 → バンドル ID の照合 → `/Applications` の差し替え → 隔離属性の解除 → 起動の確認、自己更新は別プロセス |
| 画面 | 登録の画面・アプリの一覧（スマホ・タブレット・PC と暗い表示に対応。人の判断が要るものを先頭に並べる） |
| Hub | `GET /v1/devices/apps`、マニフェストに導入の設定（`install`）を追加し署名に含めた |

### 受け入れ条件（RESILIENCE.md）との対応

| 局面 | テスト |
| --- | --- |
| 通知が届かない（起動時・復帰時・定期の照合） | `app/lib/app_service.dart`（照合の契機）・`app/test/updater_test.dart` |
| 端末が長期間オフライン（途中の版を飛ばす） | `app/test/updater_test.dart` |
| ダウンロードの中断（続きから再開、検証を通ったものだけ） | `app/test/downloader_test.dart` |
| 署名・SHA-256 の不一致（破棄して再取得、繰り返す場合はその版を止める） | `app/test/manifest_test.dart`・`downloader_test.dart`・`updater_test.dart` |
| 古い版へのすり替え | `app/test/manifest_test.dart`・`updater_test.dart` |
| 空き容量の不足・従量制通信 | `app/test/updater_test.dart` |
| インストールの失敗（直前の版へ戻す、直近 2 つを保持） | `app/test/updater_test.dart`・`macos_installer_test.dart` |
| 入れ替え後に起動しない | 同上 |
| 対象アプリが使用中 | 同上 |
| 利用者データ（同じ署名鍵・同じバンドル ID） | `macos_installer_test.dart`（バンドル ID）、Android は `MainActivity.kt` の署名鍵の照合 |
| 権限の喪失（導入の許可の取り消し） | `app/test/updater_test.dart`（一度だけ案内して保留） |
| Upbeater 自身の更新失敗 | macOS は別プロセスでの入れ替えと戻しを実装（実機での確認が必要） |
| Hub 自体の障害 | `app/test/updater_test.dart` |

## 残り

- **実機での組み立てと確認（利用者の端末が要る）**：この環境では Android SDK の配布元（dl.google.com）が通信方針で遮断され、Xcode も無いため、`flutter build apk`・`flutter build macos` と Kotlin のコンパイルを確かめられていない。Mac で `flutter build macos`、Android SDK のある環境で `flutter build apk` を実行して確かめる
- 更新通知（FCM・APNs）：Firebase の設定ファイルと Apple の資格情報が要る。いまは起動時・復帰時・15 分ごとの照合で追いつく
- Android のバックグラウンドでの定期照合（WorkManager）と、macOS のログイン時の起動
- 低電力モードの考慮、署名期限の予告
- 署名の資格情報（Android の署名鍵・Apple の証明書）の保管の二重化と期限の予告
- 本番公開（利用者の操作が要る）：GitHub App の作成、D1・R2 の作成、Secret の投入（LININGS. 経由）、`wrangler deploy`、claude.ai へのコネクタ追加、Mac への Builder の導入
- Hub と Builder・端末アプリを実際につないだ通し確認
- 人の判断が要る失敗の利用者への通知、段階配信・一時停止・失敗の連鎖の停止（Hub 側）

## 次にやること（開発順序5：app（Linux・iOS））

1. Linux：AppImage の差し替えと `systemd --user` での再起動（`app/lib/platform/linux.dart`）
2. iOS 第 1 段階：通知＋ワンタップ導入（`itms-services` の OTA 配布。Ad Hoc 署名と UDID 登録が必要。DESIGN.md の未決事項を先に決める）
3. 上の「実機での組み立てと確認」を合わせて行う

## 注意

- `npm install` は `hub/.npmrc`・`builder/.npmrc` の `legacy-peer-deps=true` を前提にしている
- `@cloudflare/vitest-pool-workers` は `@cloudflare/vitest-plugin` に改名された。後で移行を検討する
- 暫定の管理 API `PUT /v1/admin/.../artifacts/:os` は、GitHub Releases を使うアプリ（`release`）の成果物の登録とテストのために残している
- Flutter は 3.47.9（Dart 3.13）で確かめた
