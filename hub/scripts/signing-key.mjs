#!/usr/bin/env node
/**
 * 端末への配布の署名鍵（Secret MANIFEST_SIGNING_KEYS）を用意する（利用者の Mac で実行する。何度実行してもよい）
 *
 *   node scripts/signing-key.mjs            … 無ければ作って入れる。あれば何も変えない
 *
 * - 鍵は Ed25519。形式は manifest.ts の parseSigningKeys と同じ {"active":1,"keys":[{"gen":1,"jwk":{...}}]}
 * - 秘密の部分は画面にもログにも出さない。~/.upbeater/hub-secrets.json（権限 600）にだけ保存する
 * - Hub に入っていれば変えない（鍵を変えると、配布済みの端末が署名を確かめられなくなるため。世代の交代は別に行う）
 * - 最後に、端末アプリに埋め込む公開鍵（{"世代":"x"}）を表示し、~/.upbeater/public-keys.json にも置く（公開してよい値）
 */
import { spawnSync } from "node:child_process";
import { generateKeyPairSync } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HUB_DIR = join(dirname(fileURLToPath(import.meta.url)), "..");
const STORE = join(homedir(), ".upbeater", "hub-secrets.json");
const PUBLIC = join(homedir(), ".upbeater", "public-keys.json");
const NAME = "MANIFEST_SIGNING_KEYS";

const log = (s) => console.log(`・${s}`);
const fail = (s) => {
  console.error(`\n✕ ${s}`);
  process.exit(1);
};

/** 新しい鍵の組（世代 1）を作る */
export function newSigningKeys() {
  const { privateKey } = generateKeyPairSync("ed25519");
  const jwk = privateKey.export({ format: "jwk" });
  return { active: 1, keys: [{ gen: 1, jwk: { kty: "OKP", crv: "Ed25519", d: jwk.d, x: jwk.x } }] };
}

/** 端末に埋め込む公開鍵（{"世代":"x"}）。秘密の部分 d は含めない */
export function embeddedPublicKeys(set) {
  return Object.fromEntries(set.keys.map((k) => [String(k.gen), k.jwk.x]));
}

function wrangler(args, input) {
  const r = spawnSync("npx", ["wrangler", ...args], { cwd: HUB_DIR, input, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"], env: { ...process.env, CI: "1", WRANGLER_SEND_METRICS: "false" } });
  return { code: r.status ?? 1, out: `${r.stdout ?? ""}${r.stderr ?? ""}` };
}

function loadStore() {
  if (!existsSync(STORE)) return {};
  return JSON.parse(readFileSync(STORE, "utf8"));
}

function saveFile(path, text) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, text, { mode: 0o600 });
  chmodSync(path, 0o600);
}

async function main() {
  const store = loadStore();
  const listed = wrangler(["secret", "list", "--format", "json"]);
  if (listed.code !== 0) fail(`Hub の Secret の一覧を読めませんでした（Cloudflare にログインしてください）：\n${listed.out.slice(-600)}`);
  let names = [];
  try {
    names = JSON.parse(listed.out.slice(listed.out.indexOf("["))).map((s) => s.name);
  } catch {
    fail("Hub の Secret の一覧の形が分かりませんでした");
  }
  const inHub = names.includes(NAME);
  if (inHub && !store[NAME]) fail(`Hub には ${NAME} が入っていますが、この Mac の ${STORE} にありません。別の PC で作った鍵です。その PC で実行してください`);

  const set = store[NAME] ? JSON.parse(store[NAME]) : newSigningKeys();
  if (!store[NAME]) {
    saveFile(STORE, JSON.stringify({ ...store, [NAME]: JSON.stringify(set) }, null, 2));
    log(`署名鍵を作り、${STORE} に保存しました`);
  }
  if (!inHub) {
    const r = wrangler(["secret", "put", NAME], JSON.stringify(set));
    if (r.code !== 0) fail(`Secret ${NAME} を入れられませんでした：\n${r.out.slice(-600)}`);
    log(`Secret ${NAME}：入れました`);
  } else {
    log(`Secret ${NAME}：設定済み（変えません）`);
  }

  const pub = embeddedPublicKeys(set);
  saveFile(PUBLIC, JSON.stringify(pub));
  log(`公開鍵（端末アプリに埋め込む値。公開してよい）：${JSON.stringify(pub)}`);
  log(`同じ値を ${PUBLIC} に置きました`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((e) => fail(String(e?.message ?? e)));
}
