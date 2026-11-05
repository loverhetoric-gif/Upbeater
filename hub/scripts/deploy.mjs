#!/usr/bin/env node
/**
 * Upbeater Hub の公開（利用者の PC で 1 回実行する。何度実行してもよい）
 *
 *   node scripts/deploy.mjs --pem <GitHub App の秘密鍵 .pem のパス>
 *
 * 1. Cloudflare にログイン（未ログインならブラウザが開く）
 * 2. R2 のバケットを用意し、D1 にスキーマを適用する
 * 3. Worker を公開する
 * 4. Secret を投入する（WEBHOOK_SECRET・SECRETS_KEY・ADMIN_TOKEN はこの PC で生成。既にあるものは変えない）
 * 5. GitHub App の Webhook の送り先とシークレットを設定する
 *
 * 秘密情報の値は画面にもログにも出さない。生成した値は ~/.upbeater/hub-secrets.json（権限 600）に保存する。
 */
import { spawnSync } from "node:child_process";
import { createSign, generateKeyPairSync, randomBytes, createVerify } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HUB_DIR = join(dirname(fileURLToPath(import.meta.url)), "..");
const APP_ID = "5623766";
const BUCKET = "upbeater-blobs";
const DB = "upbeater";
const STORE = join(homedir(), ".upbeater", "hub-secrets.json");

const log = (s) => console.log(`・${s}`);
const fail = (s) => {
  console.error(`\n✕ ${s}`);
  process.exit(1);
};

function wrangler(args, opts = {}) {
  const r = spawnSync("npx", ["wrangler", ...args], {
    cwd: HUB_DIR,
    input: opts.input,
    encoding: "utf8",
    stdio: opts.interactive ? "inherit" : ["pipe", "pipe", "pipe"],
    env: { ...process.env, CI: opts.interactive ? process.env.CI : "1", WRANGLER_SEND_METRICS: "false" },
  });
  return { code: r.status ?? 1, out: `${r.stdout ?? ""}${r.stderr ?? ""}` };
}

const b64url = (b) => Buffer.from(b).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

/** GitHub App の JWT（RS256。有効期間は GitHub の上限 10 分未満） */
export function appJwt(appId, pem, nowSec = Math.floor(Date.now() / 1000)) {
  const head = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const body = b64url(JSON.stringify({ iat: nowSec - 60, exp: nowSec + 540, iss: appId }));
  const sig = createSign("RSA-SHA256").update(`${head}.${body}`).sign(pem);
  return `${head}.${body}.${b64url(sig)}`;
}

function selfTest() {
  // 使い捨ての鍵で JWT の作成と検証を確かめる（公開はしない）
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048, privateKeyEncoding: { type: "pkcs1", format: "pem" }, publicKeyEncoding: { type: "spki", format: "pem" } });
  const jwt = appJwt(APP_ID, privateKey, 1_800_000_000);
  const [h, b, s] = jwt.split(".");
  const ok = createVerify("RSA-SHA256").update(`${h}.${b}`).verify(publicKey, Buffer.from(s.replace(/-/g, "+").replace(/_/g, "/"), "base64"));
  const claims = JSON.parse(Buffer.from(b, "base64").toString());
  if (!ok || claims.iss !== APP_ID || claims.exp - claims.iat !== 600) fail("JWT の自己点検に失敗しました");
  console.log("自己点検：JWT の作成と検証 OK");
}

function loadStore() {
  try {
    return JSON.parse(readFileSync(STORE, "utf8"));
  } catch {
    return {};
  }
}
function saveStore(v) {
  mkdirSync(dirname(STORE), { recursive: true, mode: 0o700 });
  writeFileSync(STORE, JSON.stringify(v, null, 2), { mode: 0o600 });
  chmodSync(STORE, 0o600);
}

