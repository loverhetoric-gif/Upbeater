import { applyD1Migrations, env, reset } from "cloudflare:test";
import { afterEach, beforeEach } from "vitest";

beforeEach(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
  await env.GITHUB_API!.fetch("https://github-mock.test/__mock/reset", { method: "POST" });
});

afterEach(async () => {
  await reset();
});
