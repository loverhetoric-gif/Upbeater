# Upbeater Runner

GitHub Actions の代替の実行環境（macOS・Linux）。Hub からジョブを取りに行き、使い捨ての作業場所で実行する。受け口は開けない。

## 入れ方

Hub を公開した PC（`~/.upbeater/hub-secrets.json` がある PC）で、次の 1 行を実行する。何度実行してもよい。

```sh
sh runner/install.sh
```

Go が無ければ `~/.upbeater/go` に取得し（go.dev の SHA-256 と照合）、Runner を組み立て、登録コードを発行して Hub に登録し、常駐させる（macOS は launchd、Linux は systemd）。ラベルは macOS なら `macos`、Linux なら `linux`。

手で行う場合：

```sh
cd runner
CGO_ENABLED=0 go build -trimpath -ldflags "-s -w -X main.version=0.1.0" -o upbeater-runner .
./upbeater-runner register --hub https://<Hub の URL> --code <登録コード> --labels linux   # macOS は --labels macos
./upbeater-runner service install
```

- 登録コードは Hub の管理 API（`POST /v1/admin/runner-codes`）で発行する（一回限り）
- 設定は `~/.config/upbeater-runner/config.json`（macOS は `~/Library/Application Support/upbeater-runner/config.json`）。Runner トークンを含むため権限 600。場所は `--config` か環境変数 `UPBEATER_RUNNER_CONFIG` で変えられる
- `service install` は登録した時の `PATH` を引き継ぐ。道具（node・flutter など）を入れた後は入れ直す
- Linux でログアウト中も動かすには `loginctl enable-linger $USER`

## 作業場所の隔離

| 設定 `isolation` | 動き |
| --- | --- |
| `auto`（既定） | Linux はコンテナ（docker・podman が使える時）、macOS は専用の一時ディレクトリ |
| `container` | 常にコンテナ。イメージは `container_image`（既定 `ubuntu:24.04`）。道具はイメージに入れておく |
| `dir` | 常に専用の一時ディレクトリ |

## 確かめ方

```sh
go vet ./... && go test -race ./...
```

| 受け入れ条件（`docs/RESILIENCE-JOBS.md`） | テスト |
| --- | --- |
| 作業場所の汚染 | `internal/job`（`TestWorkspaceIsDisposable`）・`internal/workspace`・`internal/archive`（外へ書く書庫の拒否） |
| 時間超過で子プロセスまで終了 | `internal/proc`・`internal/job`（`TestJobTimeoutKillsChildProcesses`・`TestStepTimeout`） |
| ログ送信の途切れ（保持と再送） | `internal/logship`・`internal/job`（`TestLogsSurviveHubOutage`・`TestCompletionKeptWhenHubDown`） |
| 秘密情報の露出（変形も伏せる） | `internal/mask`・`internal/job`（`TestJobRunsStepsAndHidesSecrets`） |
| 新しい更新（取り消し） | `internal/job`（`TestHubCancelStopsJob`） |
| 同じジョブの二重実行 | `internal/job`（`TestStaleJobAborts`）・`internal/agent`（`TestSingleInstance`） |
| Runner の停止・Hub の停止 | `internal/agent`（`TestRegisterAndRunOnce`：Hub が戻るまで待つ・前の残骸の片付け） |

## 制限

- `setup-*` は道具を入れない。入っていて版が合うかを確かめる（Runner の端末・コンテナのイメージに入れておく）
- コンテナでは、手順の `timeout` を超えるとコンテナごと止めるため、その後の手順は動かない
- `cancelled()` は常に偽（取り消し・時間超過では残りの手順を実行しない）
