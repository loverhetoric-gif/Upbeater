// テスト用の模擬 GitHub（別の Worker として起動し、GITHUB_API に束縛する）
// API（api.github.com 相当）と Web（github.com の OAuth 相当）の両方を受ける。制御用の経路は /__mock/ で始まる
let S;
function reset() {
  S = {
    branches: new Map(), // "repo#branch" → sha
    files: new Map(), // "repo@sha" → { path: text }
    commits: new Map(), // "repo@sha" → { parents }
    blobs: new Map(), // sha → text
    trees: new Map(), // treeId → { path: text }
    defaults: new Map(), // repo → 既定ブランチ
    pulls: new Map(), // repo → [PR]
    nextPr: 1,
    failures: [], // { status, headers, path, method }
    app: null,
    tokens: new Set(),
    uninstalled: new Set(),
    checks: [], // { id, repo, created: payload, updates: [payload] }
    statuses: [], // { repo, sha, ...payload }
    nextCheck: 1,
    calls: { head: 0, contents: 0, checks: 0 },
    oauthSecret: "test-github-client-secret",
    oauthCodes: new Map(), // code → user
    userTokens: new Map(), // token → user
    protect: new Map(), // repo → { failing, pending, passing, reviews, strict }
    unknownMergeable: 0,
    races: new Map(), // "repo#branch" → 残り回数
  };
}
reset();

const json = (v, status = 200, headers = {}) => new Response(JSON.stringify(v), { status, headers: { "content-type": "application/json", ...headers } });
const b64u = (s) => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4)), (c) => c.charCodeAt(0));
const b64d = (s) => new TextDecoder().decode(Uint8Array.from(atob(s.replace(/\s+/g, "")), (c) => c.charCodeAt(0)));
const randSha = () => [...crypto.getRandomValues(new Uint8Array(20))].map((b) => b.toString(16).padStart(2, "0")).join("");
const bkey = (repo, branch) => `${repo.toLowerCase()}#${branch}`;

// ── git の対象（コミットの中身はリポジトリごと） ──
const treeOf = (repo, sha) => ({ ...(S.files.get(`${repo}@${sha}`) ?? {}) });
function newCommit(repo, files, parents) {
  const sha = randSha();
  S.files.set(`${repo}@${sha}`, files);
  S.commits.set(`${repo}@${sha}`, { parents });
  return sha;
}
function ancestors(repo, sha) {
  const seen = new Set();
  const q = [sha];
  while (q.length) {
    const s = q.shift();
    if (!s || seen.has(s)) continue;
    seen.add(s);
    for (const p of S.commits.get(`${repo}@${s}`)?.parents ?? []) q.push(p);
  }
  return seen;
}
function mergeBase(repo, a, b) {
  const A = ancestors(repo, a);
  const q = [b];
  const seen = new Set();
  while (q.length) {
    const s = q.shift();
    if (A.has(s)) return s;
    if (!s || seen.has(s)) continue;
    seen.add(s);
    for (const p of S.commits.get(`${repo}@${s}`)?.parents ?? []) q.push(p);
  }
  return null;
}
function diff(from, to) {
  const out = new Map();
  for (const p of new Set([...Object.keys(from), ...Object.keys(to)])) if (from[p] !== to[p]) out.set(p, to[p]);
  return out;
}
function analyze(repo, head, base) {
  const mb = mergeBase(repo, head, base);
  const mbTree = mb ? treeOf(repo, mb) : {};
  const headChanges = diff(mbTree, treeOf(repo, head));
  const baseChanges = diff(mbTree, treeOf(repo, base));
  const conflicts = [...headChanges.keys()].filter((p) => baseChanges.has(p) && baseChanges.get(p) !== headChanges.get(p));
  const merged = treeOf(repo, base);
  for (const [p, v] of headChanges) {
    if (v === undefined) delete merged[p];
    else merged[p] = v;
  }
  return { headChanges, baseChanges, conflicts, merged, behind: !ancestors(repo, head).has(base) };
}
function prJson(repo, pr) {
  const head = S.branches.get(bkey(repo, pr.head));
  const base = S.branches.get(bkey(repo, pr.base));
  let mergeable = null;
  let state = "unknown";
  if (pr.merged) mergeable = false;
  else if (S.unknownMergeable > 0) S.unknownMergeable--;
  else {
    const a = analyze(repo, head, base);
    const prot = S.protect.get(repo);
    if (a.conflicts.length) (mergeable = false), (state = "dirty");
    else if (prot?.strict && a.behind) (mergeable = true), (state = "behind");
    else if (prot && (prot.failing?.length || prot.pending?.length || prot.reviews)) (mergeable = true), (state = "blocked");
    else (mergeable = true), (state = "clean");
  }
  return {
    number: pr.number,
    state: pr.state,
    merged: pr.merged,
    mergeable,
    mergeable_state: state,
    draft: false,
    head: { ref: pr.head, sha: head },
    base: { ref: pr.base, sha: base },
    html_url: `https://github.com/${repo}/pull/${pr.number}`,
    merge_commit_sha: pr.merge_commit_sha ?? null,
  };
}

