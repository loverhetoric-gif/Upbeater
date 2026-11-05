// テスト用の模擬 GitHub（別の Worker として起動し、GITHUB_API に束縛する）
// API（api.github.com 相当）と Web（github.com の OAuth 相当）の両方を受ける。
// 制御用の経路は /__mock/ で始まる。
const EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";

let S;
function resetState() {
  S = {
    branches: new Map(),      // "owner/repo#branch" → sha
    commits: new Map(),       // sha → { tree, parents }
    trees: new Map([[EMPTY_TREE, {}]]), // treeId → { path: content }
    blobs: new Map(),         // sha → content（utf-8 文字列）
    missingRepos: new Set(),
    defaults: new Map(),      // repo → 既定ブランチ
    pulls: new Map(),         // repo → [PR]
    nextPr: 1,
    failures: [],             // { status, headers, path, method }
    delayMs: 0,
    headCalls: 0,
    app: null,                // { appId, publicJwk }
    uninstalled: new Set(),
    tokens: new Set(),
    oauthSecret: "test-github-client-secret",
    oauthCodes: new Map(),    // code → user
    userTokens: new Map(),    // token → user
    protect: new Map(),       // repo → { failing, pending, reviews, strict }
    unknownMergeable: 0,
    races: new Map(),         // "repo#branch" → 残り回数
  };
}
resetState();

const json = (v, status = 200, headers = {}) =>
  new Response(JSON.stringify(v), { status, headers: { "content-type": "application/json", ...headers } });
const randSha = () => [...crypto.getRandomValues(new Uint8Array(20))].map((b) => b.toString(16).padStart(2, "0")).join("");
const key = (repo, branch) => `${repo.toLowerCase()}#${branch}`;
const b64d = (s) => { const bin = atob(s.replace(/\s+/g, "")); return new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0))); };
const b64urlDecode = (s) => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4)), (c) => c.charCodeAt(0));

function treeOf(sha) {
  const c = S.commits.get(sha);
  return { ...(S.trees.get(c ? c.tree : EMPTY_TREE) ?? {}) };
}
function newTree(obj) { const id = randSha(); S.trees.set(id, obj); return id; }
function newCommit(tree, parents) { const sha = randSha(); S.commits.set(sha, { tree, parents }); return sha; }
function ancestors(sha) {
  const seen = new Set(); const q = [sha];
  while (q.length) { const s = q.shift(); if (seen.has(s)) continue; seen.add(s); for (const p of S.commits.get(s)?.parents ?? []) q.push(p); }
  return seen;
}
function mergeBase(a, b) {
  const A = ancestors(a); const q = [b]; const seen = new Set();
  while (q.length) { const s = q.shift(); if (A.has(s)) return s; if (seen.has(s)) continue; seen.add(s); for (const p of S.commits.get(s)?.parents ?? []) q.push(p); }
  return null;
}
function diff(fromTree, toTree) {
  const out = new Map();
  for (const p of new Set([...Object.keys(fromTree), ...Object.keys(toTree)])) if (fromTree[p] !== toTree[p]) out.set(p, toTree[p]);
  return out; // path → 新しい内容（undefined は削除）
}
function analyze(headSha, baseSha) {
  const mb = mergeBase(headSha, baseSha);
  const mbTree = mb ? treeOf(mb) : {};
  const headChanges = diff(mbTree, treeOf(headSha));
  const baseChanges = diff(mbTree, treeOf(baseSha));
  const conflicts = [...headChanges.keys()].filter((p) => baseChanges.has(p) && baseChanges.get(p) !== headChanges.get(p));
  const merged = treeOf(baseSha);
  for (const [p, v] of headChanges) { if (v === undefined) delete merged[p]; else merged[p] = v; }
  return { mb, headChanges, baseChanges, conflicts, merged, behind: !ancestors(headSha).has(baseSha) };
}

function prJson(repo, pr) {
  const head = S.branches.get(key(repo, pr.head));
  const base = S.branches.get(key(repo, pr.base));
  let mergeable = null, state = "unknown";
  if (pr.merged) { mergeable = false; state = "unknown"; }
  else if (S.unknownMergeable > 0) { S.unknownMergeable--; }
  else {
    const a = analyze(head, base);
    const prot = S.protect.get(repo);
    if (a.conflicts.length) { mergeable = false; state = "dirty"; }
    else if (prot?.strict && a.behind) { mergeable = true; state = "behind"; }
    else if (prot && (prot.failing?.length || prot.pending?.length || prot.reviews)) { mergeable = true; state = "blocked"; }
    else { mergeable = true; state = "clean"; }
  }
  return {
    number: pr.number, state: pr.state, merged: pr.merged, mergeable, mergeable_state: state, draft: false,
    head: { ref: pr.head, sha: head }, base: { ref: pr.base, sha: base },
    html_url: `https://github.com/${repo}/pull/${pr.number}`, merge_commit_sha: pr.merge_commit_sha ?? null,
  };
}

