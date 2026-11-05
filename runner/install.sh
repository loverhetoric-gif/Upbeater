#!/bin/sh
# Upbeater Runner を入れる（1 回実行するだけ。何度実行してもよい）
#   sh runner/install.sh
# Go が無ければ ~/.upbeater/go に取得し（SHA-256 を照合）、Runner を組み立て、Hub に登録し、常駐させる。
set -eu

DIR=$(cd "$(dirname "$0")" && pwd)
ROOT=$(cd "$DIR/.." && pwd)
HELP="$DIR/scripts/install-helper.mjs"
SECRETS="$HOME/.upbeater/hub-secrets.json"

say() { printf '・%s\n' "$1"; }
die() { printf '\n✕ %s\n' "$1" >&2; exit 1; }

command -v node >/dev/null 2>&1 || die "node が見つかりません（Hub の公開で使ったものと同じ Node.js が必要です）"
[ -f "$SECRETS" ] || die "$SECRETS がありません。先に hub/scripts/deploy.mjs を実行してください"

case "$(uname -s)" in
  Darwin) OS=darwin; LABEL=macos; CONFIG="$HOME/Library/Application Support/upbeater-runner/config.json" ;;
  Linux) OS=linux; LABEL=linux; CONFIG="$HOME/.config/upbeater-runner/config.json" ;;
  *) die "この OS には対応していません" ;;
esac
case "$(uname -m)" in
  arm64 | aarch64) ARCH=arm64 ;;
  x86_64 | amd64) ARCH=amd64 ;;
  *) die "この CPU（$(uname -m)）には対応していません" ;;
esac

sha256() { if command -v shasum >/dev/null 2>&1; then shasum -a 256 "$1" | awk '{print $1}'; else sha256sum "$1" | awk '{print $1}'; fi; }

# 1. Go（組み立てにだけ使う。既に入っていて版が足りていればそれを使う）
NEED=$(awk '/^go /{print $2}' "$DIR/go.mod")
GO=""
if command -v go >/dev/null 2>&1 && node "$HELP" atleast "$(go env GOVERSION)" "$NEED"; then
  GO=$(command -v go)
elif [ -x "$HOME/.upbeater/go/bin/go" ] && node "$HELP" atleast "$("$HOME/.upbeater/go/bin/go" env GOVERSION)" "$NEED"; then
  GO="$HOME/.upbeater/go/bin/go"
else
  say "Go を取得します（Runner の組み立てに使います。~/.upbeater/go に置き、ほかには影響しません）"
  INFO=$(curl -fsSL "https://go.dev/dl/?mode=json" | node "$HELP" pick "$OS" "$ARCH") || die "Go の配布一覧を読めませんでした"
  FILE=${INFO% *}
  SUM=${INFO#* }
  TMP=$(mktemp -d)
  curl -fsSL -o "$TMP/$FILE" "https://go.dev/dl/$FILE" || die "Go を取得できませんでした"
  [ "$(sha256 "$TMP/$FILE")" = "$SUM" ] || { rm -rf "$TMP"; die "取得した Go の SHA-256 が一致しません（壊れているか、すり替えの可能性）"; }
  mkdir -p "$HOME/.upbeater"
  rm -rf "$HOME/.upbeater/go"
  tar -xzf "$TMP/$FILE" -C "$HOME/.upbeater"
  rm -rf "$TMP"
  GO="$HOME/.upbeater/go/bin/go"
fi
say "Go：$("$GO" env GOVERSION)"

# 2. 組み立て
cd "$DIR"
CGO_ENABLED=0 "$GO" build -trimpath -ldflags "-s -w" -o upbeater-runner . || die "Runner を組み立てられませんでした"
say "Runner を組み立てました"

# 3. 登録（済んでいれば飛ばす）
if [ -f "$CONFIG" ]; then
  say "Hub への登録：済み"
else
  HUB=$(node "$HELP" hub "$SECRETS") || die "Hub のアドレスが分かりません"
  CODE=$(node "$ROOT/hub/scripts/admin.mjs" runner-code | node "$HELP" code) || die "登録コードを発行できませんでした"
  ./upbeater-runner register --hub "$HUB" --code "$CODE" --labels "$LABEL" --name "$(hostname -s)" >/dev/null || die "Hub に登録できませんでした"
  say "Hub に登録しました（ラベル：$LABEL）"
fi

# 4. 常駐（ログイン時に起動し、落ちたら起動し直す）
#    Runner 専用の道具（~/.upbeater/tools/<名前>/）があれば、その bin を Runner の PATH の先頭に足す
#    （普段使いの道具の版を変えずに、定義が求める版を Runner にだけ用意できる）
TOOLS=""
for b in "$HOME"/.upbeater/tools/*/bin "$HOME"/.upbeater/tools/*/Contents/Home/bin; do
  [ -d "$b" ] && TOOLS="$TOOLS$b:"
done
[ -n "$TOOLS" ] && say "Runner 専用の道具：$(printf '%s' "$TOOLS" | tr ':' '\n' | sed -n 's#.*/tools/\([^/]*\)/.*#\1#p' | sort -u | tr '\n' ' ')"
PATH="$TOOLS$PATH" ./upbeater-runner service install >/dev/null || die "常駐の設定に失敗しました"
say "常駐させました"

printf '\n完了しました。この Mac は Upbeater のジョブを受け取れる状態です。\n'
