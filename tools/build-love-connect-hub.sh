#!/bin/zsh
# LOVE connect HUB の中核部品（loverhetoric-gif/love-connect-hub の src/）を、Hub（Cloudflare Workers）で使える 1 つの .mjs にまとめる。
# 取り込み方は N.S Connection と同じ（Rhetoric Studio の tools/lch-rollout.mjs が .lch/vendor.json を読んで、これを動かす）。手で編集しない。
# 使い方: tools/build-love-connect-hub.sh <love-connect-hub を取り出した場所>
set -euo pipefail
HUB="${1:?love-connect-hub の場所を指定してください}"
cd "$(dirname "$0")/.."
OUT=hub/src/vendor/love-connect-hub.mjs
REV="$(git -C "$HUB" rev-parse --short=7 HEAD)"
VER="$(node -p "require('$HUB/package.json').version")"
TMP="$(mktemp)"
# esbuild は版を固定する（hub/package.json と同じ）。Workers で動く標準機能だけの部品なので、外部の部品は入らない
npx --yes esbuild@0.28.1 "$HUB/src/index.ts" --bundle --format=esm --platform=neutral --target=es2022 --log-level=warning --outfile="$TMP"
mkdir -p "$(dirname "$OUT")"
# 組み立てた場所の書き込み（// ../../〜/src/lanes.ts）は、場所によって変わらないように love-connect-hub/src/〜 にそろえる
{ echo "// 自動生成（tools/build-love-connect-hub.sh）。手で編集しない。元は loverhetoric-gif/love-connect-hub $VER（$REV）の src/。"; sed -E 's#^// .*/src/([A-Za-z0-9_./-]+\.ts)$#// love-connect-hub/src/\1#' "$TMP"; } > "$OUT"
rm -f "$TMP"
echo "作成しました: $OUT（$VER・$REV）"