async function verifyJwt(auth) {
  if (!S.app) return true;
  const m = /^Bearer (.+)\.(.+)\.(.+)$/.exec(auth ?? "");
  if (!m) return false;
  const key = await crypto.subtle.importKey("jwk", S.app.publicJwk, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]);
  if (!(await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, b64u(m[3]), new TextEncoder().encode(`${m[1]}.${m[2]}`)))) return false;
  const body = JSON.parse(new TextDecoder().decode(b64u(m[2])));
  return String(body.iss) === String(S.app.appId);
}

function control(p, body) {
  switch (p) {
    case "/__mock/reset": reset(); return json({ ok: true });
    case "/__mock/app": S.app = { appId: body.app_id, publicJwk: body.public_jwk }; return json({ ok: true });
    case "/__mock/commit": {
      const repo = body.repo.toLowerCase();
      if (body.branch) S.branches.set(bkey(repo, body.branch), body.sha);
      S.files.set(`${repo}@${body.sha}`, body.files ?? {});
      S.commits.set(`${repo}@${body.sha}`, { parents: body.parents ?? [] });
      return json({ ok: true });
    }
    // 親を引き継いで、ブランチの上にコミットを積む（null はそのファイルの削除）
    case "/__mock/seed": {
      const repo = body.repo.toLowerCase();
      const parent = S.branches.get(bkey(repo, body.branch));
      const files = { ...(parent ? treeOf(repo, parent) : {}) };
      for (const [k, v] of Object.entries(body.files)) {
        if (v === null) delete files[k];
        else files[k] = v;
      }
      const sha = newCommit(repo, files, parent ? [parent] : []);
      S.branches.set(bkey(repo, body.branch), sha);
      if (body.default) S.defaults.set(repo, body.branch);
      return json({ sha });
    }
    case "/__mock/tree": {
      const repo = body.repo.toLowerCase();
      const sha = S.branches.get(bkey(repo, body.branch));
      return json({ sha: sha ?? null, files: sha ? treeOf(repo, sha) : null });
    }
    case "/__mock/branch":
      if (body.sha === null) S.branches.delete(bkey(body.repo, body.branch));
      else S.branches.set(bkey(body.repo, body.branch), body.sha);
      return json({ ok: true });
    case "/__mock/fail":
      for (let i = 0; i < body.count; i++) S.failures.push({ status: body.status, headers: body.headers ?? {}, path: body.path, method: body.method });
      return json({ ok: true });
    case "/__mock/checks": return json(S.checks.filter((c) => !body.repo || c.repo === body.repo.toLowerCase()));
    case "/__mock/calls": return json(S.calls);
    case "/__mock/statuses": return json(S.statuses.filter((c) => !body.repo || c.repo === body.repo.toLowerCase()));
    case "/__mock/uninstall": S.uninstalled.add(body.repo.toLowerCase()); return json({ ok: true });
    case "/__mock/revoke-tokens": S.tokens.clear(); return json({ ok: true });
    case "/__mock/oauth-user": S.oauthCodes.set(body.code, { id: body.id, login: body.login }); return json({ ok: true });
    case "/__mock/pulls": return json(S.pulls.get(body.repo.toLowerCase()) ?? []);
    case "/__mock/protect": S.protect.set(body.repo.toLowerCase(), body); return json({ ok: true });
    case "/__mock/unknown-mergeable": S.unknownMergeable = body.count; return json({ ok: true });
    case "/__mock/race": S.races.set(bkey(body.repo, body.branch), body.count); return json({ ok: true });
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
    const fi = S.failures.findIndex((f) => (!f.path || p.includes(f.path)) && (!f.method || f.method === method));
    if (fi >= 0) {
      const f = S.failures.splice(fi, 1)[0];
      return json({ message: "simulated failure" }, f.status, f.headers);
    }

    // ── OAuth（github.com 側） ──
    if (p === "/login/oauth/access_token" && method === "POST") {
      const user = S.oauthCodes.get(body.code);
      if (!user || body.client_secret !== S.oauthSecret) return json({ error: "bad_verification_code" });
      S.oauthCodes.delete(body.code);
      const t = "gho_" + randSha();
      S.userTokens.set(t, user);
      return json({ access_token: t, token_type: "bearer" });
    }
    if (p === "/user") {
      const user = S.userTokens.get((req.headers.get("authorization") ?? "").replace(/^Bearer /, ""));
      return user ? json(user) : json({ message: "Bad credentials" }, 401);
    }

    // ── GitHub App ──
    let m;
    if ((m = /^\/repos\/([^/]+)\/([^/]+)\/installation$/.exec(p))) {
      if (!(await verifyJwt(req.headers.get("authorization")))) return json({ message: "bad jwt" }, 401);
      const repo = `${m[1]}/${m[2]}`.toLowerCase();
      return S.uninstalled.has(repo) ? json({ message: "Not Found" }, 404) : json({ id: 7000 + repo.length });
    }
    if ((m = /^\/app\/installations\/(\d+)\/access_tokens$/.exec(p)) && method === "POST") {
      if (!(await verifyJwt(req.headers.get("authorization")))) return json({ message: "bad jwt" }, 401);
      const t = "ghs_" + crypto.randomUUID().replace(/-/g, "");
      S.tokens.add(t);
      return json({ token: t, expires_at: new Date(Date.now() + 3600_000).toISOString() }, 201);
    }
    m = /^\/repos\/([^/]+)\/([^/]+)(\/.*)?$/.exec(p);
    if (!m) return json({ message: "Not Found" }, 404);
    const auth = req.headers.get("authorization");
    if (S.app && auth && !S.tokens.has(auth.replace(/^Bearer /, ""))) return json({ message: "Bad credentials" }, 401);
    const repo = `${decodeURIComponent(m[1])}/${decodeURIComponent(m[2])}`.toLowerCase();
    const rest = m[3] ?? "";

    if (rest === "" && method === "GET") return json({ full_name: repo, default_branch: S.defaults.get(repo) ?? "main" });
    if ((m = /^\/git\/ref\/heads\/(.+)$/.exec(rest)) && method === "GET") {
      S.calls.head++;
      const sha = S.branches.get(bkey(repo, m[1].split("/").map(decodeURIComponent).join("/")));
      return sha ? json({ object: { sha } }) : json({ message: "Not Found" }, 404);
    }
    if ((m = /^\/contents\/(.+)$/.exec(rest))) {
      S.calls.contents++;
      const path = m[1].split("/").map(decodeURIComponent).join("/");
      const ref = url.searchParams.get("ref");
      const sha = S.files.has(`${repo}@${ref}`) ? ref : S.branches.get(bkey(repo, ref ?? S.defaults.get(repo) ?? "main"));
      const files = S.files.get(`${repo}@${sha}`);
      if (!files) return json({ message: "No commit found" }, 404);
      if (!(path in files)) {
        const list = Object.keys(files).filter((f) => f.startsWith(path + "/") && !f.slice(path.length + 1).includes("/"));
        return list.length ? json(list.map((f) => ({ type: "file", name: f.slice(path.length + 1), path: f }))) : json({ message: "Not Found" }, 404);
      }
      return new Response(files[path]);
    }
    if ((m = /^\/statuses\/([0-9a-f]+)$/.exec(rest)) && method === "POST") {
      S.statuses.push({ repo, sha: m[1], ...body });
      return json({ id: S.statuses.length }, 201);
    }
    if (rest === "/check-runs" && method === "POST") {
      S.calls.checks++;
      const c = { id: S.nextCheck++, repo, created: body, updates: [] };
      S.checks.push(c);
      return json({ id: c.id }, 201);
    }
    if ((m = /^\/check-runs\/(\d+)$/.exec(rest)) && method === "PATCH") {
      S.calls.checks++;
      const c = S.checks.find((x) => x.id === Number(m[1]));
      if (!c) return json({ message: "Not Found" }, 404);
      c.updates.push(body);
      return json({ id: c.id });
    }

    // ── git の操作（ブランチ → コミット） ──
    if (rest === "/git/refs" && method === "POST") {
      const branch = body.ref.replace(/^refs\/heads\//, "");
      if (S.branches.has(bkey(repo, branch))) return json({ message: "Reference already exists" }, 422);
      S.branches.set(bkey(repo, branch), body.sha);
      return json({ ref: body.ref, object: { sha: body.sha } }, 201);
    }
    if ((m = /^\/git\/commits\/([0-9a-f]{40})$/.exec(rest))) {
      // 木の ID はコミットの中身をそのまま写したものにする
      const id = randSha();
      S.trees.set(id, treeOf(repo, m[1]));
      return json({ sha: m[1], tree: { sha: id } });
    }
    if (rest === "/git/blobs" && method === "POST") {
      const sha = randSha();
      S.blobs.set(sha, body.encoding === "base64" ? b64d(body.content) : body.content);
      return json({ sha }, 201);
    }
    if (rest === "/git/trees" && method === "POST") {
      const t = { ...(S.trees.get(body.base_tree) ?? {}) };
      for (const e of body.tree) {
        if (e.sha === null) delete t[e.path];
        else t[e.path] = S.blobs.get(e.sha);
      }
      const id = randSha();
      S.trees.set(id, t);
      return json({ sha: id }, 201);
    }
    if (rest === "/git/commits" && method === "POST") return json({ sha: newCommit(repo, S.trees.get(body.tree) ?? {}, body.parents) }, 201);
    if ((m = /^\/git\/refs\/heads\/(.+)$/.exec(rest)) && method === "PATCH") {
      const k = bkey(repo, m[1].split("/").map(decodeURIComponent).join("/"));
      const left = S.races.get(k) ?? 0;
      if (left > 0) {
        // 他の書き込みが先に入った状況を作る
        S.races.set(k, left - 1);
        const cur = S.branches.get(k);
        S.branches.set(k, newCommit(repo, { ...treeOf(repo, cur), [`race-${left}.txt`]: "other" }, [cur]));
      }
      const cur = S.branches.get(k);
      if (!cur) return json({ message: "Reference does not exist" }, 422);
      if (!body.force && !ancestors(repo, body.sha).has(cur)) return json({ message: "Update is not a fast forward" }, 422);
      S.branches.set(k, body.sha);
      return json({ object: { sha: body.sha } });
    }

    // ── PR ──
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
      if (!S.branches.has(bkey(repo, body.head))) return json({ message: "Validation Failed", errors: [{ message: "head が見つかりません" }] }, 422);
      const pr = { number: S.nextPr++, head: body.head, base: body.base, title: body.title, body: body.body, state: "open", merged: false };
      pulls.push(pr);
      return json(prJson(repo, pr), 201);
    }
    if ((m = /^\/pulls\/(\d+)(\/.*)?$/.exec(rest))) {
      const pr = pulls.find((x) => x.number === Number(m[1]));
      if (!pr) return json({ message: "Not Found" }, 404);
      const sub = m[2] ?? "";
      const headSha = S.branches.get(bkey(repo, pr.head));
      const baseSha = S.branches.get(bkey(repo, pr.base));
      if (sub === "" && method === "GET") return json(prJson(repo, pr));
      if (sub.startsWith("/files")) return json([...analyze(repo, headSha, baseSha).headChanges.keys()].map((filename) => ({ filename })));
      if (sub === "/update-branch" && method === "PUT") {
        if (body.expected_head_sha && body.expected_head_sha !== headSha) return json({ message: "expected head sha didn't match" }, 422);
        const a = analyze(repo, headSha, baseSha);
        if (a.conflicts.length) return json({ message: "merge conflict between base and head" }, 422);
        const t = treeOf(repo, headSha);
        for (const [path, v] of a.baseChanges) {
          if (v === undefined) delete t[path];
          else t[path] = v;
        }
        S.branches.set(bkey(repo, pr.head), newCommit(repo, t, [headSha, baseSha]));
        return json({ message: "Updating pull request branch." }, 202);
      }
      if (sub === "/merge" && method === "PUT") {
        if (body.sha && body.sha !== headSha) return json({ message: "Head branch was modified. Review and try the merge again." }, 409);
        if (prJson(repo, pr).mergeable_state !== "clean") return json({ message: "Pull Request is not mergeable" }, 405);
        const a = analyze(repo, headSha, baseSha);
        const sha = newCommit(repo, a.merged, body.merge_method === "merge" ? [baseSha, headSha] : [baseSha]);
        S.branches.set(bkey(repo, pr.base), sha);
        pr.merged = true;
        pr.state = "closed";
        pr.merge_commit_sha = sha;
        return json({ sha, merged: true, message: "Pull Request successfully merged" });
      }
    }
    if ((m = /^\/compare\/([^.]+)\.\.\.(.+)$/.exec(rest))) {
      const resolve = (x) => S.branches.get(bkey(repo, decodeURIComponent(x))) ?? decodeURIComponent(x);
      const a = resolve(m[1]);
      const b = resolve(m[2]);
      const mb = mergeBase(repo, a, b);
      return json({ files: [...diff(mb ? treeOf(repo, mb) : {}, treeOf(repo, b)).keys()].map((filename) => ({ filename })) });
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
    if ((m = /^\/commits\/([0-9a-f]{40})\/pulls$/.exec(rest))) {
      return json(pulls.filter((x) => x.merge_commit_sha === m[1] || S.branches.get(bkey(repo, x.head)) === m[1]).map((x) => prJson(repo, x)));
    }
    if (/^\/commits\/[^/]+\/status$/.test(rest)) return json({ state: "success", statuses: [] });
    return json({ message: "Not Found" }, 404);
  },
};