async function verifyJwt(auth) {
  if (!S.app) return true;
  const m = /^Bearer (.+)\.(.+)\.(.+)$/.exec(auth ?? "");
  if (!m) return false;
  const key = await crypto.subtle.importKey("jwk", S.app.publicJwk, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]);
  const ok = await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, b64urlDecode(m[3]), new TextEncoder().encode(`${m[1]}.${m[2]}`));
  if (!ok) return false;
  const body = JSON.parse(new TextDecoder().decode(b64urlDecode(m[2])));
  const now = Math.floor(Date.now() / 1000);
  return String(body.iss) === String(S.app.appId) && body.exp > now && body.iat <= now && body.exp - body.iat <= 600;
}

async function control(p, body) {
  switch (p) {
    case "/__mock/reset": resetState(); return json({ ok: true });
    case "/__mock/branch": if (body.sha === null) S.branches.delete(key(body.repo, body.branch)); else S.branches.set(key(body.repo, body.branch), body.sha); return json({ ok: true });
    case "/__mock/seed": {
      const parent = S.branches.get(key(body.repo, body.branch));
      const tree = { ...(parent ? treeOf(parent) : {}), ...body.files };
      for (const [k, v] of Object.entries(body.files)) if (v === null) delete tree[k];
      const sha = newCommit(newTree(tree), parent ? [parent] : []);
      S.branches.set(key(body.repo, body.branch), sha);
      if (body.default) S.defaults.set(body.repo.toLowerCase(), body.branch);
      return json({ sha });
    }
    case "/__mock/tree": { const sha = S.branches.get(key(body.repo, body.branch)); return json({ sha: sha ?? null, files: sha ? treeOf(sha) : null }); }
    case "/__mock/pulls": return json(S.pulls.get(body.repo.toLowerCase()) ?? []);
    case "/__mock/fail": for (let i = 0; i < body.count; i++) S.failures.push({ status: body.status, headers: body.headers ?? {}, path: body.path, method: body.method }); return json({ ok: true });
    case "/__mock/delay": S.delayMs = body.ms; return json({ ok: true });
    case "/__mock/calls": return json({ calls: S.headCalls });
    case "/__mock/repo": if (body.missing) S.missingRepos.add(body.repo.toLowerCase()); if (body.uninstalled) S.uninstalled.add(body.repo.toLowerCase()); return json({ ok: true });
    case "/__mock/app": S.app = { appId: body.app_id, publicJwk: body.public_jwk }; return json({ ok: true });
    case "/__mock/revoke-tokens": S.tokens.clear(); return json({ ok: true });
    case "/__mock/oauth-user": S.oauthCodes.set(body.code, { id: body.id, login: body.login }); return json({ ok: true });
    case "/__mock/protect": S.protect.set(body.repo.toLowerCase(), body); return json({ ok: true });
    case "/__mock/unknown-mergeable": S.unknownMergeable = body.count; return json({ ok: true });
    case "/__mock/race": S.races.set(key(body.repo, body.branch), body.count); return json({ ok: true });
  }
  return json({ error: "unknown" }, 404);
}

