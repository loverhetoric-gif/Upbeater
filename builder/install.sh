#!/bin/sh
# Upbeater Builder を Mac に入れて launchd で常駐させる（何度実行してもよい）
set -eu
DIR=$(cd "$(dirname "$0")" && pwd)
NODE=$(command -v node || true)
[ -n "$NODE" ] || { echo "node が見つかりません。Node.js 20 以降を入れてください" >&2; exit 1; }
mkdir -p "$HOME/.upbeater" && chmod 700 "$HOME/.upbeater"

cd "$DIR"
npm ci --no-audit --no-fund
npm run -s build

if [ ! -f "$HOME/.upbeater/builder.json" ]; then
  cat > "$HOME/.upbeater/builder.json" <<JSON
{
  "hub_url": "https://<Hub のアドレス>",
  "os": ["android", "macos", "ios"],
  "poll_seconds": 20
}
JSON
  echo "設定ファイルを作りました：$HOME/.upbeater/builder.json（hub_url と os を直してください）"
fi
if [ ! -f "$HOME/.upbeater/builder.token" ]; then
  echo "トークンがありません。MCP の create_builder で発行し、$HOME/.upbeater/builder.token に保存して chmod 600 を実行してから、もう一度この手順を実行してください" >&2
  exit 1
fi
chmod 600 "$HOME/.upbeater/builder.token"

PLIST="$HOME/Library/LaunchAgents/com.upbeater.builder.plist"
mkdir -p "$HOME/Library/LaunchAgents"
sed -e "s#__NODE__#$NODE#g" -e "s#__HOME__#$HOME#g" -e "s#__DIR__#$DIR#g" -e "s#__PATH__#$PATH#g" "$DIR/launchd/com.upbeater.builder.plist" > "$PLIST"
launchctl bootout "gui/$(id -u)/com.upbeater.builder" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$PLIST"
echo "起動しました。ログ：$HOME/.upbeater/builder.log"
