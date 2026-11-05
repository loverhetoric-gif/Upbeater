// テスト用の模擬 GitHub（別の Worker として起動し、GITHUB_API に束縛する）
// 制御用の経路は /__mock/ で始まる
let S;
function reset() {
  S = {
    branches: new Map(), // "repo#branch" → sha
    files: new Map(), // "repo@sha" → { path: text }
    failures: [], // { status, headers, path, method }
    app: null,
    tokens: new Set(),
    uninstalled: new Set(),
    checks: [], // { id, repo, created: payload, updates: [payload] }
    statuses: [], // { repo, sha, ...payload }
    nextCheck: 1,
    calls: { head: 0, contents: 0, checks: 0 },
  };
}
reset();

const json = (v, status = 200, headers = {}) => new Response(JSON.stringify(v), { status, headers: { "content-type": "application/json", ...headers } });
const b64u = (s) => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4)), (c) => c.charCodeAt(0));

async function verifyJwt(auth) {
  if (!S.app) return true;
  const m = /^Bearer (.+)\.(.+)\.(.+)$/.exec(auth ?? "");
  if (!m) return false;
  const key = await crypto.subtle.importKey("jwk", S.app.publicJwk, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]);
  if (!(await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, b64u(m[3]), new TextEncoder().encode(`${m[1]}.${m[2]}`)))) return false;
  const body = JSON.parse(new TextDecoder().decode(b64u(m[2])));
  return String(body.iss) === String(S.app.appId);
}

export default {
  async fetch(req) {
    const url = new URL(req.url);
    const p = url.pathname;
    const method = req.method;
    const body = method === "GET" ? {} : await req.json().catch(() => ({}));
    if (p.startsWith("/__mock/")) {
      switch (p) {
        case "/__mock/reset": reset(); return json({ ok: true });
        case "/__mock/app": S.app = { appId: body.app_id, publicJwk: body.public_jwk }; return json({ ok: true });
        case "/__mock/commit": {
          const repo = body.repo.toLowerCase();
          if (body.branch) S.branches.set(`${repo}#${body.branch}`, body.sha);
          S.files.set(`${repo}@${body.sha}`, body.files ?? {});
          return json({ ok: true });
        }
        case "/__mock/branch":
          if (body.sha === null) S.branches.delete(`${body.repo.toLowerCase()}#${body.branch}`);
          else S.branches.set(`${body.repo.toLowerCase()}#${body.branch}`, body.sha);
          return json({ ok: true });
        case "/__mock/fail":
          for (let i = 0; i < body.count; i++) S.failures.push({ status: body.status, headers: body.headers ?? {}, path: body.path, method: body.method });
          return json({ ok: true });
        case "/__mock/checks": return json(S.checks.filter((c) => !body.repo || c.repo === body.repo.toLowerCase()));
        case "/__mock/calls": return json(S.calls);
        case "/__mock/statuses": return json(S.statuses.filter((c) => !body.repo || c.repo === body.repo.toLowerCase()));
        case "/__mock/uninstall": S.uninstalled.add(body.repo.toLowerCase()); return json({ ok: true });
      }
      return json({ error: "unknown" }, 404);
    }
    const fi = S.failures.findIndex((f) => (!f.path || p.includes(f.path)) && (!f.method || f.method === method));
    if (fi >= 0) {
      const f = S.failures.splice(fi, 1)[0];
      return json({ message: "simulated failure" }, f.status, f.headers);
    }
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
    if ((m = /^\/git\/ref\/heads\/(.+)$/.exec(rest))) {
      S.calls.head++;
      const sha = S.branches.get(`${repo}#${m[1].split("/").map(decodeURIComponent).join("/")}`);
      return sha ? json({ object: { sha } }) : json({ message: "Not Found" }, 404);
    }
    if ((m = /^\/contents\/(.+)$/.exec(rest))) {
      S.calls.contents++;
      const path = m[1].split("/").map(decodeURIComponent).join("/");
      const files = S.files.get(`${repo}@${url.searchParams.get("ref")}`);
      if (!files) return json({ message: "No commit found" }, 404);
      if (path === ".upbeater") {
        const list = Object.keys(files).filter((f) => f.startsWith(".upbeater/") && !f.slice(10).includes("/"));
        return list.length ? json(list.map((f) => ({ type: "file", name: f.slice(10), path: f }))) : json({ message: "Not Found" }, 404);
      }
      return path in files ? new Response(files[path]) : json({ message: "Not Found" }, 404);
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
    return json({ message: "Not Found" }, 404);
  },
};