export default {
  async fetch(req) {
    const url = new URL(req.url);
    const p = url.pathname;
    const method = req.method;
    const body = method === "GET" ? {} : await req.json().catch(() => ({}));
    if (p.startsWith("/__mock/")) return control(p, body);

    if (S.delayMs) await new Promise((r) => setTimeout(r, S.delayMs));
    const fi = S.failures.findIndex((f) => (!f.path || p.includes(f.path)) && (!f.method || f.method === method));
    if (fi >= 0) { const f = S.failures.splice(fi, 1)[0]; if (/\/git\/ref\/heads\//.test(p)) S.headCalls++; return json({ message: "simulated failure" }, f.status, f.headers); }

    // ── OAuth（github.com 側） ──
    if (p === "/login/oauth/access_token" && method === "POST") {
      const user = S.oauthCodes.get(body.code);
      if (!user || body.client_secret !== S.oauthSecret) return json({ error: "bad_verification_code" });
      S.oauthCodes.delete(body.code);
      const t = "gho_" + randSha(); S.userTokens.set(t, user);
      return json({ access_token: t, token_type: "bearer" });
    }
    if (p === "/user") {
      const user = S.userTokens.get((req.headers.get("authorization") ?? "").replace(/^Bearer /, ""));
      return user ? json(user) : json({ message: "Bad credentials" }, 401);
    }

    // ── GitHub App ──
    let m;
    if ((m = /^\/repos\/([^/]+)\/([^/]+)\/installation$/.exec(p))) {
      if (!(await verifyJwt(req.headers.get("authorization")))) return json({ message: "A JSON web token could not be decoded" }, 401);
      const repo = `${m[1]}/${m[2]}`.toLowerCase();
      if (S.uninstalled.has(repo)) return json({ message: "Not Found" }, 404);
      return json({ id: 1000 + repo.length });
    }
    if ((m = /^\/app\/installations\/(\d+)\/access_tokens$/.exec(p)) && method === "POST") {
      if (!(await verifyJwt(req.headers.get("authorization")))) return json({ message: "A JSON web token could not be decoded" }, 401);
      const t = "ghs_" + randSha(); S.tokens.add(t);
      return json({ token: t, expires_at: new Date(Date.now() + 3600_000).toISOString() }, 201);
    }

    m = /^\/repos\/([^/]+)\/([^/]+)(\/.*)?$/.exec(p);
    if (!m) return json({ message: "Not Found" }, 404);
    const repo = `${decodeURIComponent(m[1])}/${decodeURIComponent(m[2])}`.toLowerCase();
    const rest = m[3] ?? "";
    // App が設定されていれば、インストールトークン以外は拒否する
    const auth = req.headers.get("authorization");
    if (S.app && auth && !S.tokens.has(auth.replace(/^Bearer /, ""))) return json({ message: "Bad credentials" }, 401);
    if (S.missingRepos.has(repo)) return json({ message: "Not Found" }, 404);

    if (rest === "" && method === "GET") return json({ full_name: repo, default_branch: S.defaults.get(repo) ?? "main" });

    if ((m = /^\/git\/ref\/heads\/(.+)$/.exec(rest)) && method === "GET") {
      S.headCalls++;
      const branch = m[1].split("/").map(decodeURIComponent).join("/");
      const sha = S.branches.get(key(repo, branch));
      return sha ? json({ ref: `refs/heads/${branch}`, object: { sha, type: "commit" } }) : json({ message: "Not Found" }, 404);
    }
    if (rest === "/git/refs" && method === "POST") {
      const branch = body.ref.replace(/^refs\/heads\//, "");
      if (S.branches.has(key(repo, branch))) return json({ message: "Reference already exists" }, 422);
      S.branches.set(key(repo, branch), body.sha);
      return json({ ref: body.ref, object: { sha: body.sha } }, 201);
    }
    if ((m = /^\/git\/commits\/([0-9a-f]{40})$/.exec(rest))) {
      const c = S.commits.get(m[1]);
      return json({ sha: m[1], tree: { sha: c ? c.tree : EMPTY_TREE }, parents: (c?.parents ?? []).map((s) => ({ sha: s })) });
    }
    if (rest === "/git/blobs" && method === "POST") { const sha = randSha(); S.blobs.set(sha, body.encoding === "base64" ? b64d(body.content) : body.content); return json({ sha }, 201); }
    if (rest === "/git/trees" && method === "POST") {
      const t = { ...(S.trees.get(body.base_tree) ?? {}) };
      for (const e of body.tree) { if (e.sha === null) delete t[e.path]; else t[e.path] = S.blobs.get(e.sha); }
      return json({ sha: newTree(t) }, 201);
    }
    if (rest === "/git/commits" && method === "POST") return json({ sha: newCommit(body.tree, body.parents) }, 201);
    if ((m = /^\/git\/refs\/heads\/(.+)$/.exec(rest)) && method === "PATCH") {
      const branch = m[1].split("/").map(decodeURIComponent).join("/");
      const k = key(repo, branch);
      const left = S.races.get(k) ?? 0;
      if (left > 0) { // 他の書き込みが先に入った状況を作る
        S.races.set(k, left - 1);
        const cur = S.branches.get(k);
        const t = { ...treeOf(cur), [`race-${left}.txt`]: "other" };
        S.branches.set(k, newCommit(newTree(t), [cur]));
      }
      const cur = S.branches.get(k);
      if (!cur) return json({ message: "Reference does not exist" }, 422);
      if (!body.force && !ancestors(body.sha).has(cur)) return json({ message: "Update is not a fast forward" }, 422);
      S.branches.set(k, body.sha);
      return json({ ref: `refs/heads/${branch}`, object: { sha: body.sha } });
    }

    const pulls = S.pulls.get(repo) ?? [];
    S.pulls.set(repo, pulls);
    if (rest === "/pulls" && method === "GET") {
      const head = url.searchParams.get("head")?.split(":")[1];
      const base = url.searchParams.get("base");
      return json(pulls.filter((x) => x.state === "open" && (!head || x.head === head) && (!base || x.base === base)).map((x) => prJson(repo, x)));
    }
    if (rest === "/pulls" && method === "POST") {
      if (pulls.some((x) => x.state === "open" && x.head === body.head && x.base === body.base)) {
        return json({ message: "Validation Failed", errors: [{ message: `A pull request already exists for ${body.head}.` }] }, 422);
      }
      if (!S.branches.has(key(repo, body.head))) return json({ message: "Validation Failed", errors: [{ message: "head が見つかりません" }] }, 422);
      const pr = { number: S.nextPr++, head: body.head, base: body.base, title: body.title, state: "open", merged: false };
      pulls.push(pr);
      return json(prJson(repo, pr), 201);
    }
    if ((m = /^\/pulls\/(\d+)(\/.*)?$/.exec(rest))) {
      const pr = pulls.find((x) => x.number === Number(m[1]));
      if (!pr) return json({ message: "Not Found" }, 404);
      const sub = m[2] ?? "";
      const headSha = S.branches.get(key(repo, pr.head));
      const baseSha = S.branches.get(key(repo, pr.base));
      if (sub === "" && method === "GET") return json(prJson(repo, pr));
      if (sub === "/files") return json([...analyze(headSha, baseSha).headChanges.keys()].map((filename) => ({ filename })));
      if (sub === "/update-branch" && method === "PUT") {
        if (body.expected_head_sha && body.expected_head_sha !== headSha) return json({ message: "expected head sha didn't match" }, 422);
        const a = analyze(headSha, baseSha);
        if (a.conflicts.length) return json({ message: "merge conflict between base and head" }, 422);
        // base の変更を head に取り込む
        const t = treeOf(headSha);
        for (const [path, v] of a.baseChanges) { if (v === undefined) delete t[path]; else t[path] = v; }
        S.branches.set(key(repo, pr.head), newCommit(newTree(t), [headSha, baseSha]));
        return json({ message: "Updating pull request branch." }, 202);
      }
      if (sub === "/merge" && method === "PUT") {
        if (body.sha && body.sha !== headSha) return json({ message: "Head branch was modified. Review and try the merge again." }, 409);
        const info = prJson(repo, pr);
        if (info.mergeable_state !== "clean") return json({ message: "Pull Request is not mergeable" }, 405);
        const a = analyze(headSha, baseSha);
        const sha = newCommit(newTree(a.merged), body.merge_method === "merge" ? [baseSha, headSha] : [baseSha]);
        S.branches.set(key(repo, pr.base), sha);
        pr.merged = true; pr.state = "closed"; pr.merge_commit_sha = sha;
        return json({ sha, merged: true, message: "Pull Request successfully merged" });
      }
    }
    if ((m = /^\/compare\/([^.]+)\.\.\.(.+)$/.exec(rest))) {
      const resolve = (x) => S.branches.get(key(repo, decodeURIComponent(x))) ?? decodeURIComponent(x);
      const a = resolve(m[1]), b = resolve(m[2]);
      const mb = mergeBase(a, b);
      return json({ files: [...diff(mb ? treeOf(mb) : {}, treeOf(b)).keys()].map((filename) => ({ filename })) });
    }
    if ((m = /^\/commits\/([^/]+)\/check-runs$/.exec(rest))) {
      const prot = S.protect.get(repo) ?? {};
      return json({
        check_runs: [
          ...(prot.failing ?? []).map((name) => ({ name, status: "completed", conclusion: "failure" })),
          ...(prot.pending ?? []).map((name) => ({ name, status: "in_progress", conclusion: null })),
          ...(prot.passing ?? []).map((name) => ({ name, status: "completed", conclusion: "success" })),
        ],
      });
    }
    if (/^\/commits\/[^/]+\/status$/.test(rest)) return json({ state: "success", statuses: [] });
    return json({ message: "Not Found" }, 404);
  },
};
