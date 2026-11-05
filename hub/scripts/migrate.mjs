#!/usr/bin/env node
/**
 * 移行ツール：GitHub Actions の定義を Upbeater の定義に変換する（利用者の PC で使う）
 *
 *   node hub/scripts/migrate.mjs <リポジトリのフォルダ> [--check] [--label 元=先 …]
 *
 *   .github/workflows/*.yml を読み、.upbeater/*.yml を書く。変換できない部分を行番号つきで一覧にする。
 *   --check        書かずに報告だけ
 *   --label a=b    runs-on のラベル a を b に置き換える（例：Linux の Runner がまだ無い時に linux=macos）
 *   --force        .upbeater に同じ名前のファイルがあっても上書きする
 *
 * 終了コード：0 = 変換できた／1 = 「変換できません」がある（定義は書くが、その手順は失敗する）／2 = 使い方の誤り
 * 元の .github/workflows は変えない（Actions を止めるのは、Upbeater で動くのを確かめてから）。
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HUB = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const usage = () => {
  console.error("使い方：node hub/scripts/migrate.mjs <リポジトリのフォルダ> [--check] [--label 元=先] [--force]");
  process.exit(2);
};
let dir;
let check = false;
let force = false;
const labels = {};
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a === "--check") check = true;
  else if (a === "--force") force = true;
  else if (a === "--label") {
    const m = /^([^=\s]+)=([^=\s]+)$/.exec(args[++i] ?? "");
    if (!m) usage();
    labels[m[1]] = m[2];
  } else if (a.startsWith("-")) usage();
  else if (dir) usage();
  else dir = a;
}
if (!dir) usage();
const repo = resolve(dir);
const src = join(repo, ".github", "workflows");
if (!existsSync(src)) {
  console.error(`✕ ${src} がありません`);
  process.exit(2);
}

// 変換の部品（TypeScript）を、その場で 1 つにまとめて読み込む（Hub と同じ部品を使う）
let esbuild;
try {
  esbuild = await import(pathToFileURL(join(HUB, "node_modules", "esbuild", "lib", "main.js")).href);
} catch {
  console.error("✕ hub の部品が入っていません。先に `cd hub && npm ci` を実行してください");
  process.exit(2);
}
// 外の部品（yaml）は hub の node_modules から読む。まとめたものは hub の node_modules/.cache に置く
const bundle = join(HUB, "node_modules", ".cache", "upbeater-migrate.mjs");
mkdirSync(dirname(bundle), { recursive: true });
await esbuild.build({
  entryPoints: [join(HUB, "src", "workflow", "convert.ts")],
  bundle: true,
  packages: "external",
  outfile: bundle,
  format: "esm",
  platform: "node",
  logLevel: "silent",
  absWorkingDir: HUB,
});
const { convertWorkflow } = await import(pathToFileURL(bundle).href);

const files = readdirSync(src).filter((f) => /\.ya?ml$/.test(f)).sort();
if (files.length === 0) {
  console.error(`✕ ${src} に定義がありません`);
  process.exit(2);
}
let errors = 0;
let warnings = 0;
for (const f of files) {
  const source = `.github/workflows/${f}`;
  const r = convertWorkflow(source, readFileSync(join(src, f), "utf8"), { labels });
  const e = r.notes.filter((n) => n.level === "error").length + r.problems.length;
  errors += e;
  warnings += r.notes.length - (e - r.problems.length);
  console.log(`\n■ ${source} → ${r.file}`);
  for (const n of r.notes) console.log(`  ${n.level === "error" ? "✕ 変換できません" : "△ 注意"}  ${n.file}:${n.line}  ${n.message}`);
  for (const p of r.problems) console.log(`  ✕ 変換後の定義の誤り  ${p.file}:${p.line}:${p.column}  ${p.message}`);
  if (r.notes.length === 0 && r.problems.length === 0) console.log("  ✓ そのまま変換できました");
  if (!r.text) continue;
  const out = join(repo, r.file);
  if (check) continue;
  if (existsSync(out) && !force) {
    console.log(`  ・${r.file} は既にあるので書きませんでした（上書きするなら --force）`);
    continue;
  }
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, r.text);
  console.log(`  ・${r.file} を書きました`);
}
console.log(`\n結果：${files.length} 個の定義、変換できない所 ${errors} 件、注意 ${warnings} 件${check ? "（--check のため書いていません）" : ""}`);
if (errors === 0) console.log("次に：.upbeater の定義を PR にし、Upbeater で動くのを確かめてから、.github/workflows を消して Actions を止めてください");
process.exit(errors ? 1 : 0);
