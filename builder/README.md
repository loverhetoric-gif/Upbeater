# Upbeater Builder

Mac で常駐し、Hub の待ち行列からビルド指示を受け取って、ビルド → 成果物の提出 → 報告を行う。設計は `../docs/DESIGN.md`、受け入れ条件は `../docs/RESILIENCE.md`。

## 動き

1. Hub に指示を取りに行く（Hub から呼ばれるのを待つ方式ではないため、Mac がスリープ・停止していても指示は Hub に残る。復帰後は各アプリの最新版だけを受け取る）
2. 開始前に必要な道具を点検し、足りなければ具体的に報告する
3. 使い捨ての作業場所に、指示されたコミットだけを `git fetch` する（取得用の短期トークンは git にだけ渡し、ビルド手順には渡さない）
4. アプリの手順（`install_steps`）に従ってビルドする。手順はすべて Hub から受け取り、Builder 本体にアプリ固有の処理は持たない
5. 成果物が作業場所の中の空でないファイルであることを確かめ、SHA-256 を付けて提出する（フォルダは tar.gz にまとめる）
6. 失敗したら、段階・理由・末尾ログ（秘密情報は伏せる）を報告する。中断は自動で再試行され、ビルドの失敗と道具の不足は人の判断を待つ
7. 作業場所は成功・失敗・中断のどれでも消す。起動時には前回の中断で残ったものも消す

ビルド中は 30 秒ごとに Hub へ生存を連絡し、新しい版に置き換わっていれば中断する。連絡が 10 分途絶えると、Hub は指示を待ち行列に戻す（3 回まで）。

## ビルド手順の書き方（MCP の `register_app` または `set_build_steps`）

```json
{
  "android": { "requires": ["flutter", "java"], "build": ["flutter build apk --release"], "artifact": "build/app/outputs/flutter-apk/app-release.apk", "timeout_minutes": 30 },
  "macos": { "requires": ["flutter", "xcodebuild"], "build": ["flutter build macos --release"], "artifact": "build/macos/Build/Products/Release/App.app" }
}
```

手順の中では `UPBEATER_APP_ID`・`UPBEATER_SEQ`（通番）・`UPBEATER_COMMIT`・`UPBEATER_OS` が使える。`artifact` を省くとリポジトリの内容（.git を除く）を配る。

## 導入（Mac）

1. MCP の `create_builder` で Builder を登録し、表示されたトークンを `~/.upbeater/builder.token` に保存する（`chmod 600`。他の利用者が読める状態では起動しない）
2. `./install.sh` を実行する（初回は `~/.upbeater/builder.json` を作るので、`hub_url` と `os` を直して再実行する）
3. ログは `~/.upbeater/builder.log`。停止は `launchctl bootout gui/$(id -u)/com.upbeater.builder`

## 動作確認

```sh
npm install
npm test        # 模擬 Hub とローカルの Git リポジトリで、成功・失敗・中断・取り消し・時間切れ・Hub の停止を確かめる
npm run typecheck
```
