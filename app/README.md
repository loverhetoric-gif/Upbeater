# Upbeater 端末アプリ（Flutter）

登録した端末で、Hub から届く最新版を検証して導入する。対応：Android・macOS（Linux・iOS は開発順序5）。

## 動き

1. 登録：Claude（MCP の `create_device_code`）で発行した一回限りのコードで端末を登録する。端末トークンは OS の安全な保管場所に置く
2. 照合：起動時・復帰時・15 分ごとに Hub へ照合する（通知が届かなくても追いつく）。Hub が止まっていても、端末は現行版のまま動き続ける
3. 検証：マニフェストの Ed25519 署名を、アプリに埋め込んだ公開鍵で検証する。失効した世代・知らない世代・改ざん・期限切れ・別のアプリや OS 向けは拒否する。通番が現行より小さい版は、署名付きの巻き戻し指示がない限り拒否する
4. 事前確認：導入の許可、Wi-Fi 接続時のみの設定、空き容量、対象アプリの使用中を確かめ、満たせなければ保留して理由を報告する
5. 取得：中断しても続きから再開する（Range・If-Range）。完了して SHA-256 とサイズが一致したものだけを使う。不一致は破棄して取り直し、同じ版で 2 回失敗したらその版は試さない
6. 導入：OS ごとの部品で入れ替え、起動を確かめる。失敗・起動しない場合は、保持しているひとつ前の版に戻す（直近 2 つの版を保持）
7. 報告：取得中・導入中・導入済み・保留・失敗・復元を Hub に報告する

## OS ごとの導入

| OS | 方法 | 戻し |
| --- | --- | --- |
| Android | PackageInstaller のセッション。Android 12 以降、Upbeater が導入元なら確認なしで更新できる。パッケージ名・署名鍵・versionCode を事前に照合する | Android は版を下げられないため、導入の失敗では OS が元の版のまま残す |
| macOS | 成果物（`.app` の tar.gz）を展開し、バンドル ID を照合して `/Applications` 内を差し替え、隔離属性を外して起動を確かめる | 起動しなければ、保持していた前の版に戻す |

Upbeater 自身の macOS 版の更新は、別プロセスが終了を待って入れ替え、起動を確かめる。起動しなければ前の版に戻して起動し、アプリは次の起動時にその版を二度と試さない。

## 導入の設定（Hub の `install_steps[os].install`。署名付きで端末に届く）

| 項目 | 内容 |
| --- | --- |
| `package` | Android のパッケージ名（成果物と一致しなければ導入しない） |
| `bundle` | macOS の `.app` の名前（例：`Example.app`） |
| `bundle_id` | macOS のバンドル ID（一致しなければ導入しない） |
| `when_running` | 対象アプリが使用中のとき：`wait`（終了を待つ）／`next_launch`（次に終了した後）／`restart`（終了させて入れ替える） |
| `health_seconds` | 入れ替え後に起動を確かめる時間（秒、既定 15。0 で確かめない） |

Android の versionCode は通番で必ず上がるようにする（Flutter なら Builder の手順で `flutter build apk --build-number=$UPBEATER_SEQ`）。

## 組み立て

公開鍵（Hub の `/v1/keys` の `x`）をアプリに埋め込む。秘密鍵は埋め込まない。

```sh
flutter build apk --release --dart-define=UPBEATER_PUBLIC_KEYS='{"1":"<x>","2":"<x>"}'
flutter build macos --release --dart-define=UPBEATER_PUBLIC_KEYS='{"1":"<x>"}'
```

失効させた世代は `--dart-define=UPBEATER_REVOKED_GENERATIONS=1` で埋め込める（Hub が失効を知らせた世代も、受け取った時点で拒否する）。

macOS 版は `/Applications` を書き換え、他のアプリを起動するため、App Sandbox を無効にしている。

## Android 版を端末に入れる（最初の 1 回）

1. 署名の鍵を作る（一度だけ）：`.upbeater/android-keygen.yml` を手動実行。Mac の `~/.upbeater/android-signing` の控えを取る
2. 組み立てて配る：`.upbeater/app-android.yml` を手動実行
3. 端末で「開発者向けオプション → ワイヤレス デバッグ」を有効にし、Mac と同じ Wi-Fi につなぐ
4. `.upbeater/android-install.yml` を手動実行する。入力は `connect_address`（ワイヤレス デバッグの画面の IP アドレスとポート）、初めての時だけ `pair_address`・`pair_code`（「ペア設定コードによるデバイスのペア設定」の画面。開いたまま実行する）
5. 端末の Upbeater を開き、Claude で発行した登録コードで登録する。以後は Upbeater が自分で更新する（初回の更新だけ、導入元の確認が 1 回出ることがある）

## 動作確認

```sh
flutter analyze
flutter test   # 署名（Hub が作った署名との照合）・取得の再開・更新の手順・macOS の入れ替え・画面の崩れ
```