async function main() {
  const args = process.argv.slice(2);
  if (args.includes("--self-test")) return selfTest();
  const pemPath = args[args.indexOf("--pem") + 1];
  if (!args.includes("--pem") || !pemPath) fail("使い方：node scripts/deploy.mjs --pem <GitHub App の秘密鍵 .pem のパス>");
  if (!existsSync(pemPath)) fail(`秘密鍵のファイルがありません：${pemPath}`);
  const pem = readFileSync(pemPath, "utf8");
  if (!/-----BEGIN (RSA )?PRIVATE KEY-----/.test(pem)) fail("指定のファイルは秘密鍵（PEM）ではありません");

  console.log("Upbeater Hub を公開します\n");

  // 1. Cloudflare
  if (wrangler(["whoami"]).out.includes("You are not authenticated")) {
    log("Cloudflare にログインします（ブラウザが開きます）");
    if (wrangler(["login"], { interactive: true }).code !== 0) fail("Cloudflare にログインできませんでした");
  }
  log("Cloudflare：ログイン済み");

  // 2. R2・D1
  const r2 = wrangler(["r2", "bucket", "list"]);
  if (/10042|enable R2/i.test(r2.out)) fail("R2 が有効になっていません。Cloudflare の画面の「R2」で有効にしてから、もう一度実行してください");
  if (!r2.out.includes(BUCKET)) {
    const c = wrangler(["r2", "bucket", "create", BUCKET]);
    if (c.code !== 0 && !/already exists/i.test(c.out)) fail(`R2 のバケットを作れませんでした：\n${c.out.slice(-800)}`);
  }
  log(`R2：${BUCKET}`);
  const mig = wrangler(["d1", "migrations", "apply", DB, "--remote"]);
  if (mig.code !== 0) fail(`D1 のスキーマを適用できませんでした：\n${mig.out.slice(-800)}`);
  log("D1：スキーマを適用しました");

  // 3. 公開
  const dep = wrangler(["deploy"]);
  if (dep.code !== 0) fail(`公開に失敗しました：\n${dep.out.slice(-1200)}`);
  const url = (dep.out.match(/https:\/\/[a-z0-9.-]+\.workers\.dev/) ?? [])[0];
  if (!url) fail("公開先のアドレスが分かりませんでした（Cloudflare の画面で workers.dev を有効にしてください）");
  log(`公開しました：${url}`);

  // 4. Secret（既にあるものは変えない。SECRETS_KEY を変えると保存済みの秘密情報が読めなくなるため）
  const store = loadStore();
  const listed = wrangler(["secret", "list", "--format", "json"]);
  const existing = new Set((() => {
    try {
      return JSON.parse(listed.out.slice(listed.out.indexOf("["))).map((s) => s.name);
    } catch {
      return [];
    }
  })());
  const values = {
    WEBHOOK_SECRET: store.WEBHOOK_SECRET ?? b64url(randomBytes(32)),
    SECRETS_KEY: store.SECRETS_KEY ?? randomBytes(32).toString("base64"),
    ADMIN_TOKEN: store.ADMIN_TOKEN ?? `upb_admin_${b64url(randomBytes(32))}`,
  };
  saveStore({ ...store, ...values, hub_url: url });
  for (const [name, value] of [...Object.entries(values), ["GITHUB_APP_PRIVATE_KEY", pem]]) {
    if (existing.has(name) && name !== "GITHUB_APP_PRIVATE_KEY") {
      log(`Secret ${name}：設定済み（変えません）`);
      continue;
    }
    const r = wrangler(["secret", "put", name], { input: value });
    if (r.code !== 0) fail(`Secret ${name} を入れられませんでした：\n${r.out.replace(value, "[伏せ字]").slice(-600)}`);
    log(`Secret ${name}：入れました`);
  }

  // 5. GitHub App の Webhook の送り先とシークレット
  const res = await fetch("https://api.github.com/app/hook/config", {
    method: "PATCH",
    headers: { authorization: `Bearer ${appJwt(APP_ID, pem)}`, accept: "application/vnd.github+json", "x-github-api-version": "2022-11-28", "user-agent": "upbeater-deploy" },
    body: JSON.stringify({ url: `${url}/webhook/github`, content_type: "json", secret: values.WEBHOOK_SECRET, insecure_ssl: "0" }),
  });
  if (!res.ok) fail(`GitHub App の Webhook を設定できませんでした（${res.status}）。秘密鍵が App（ID ${APP_ID}）のものか確かめてください`);
  log("GitHub App：Webhook の送り先とシークレットを設定しました");

  const health = await fetch(`${url}/health`).then((r) => r.ok).catch(() => false);
  log(`動作確認：${health ? "応答あり" : "応答なし（数分後にもう一度確かめてください）"}`);

  console.log(`
完了しました。残りは GitHub の画面での 2 つの操作です：
  1. https://github.com/settings/apps/upbeater-loverhetoric で「Active」にチェックを入れ、
     「Subscribe to events」で Push・Pull request・Delete にチェックを入れて保存する
  2. 対象のリポジトリに App をインストールする（https://github.com/settings/apps/upbeater-loverhetoric/installations）

管理用のトークンなどは ${STORE} に保存しました（他の人に見せない）。`);
}

main().catch((e) => fail(e instanceof Error ? e.message : String(e)));
