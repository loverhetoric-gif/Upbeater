/** OAuth の画面（GitHub でのログイン後の同意・エラー）。スマホ・タブレット・PC のすべてで読みやすく。JavaScript は使わない */

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

function layout(title: string, inner: string): string {
  return `<!doctype html>
<html lang="ja">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="robots" content="noindex">
<title>${esc(title)} — Upbeater</title>
<style>
:root{--bg:#f4f5f7;--card:#ffffff;--text:#16181d;--muted:#5d6472;--line:#e3e6eb;--accent:#2f5bea;--accent-text:#ffffff;--danger:#b42318;--chip:#eef1f6}
@media (prefers-color-scheme:dark){:root{--bg:#0f1115;--card:#171a21;--text:#eceef2;--muted:#a1a8b5;--line:#2a2f3a;--accent:#6c8cff;--accent-text:#0b0d12;--danger:#ff7a6b;--chip:#20242e}}
*{box-sizing:border-box}
html,body{margin:0;background:var(--bg);color:var(--text);font:16px/1.65 -apple-system,BlinkMacSystemFont,"Hiragino Sans","Noto Sans JP","Segoe UI",sans-serif;-webkit-text-size-adjust:100%}
main{min-height:100dvh;display:grid;place-items:center;padding:max(24px,env(safe-area-inset-top)) 16px max(24px,env(safe-area-inset-bottom))}
.card{width:100%;max-width:460px;background:var(--card);border:1px solid var(--line);border-radius:20px;padding:32px 28px;box-shadow:0 1px 2px rgba(0,0,0,.04),0 12px 32px rgba(0,0,0,.06)}
.brand{display:flex;align-items:center;gap:10px;font-weight:650;letter-spacing:.02em;color:var(--muted);font-size:14px}
.mark{width:28px;height:28px;border-radius:8px;background:var(--accent);display:grid;place-items:center;color:var(--accent-text);font-weight:800;font-size:15px}
h1{font-size:22px;line-height:1.4;margin:20px 0 8px;font-weight:700;text-wrap:balance}
h1,p,li{word-break:auto-phrase;line-break:strict}
p{margin:0 0 16px;color:var(--muted)}
dl{margin:20px 0 24px;display:grid;gap:12px}
dl div{background:var(--chip);border-radius:12px;padding:12px 14px}
dt{font-size:12px;color:var(--muted);margin-bottom:2px}
dd{margin:0;font-weight:600;word-break:break-all}
ul{margin:0 0 24px;padding-left:1.2em;color:var(--text)}
li{margin:4px 0}
.actions{display:grid;grid-template-columns:1fr 1fr;gap:12px}
button{appearance:none;border:1px solid var(--line);border-radius:12px;padding:14px 16px;font:inherit;font-weight:650;cursor:pointer;background:transparent;color:var(--text);min-height:48px}
button.primary{background:var(--accent);border-color:var(--accent);color:var(--accent-text)}
button:focus-visible{outline:3px solid var(--accent);outline-offset:2px}
.error{color:var(--danger)}
@media (min-width:768px){.card{padding:40px 40px}h1{font-size:24px}}
@media (max-width:360px){.actions{grid-template-columns:1fr}}
</style>
</head>
<body><main><div class="card"><div class="brand"><span class="mark" aria-hidden="true">U</span>Upbeater</div>${inner}</div></main></body>
</html>`;
}

export function consentPage(p: { clientName: string; redirectHost: string; login: string; requestId: string; csrf: string }): string {
  return layout(
    "接続の確認",
    `<h1>Upbeater への接続を<wbr>許可しますか</h1>
<p>許可すると、次のアプリが Upbeater を操作できるようになります。</p>
<dl>
<div><dt>接続するアプリ</dt><dd>${esc(p.clientName)}</dd></div>
<div><dt>戻り先</dt><dd>${esc(p.redirectHost)}</dd></div>
<div><dt>GitHub アカウント</dt><dd>${esc(p.login)}</dd></div>
</dl>
<ul>
<li>登録したリポジトリの実行・Runner・操作の記録の参照</li>
<li>手動実行・再実行・取り消し・一時停止</li>
<li>登録したリポジトリでのブランチ作成・コミット・PR・マージ</li>
<li>秘密情報の名前の参照と、入力ページの発行（値は見えません）</li>
</ul>
<form method="post" action="/oauth/consent">
<input type="hidden" name="request_id" value="${esc(p.requestId)}">
<input type="hidden" name="csrf" value="${esc(p.csrf)}">
<div class="actions">
<button type="submit" name="decision" value="deny">許可しない</button>
<button type="submit" name="decision" value="approve" class="primary">許可する</button>
</div>
</form>`,
  );
}

export function errorPage(message: string): string {
  return layout("接続できません", `<h1>接続できません</h1><p class="error">${esc(message)}</p><p>接続元のアプリに戻り、最初からやり直してください。</p>`);
}

/** formAction：同意の後に戻る先（リダイレクトも form-action の制限を受けるため） */
export function htmlResponse(html: string, status = 200, headers: HeadersInit = {}, formAction = ""): Response {
  return new Response(html, {
    status,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      "content-security-policy": `default-src 'none'; style-src 'unsafe-inline'; form-action 'self'${formAction ? " " + formAction : ""}; frame-ancestors 'none'; base-uri 'none'`,
      "x-frame-options": "DENY",
      "referrer-policy": "no-referrer",
      ...headers,
    },
  });
}
