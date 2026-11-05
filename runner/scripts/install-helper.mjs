#!/usr/bin/env node
/**
 * install.sh の補助（JSON の読み取りと版の比較）
 *   pick <os> <arch>        標準入力の go.dev の配布一覧から、最新の安定版の書庫を選ぶ →「ファイル名 SHA-256」
 *   atleast <goversion> <必要な版>   例 atleast go1.25.3 1.24 → 足りていれば終了コード 0
 *   hub <hub-secrets.json>  Hub のアドレス
 *   code                    標準入力（admin.mjs runner-code の出力）から登録コードを取り出す
 */
import { readFileSync } from "node:fs";

const [cmd, a, b] = process.argv.slice(2);
const stdin = () => readFileSync(0, "utf8");
const nums = (v) => String(v).replace(/^go/, "").split(/[^0-9]+/).filter(Boolean).map(Number);

switch (cmd) {
  case "pick": {
    const list = JSON.parse(stdin());
    const rel = list.find((r) => r.stable);
    const f = rel?.files.find((x) => x.os === a && x.arch === b && x.kind === "archive");
    if (!f || !/^[0-9a-f]{64}$/.test(f.sha256)) process.exit(1);
    console.log(`${f.filename} ${f.sha256}`);
    break;
  }
  case "atleast": {
    const [x, y] = [nums(a), nums(b)];
    for (let i = 0; i < Math.max(x.length, y.length); i++) {
      if ((x[i] ?? 0) !== (y[i] ?? 0)) process.exit((x[i] ?? 0) > (y[i] ?? 0) ? 0 : 1);
    }
    process.exit(0);
  }
  case "hub": {
    const v = JSON.parse(readFileSync(a, "utf8")).hub_url;
    if (!v) process.exit(1);
    console.log(v);
    break;
  }
  case "code": {
    const m = /([A-Z0-9]{5}-?[A-Z0-9]{5})/.exec(stdin());
    if (!m) process.exit(1);
    console.log(m[1]);
    break;
  }
  default:
    process.exit(2);
}
