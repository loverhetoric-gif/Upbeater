import { env, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { resolveSecrets } from "../src/secrets";
import { handleSecretForm } from "../src/routes/secret-form";
import { admin, OWNER, REPO, registerRepo } from "./helpers";

async function issue(names: unknown, repo: string | null = REPO) {
  const r = await admin("POST", "/v1/admin/secret-forms", { owner_id: OWNER, names, ...(repo ? { repo } : {}) });
  return { status: r.status, body: (await r.json()) as { url: string; names: string[] } };
}
const post = (url: string, fields: Record<string, string>) => SELF.fetch(url, { method: "POST", body: new URLSearchParams(fields) });

describe("秘密情報の入力ページ", () => {
  it("発行には管理用トークンが要る", async () => {
    const r = await SELF.fetch("https://hub.test/v1/admin/secret-forms", { method: "POST", body: JSON.stringify({ owner_id: OWNER, names: ["A"] }) });
    expect(r.status).toBe(401);
  });

  it("伏せ字の欄を出し、入れた分だけ暗号化して保存し、一度送ったら使えない", async () => {
    const repoId = await registerRepo();
    await admin("PUT", "/v1/admin/secrets", { owner_id: OWNER, repo: REPO, name: "OLD_ONE", value: "前の値-1234567890" });
    const { status, body } = await issue(["CLOUDFLARE_API_TOKEN", "OLD_ONE", "EMPTY_ONE"]);
    expect(status).toBe(201);
    expect(body.url).toMatch(/^https:\/\/hub\.test\/secret-form\/[A-Za-z0-9_-]{43}$/);

    const g = await SELF.fetch(body.url);
    expect(g.status).toBe(200);
    expect(g.headers.get("cache-control")).toBe("no-store");
    expect(g.headers.get("content-security-policy")).toMatch(/default-src 'none'/);
    expect(g.headers.get("referrer-policy")).toBe("no-referrer");
    const html = await g.text();
    expect(html).toContain('type="password" id="CLOUDFLARE_API_TOKEN"');
    expect(html).toMatch(/OLD_ONE<span class="state set">登録済み/);
    expect(html).not.toContain("前の値"); // 登録済みの値は出さない
    expect(html).not.toMatch(/<script/i);

    const p = await post(body.url, { CLOUDFLARE_API_TOKEN: "  cf-新しい値-abcdef\n", EMPTY_ONE: "", NOT_ALLOWED: "x" });
    expect(p.status).toBe(200);
    const done = await p.text();
    expect(done).toContain("<li>CLOUDFLARE_API_TOKEN</li>");
    expect(done).not.toContain("cf-新しい値");
    const got = await resolveSecrets(env, OWNER, repoId, ["CLOUDFLARE_API_TOKEN", "OLD_ONE", "EMPTY_ONE", "NOT_ALLOWED"]);
    expect(got).toEqual({ CLOUDFLARE_API_TOKEN: "cf-新しい値-abcdef", OLD_ONE: "前の値-1234567890" }); // 前後の空白は落とす・決めた名前だけ
    // 保存されているのは暗号文
    const raw = await env.DB.prepare("SELECT ciphertext FROM secrets WHERE name = 'CLOUDFLARE_API_TOKEN'").first<{ ciphertext: string }>();
    expect(raw!.ciphertext).not.toContain("cf-");
    // 二度目は使えない
    expect((await SELF.fetch(body.url)).status).toBe(410);
    expect((await post(body.url, { CLOUDFLARE_API_TOKEN: "上書き" })).status).toBe(410);
    expect((await resolveSecrets(env, OWNER, repoId, ["CLOUDFLARE_API_TOKEN"])).CLOUDFLARE_API_TOKEN).toBe("cf-新しい値-abcdef");
  });

  it("期限は無い。新しいページを出すと前のページは使えない。知らない鍵・形の違う鍵も使えない", async () => {
    await registerRepo();
    const { body } = await issue(["A_KEY"]);
    const token = body.url.split("/").pop()!;
    // 1 年後でも開ける
    expect((await handleSecretForm(new Request(body.url), env, token, Date.now() + 365 * 24 * 60 * 60_000)).status).toBe(200);
    const next = await issue(["A_KEY"]);
    expect((await SELF.fetch(body.url)).status).toBe(410);
    expect((await SELF.fetch(next.body.url)).status).toBe(200);
    expect((await SELF.fetch(`https://hub.test/secret-form/${"x".repeat(43)}`)).status).toBe(410);
    expect((await SELF.fetch("https://hub.test/secret-form/short")).status).toBe(410);
  });

  it("名前の形・数を確かめる", async () => {
    await registerRepo();
    expect((await issue(["lower"])).status).toBe(400);
    expect((await issue([])).status).toBe(400);
    expect((await issue(["A"], "acme/missing")).status).toBe(404);
    expect((await issue(["SHARED"], null)).status).toBe(201); // 全リポジトリ共通
  });
});
