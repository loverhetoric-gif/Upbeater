import { applyD1Migrations, env, reset } from "cloudflare:test";
import { afterEach, beforeEach } from "vitest";

beforeEach(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
  await env.GITHUB_API!.fetch("https://github-mock.test/__mock/reset", { method: "POST" });
  // 模擬 GitHub に GitHub App の公開鍵を教え、JWT とインストールトークンを検証させる
  await env.GITHUB_API!.fetch("https://github-mock.test/__mock/app", {
    method: "POST",
    body: JSON.stringify({ app_id: env.GITHUB_APP_ID, public_jwk: JSON.parse(env.TEST_APP_PUBLIC_JWK) }),
  });
});

afterEach(async () => {
  await reset();
});
