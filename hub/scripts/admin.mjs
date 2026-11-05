#!/usr/bin/env node
/**
 * Upbeater Hub の管理（利用者の PC で使う。開発順序4の MCP ができるまでの暫定）
 * 管理用トークンは ~/.upbeater/hub-secrets.json（deploy.mjs が作る）から読み、画面に出さない。
 *
 *   node scripts/admin.mjs repo <owner/name> [--branch main]   リポジトリを登録する
 *   node scripts/admin.mjs runner-code                          Runner の登録コード（15 分・一回限り）
 *   node scripts/admin.mjs secret <名前> [--repo owner/name]    秘密情報を登録する（値は伏せて入力）
 *   node scripts/admin.mjs secret-form [--repo owner/name] <名前>…   秘密情報の入力ページ（スマホで開ける・一回限り・期限なし。同じリポジトリの前のページは使えなくなる）を発行する
 *   node scripts/admin.mjs run <owner/name> <定義ファイル>       手動実行（例 .upbeater/ci.yml）
 *   node scripts/admin.mjs mcp-connect [--owner ログイン名]     Upbeater の MCP をこの PC の Claude Code に登録する（トークンは画面に出さない）
 */
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";

const STORE = join(homedir(), ".upbeater", "hub-secrets.json");
const fail = (s) => {
  console.error(`✕ ${s}`);
  process.exit(1);
};

let store;
try {
  store = JSON.parse(readFileSync(STORE, "utf8"));
} catch {
  fail(`${STORE} がありません。先に scripts/deploy.mjs を実行してください`);
}
if (!store.hub_url || !store.ADMIN_TOKEN) fail(`${STORE} に Hub のアドレスか管理用トークンがありません`);

const [cmd, ...rest] = process.argv.slice(2);
const opt = (name) => {
  const i = rest.indexOf(`--${name}`);
  return i >= 0 ? rest[i + 1] : undefined;
};

async function call(method, path, body) {
  const res = await fetch(store.hub_url + path, {
    method,
    headers: { authorization: `Bearer ${store.ADMIN_TOKEN}`, "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json = {};
  try {
    json = JSON.parse(text);
  } catch {}
  if (!res.ok) fail(`Hub がエラーを返しました（${res.status}）：${json.message ?? json.error ?? text.slice(0, 200)}`);
  return json;
}

/** 利用者の識別子（MCP の OAuth と同じ gh:<GitHub のユーザー ID>） */
async function ownerId(login) {
  const res = await fetch(`https://api.github.com/users/${encodeURIComponent(login)}`, { headers: { "user-agent": "upbeater-admin" } });
  if (!res.ok) fail(`GitHub のアカウント ${login} が見つかりません`);
  return `gh:${(await res.json()).id}`;
}

function askHidden(prompt) {
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    rl._writeToOutput = (s) => {
      if (s.includes(prompt)) process.stdout.write(s);
    };
    rl.question(prompt, (v) => {
      rl.close();
      process.stdout.write("\n");
      resolve(v);
    });
  });
}

const repoArg = (v) => {
  if (!v || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(v)) fail("リポジトリは owner/name の形で指定してください");
  return v;
};

switch (cmd) {
  case "repo": {
    const repo = repoArg(rest[0]);
    const r = await call("POST", "/v1/admin/repos", { owner_id: await ownerId(repo.split("/")[0]), repo, default_branch: opt("branch") ?? "main" });
    console.log(`登録しました：${repo}（${r.id}）`);
    break;
  }
  case "runner-code": {
    const login = opt("owner") ?? "loverhetoric-gif";
    const r = await call("POST", "/v1/admin/runner-codes", { owner_id: await ownerId(login) });
    console.log(`Runner の登録コード：${r.code}（15 分で失効・一回限り）`);
    break;
  }
  case "secret": {
    const name = rest[0];
    if (!name || !/^[A-Z_][A-Z0-9_]*$/.test(name)) fail("名前は英大文字・数字・_ で指定してください（例 CLOUDFLARE_API_TOKEN）");
    const repo = opt("repo");
    const value = await askHidden(`${name} の値（表示されません）：`);
    if (!value) fail("値が空です");
    const login = (repo ?? "loverhetoric-gif/x").split("/")[0];
    await call("PUT", "/v1/admin/secrets", { owner_id: await ownerId(login), name, value, ...(repo ? { repo: repoArg(repo) } : {}) });
    console.log(`登録しました：${name}${repo ? `（${repo} 専用）` : "（全リポジトリ共通）"}`);
    break;
  }
  case "secret-form": {
    const repo = opt("repo");
    const names = rest.filter((x, i) => !x.startsWith("--") && rest[i - 1] !== "--repo");
    if (names.length === 0 || names.some((n) => !/^[A-Z_][A-Z0-9_]*$/.test(n))) fail("名前を英大文字・数字・_ で 1 つ以上指定してください");
    const login = (repo ?? "loverhetoric-gif/x").split("/")[0];
    const r = await call("POST", "/v1/admin/secret-forms", { owner_id: await ownerId(login), names, ...(repo ? { repo: repoArg(repo) } : {}) });
    console.log(`入力ページ（一回限り・期限なし）：\n${r.url}`);
    break;
  }
  case "run": {
    const repo = repoArg(rest[0]);
    if (!rest[1]) fail("定義ファイルを指定してください（例 .upbeater/ci.yml）");
    const r = await call("POST", "/v1/admin/runs", { owner_id: await ownerId(repo.split("/")[0]), repo, workflow: rest[1] });
    console.log(`手動実行：${r.status}${r.runs ? `（実行 #${r.runs.map((x) => x.number).join("・#")}）` : ""}`);
    break;
  }
  case "mcp-connect": {
    const login = opt("owner") ?? "loverhetoric-gif";
    const r = await call("POST", "/v1/admin/mcp-tokens", { owner_id: await ownerId(login), name: "claude-code" });
    const url = `${store.hub_url}/mcp`;
    // 前の登録を消してから入れ直す（トークンは引数で渡し、画面には出さない）
    spawnSync("claude", ["mcp", "remove", "--scope", "user", "upbeater"], { stdio: "ignore" });
    const add = spawnSync("claude", ["mcp", "add", "--scope", "user", "--transport", "http", "upbeater", url, "--header", `Authorization: Bearer ${r.token}`], { stdio: ["ignore", "ignore", "pipe"], encoding: "utf8" });
    if (add.status !== 0) fail(`Claude Code に登録できません：${(add.stderr ?? "").replace(r.token, "***").slice(0, 300)}`);
    // つながるかを確かめる
    const res = await fetch(url, { method: "POST", headers: { authorization: `Bearer ${r.token}`, "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }) });
    const tools = res.ok ? ((await res.json()).result?.tools ?? []).length : 0;
    if (!tools) fail(`登録しましたが、Hub の MCP に接続できません（${res.status}）`);
    console.log(`Claude Code に Upbeater の MCP を登録しました（道具 ${tools} 個）。新しい会話から使えます`);
    break;
  }
  default:
    console.log("使い方：node scripts/admin.mjs repo <owner/name> | runner-code | secret <名前> [--repo owner/name] | secret-form [--repo owner/name] <名前>… | run <owner/name> <定義ファイル>");
}
