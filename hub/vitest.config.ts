import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-pool-workers";
import { readFileSync } from "node:fs";
import { webcrypto } from "node:crypto";
import { defineConfig } from "vitest/config";

/** テストのたびに使い捨ての Ed25519 鍵を作る（実際の秘密鍵はリポジトリに置かない） */
async function testKey(gen: number) {
  const pair = (await webcrypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"])) as webcrypto.CryptoKeyPair;
  return { gen, jwk: await webcrypto.subtle.exportKey("jwk", pair.privateKey) };
}

export default defineConfig(async () => {
  const migrations = await readD1Migrations("./migrations");
  const keys = [await testKey(1), await testKey(2), await testKey(3)];
  return {
    plugins: [
      cloudflareTest({
        wrangler: { configPath: "./wrangler.jsonc" },
        miniflare: {
          bindings: {
            TEST_MIGRATIONS: migrations,
            // 以下はテスト専用の使い捨ての値
            WEBHOOK_SECRET: "test-webhook-secret",
            DOWNLOAD_TOKEN_SECRET: "test-download-secret",
            ADMIN_TOKEN: "test-admin-token",
            GITHUB_API_BASE: "https://github-mock.test",
            MANIFEST_SIGNING_KEYS: JSON.stringify({ active: 2, keys: keys.slice(0, 2) }),
            TEST_ALL_SIGNING_KEYS: JSON.stringify(keys),
          },
          serviceBindings: { GITHUB_API: "github-mock" },
          workers: [
            {
              name: "github-mock",
              modules: true,
              script: readFileSync("./test/github-mock.js", "utf8"),
              compatibilityDate: "2026-08-01",
            },
          ],
        },
      }),
    ],
    test: {
      setupFiles: ["./test/setup.ts"],
    },
  };
});
