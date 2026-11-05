// テスト用の模擬 GitHub API（別の Worker として起動し、GITHUB_API に束縛する）
// 制御用：POST /__mock/reset, /__mock/branch {repo, branch, sha}, /__mock/fail {count, status, headers}, /__mock/delay {ms}
//         GET /__mock/calls
let branches = new Map();
let failures = [];
let delayMs = 0;
let calls = 0;

const json = (v, status = 200, headers = {}) =>
  new Response(JSON.stringify(v), { status, headers: { "content-type": "application/json", ...headers } });

export default {
  async fetch(req) {
    const url = new URL(req.url);
    const p = url.pathname;
    if (p.startsWith("/__mock/")) {
      const body = req.method === "POST" ? await req.json().catch(() => ({})) : {};
      if (p === "/__mock/reset") { branches = new Map(); failures = []; delayMs = 0; calls = 0; return json({ ok: true }); }
      if (p === "/__mock/branch") {
        const key = `${body.repo.toLowerCase()}#${body.branch}`;
        if (body.sha === null) branches.delete(key); else branches.set(key, body.sha);
        return json({ ok: true });
      }
      if (p === "/__mock/fail") { for (let i = 0; i < body.count; i++) failures.push({ status: body.status, headers: body.headers ?? {} }); return json({ ok: true }); }
      if (p === "/__mock/delay") { delayMs = body.ms; return json({ ok: true }); }
      if (p === "/__mock/calls") return json({ calls });
      return json({ error: "unknown" }, 404);
    }
    calls++;
    if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
    const f = failures.shift();
    if (f) return json({ message: "simulated failure" }, f.status, f.headers);
    const m = /^\/repos\/([^/]+)\/([^/]+)\/git\/ref\/heads\/(.+)$/.exec(p);
    if (!m) return json({ message: "Not Found" }, 404);
    const key = `${decodeURIComponent(m[1])}/${decodeURIComponent(m[2])}`.toLowerCase() + "#" + m[3].split("/").map(decodeURIComponent).join("/");
    const sha = branches.get(key);
    if (!sha) return json({ message: "Not Found" }, 404);
    return json({ ref: `refs/heads/${m[3]}`, object: { sha, type: "commit" } });
  },
};
