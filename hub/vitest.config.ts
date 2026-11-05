import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-pool-workers";
import { readFileSync } from "node:fs";
import { generateKeyPairSync, webcrypto } from "node:crypto";
import { defineConfig } from "vitest/config";

/** テストのたびに使い捨ての Ed25519 鍵を作る（実際の秘密鍵はリポジトリに置かない） */
async function testKey(gen: number) {
  const pair = (await webcrypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"])) as webcrypto.CryptoKeyPair;
  return { gen, jwk: await webcrypto.subtle.exportKey("jwk", pair.privateKey) };
}

export default defineConfig(async () => {
  const migrations = await readD1Migrations("./migrations");
  const keys = [await testKey(1), await testKey(2), await testKey(3)];
  // GitHub App の秘密鍵も使い捨て。GitHub が配る形式（PKCS#1）で渡し、変換も確かめる
  const app = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    privateKeyEncoding: { type: "pkcs1", format: "pem" },
    publicKeyEncoding: { type: "spki", format: "jwk" as never },
  }) as unknown as { privateKey: string; publicKey: JsonWebKey };
  // クラウド Runner 用のサービスアカウントの鍵も使い捨て
  const sa = generateKeyPairSync("rsa", { modulusLength: 2048, privateKeyEncoding: { type: "pkcs8", format: "pem" }, publicKeyEncoding: { type: "spki", format: "pem" } });
  return {
    plugins: [
      cloudflareTest({
        wrangler: { configPath: "./wrangler.jsonc" },
        miniflare: {
          bindings: {
            TEST_MIGRATIONS: migrations,
            // 以下はテスト専用の使い捨ての値
            WEBHOOK_SECRET: "test-webhook-secret",
            SECRETS_KEY: Buffer.from(webcrypto.getRandomValues(new Uint8Array(32))).toString("base64"),
            ADMIN_TOKEN: "test-admin-token",
            GITHUB_API_BASE: "https://github-mock.test",
            MANIFEST_SIGNING_KEYS: JSON.stringify({ active: 2, keys: keys.slice(0, 2) }),
            TEST_ALL_SIGNING_KEYS: JSON.stringify(keys),
            GITHUB_APP_ID: "12345",
            GITHUB_APP_PRIVATE_KEY: app.privateKey,
            TEST_APP_PUBLIC_JWK: JSON.stringify(app.publicKey),
            GITHUB_WEB_BASE: "https://github-mock.test",
            GITHUB_APP_CLIENT_ID: "Iv1.test-client",
            GITHUB_APP_CLIENT_SECRET: "test-github-client-secret",
            ALLOWED_GITHUB_USERS: "allowed-user,424242",
            GITHUB_POLL_MS: "5",
            GCP_PROJECT: "test-project",
            GCP_REGION: "asia-northeast1",
            CLOUD_RUN_JOB: "upbeater-runner",
            GCP_SERVICE_ACCOUNT_KEY: JSON.stringify({ client_email: "runner@test-project.iam.gserviceaccount.com", private_key: sa.privateKey }),
            GCP_TOKEN_URL: "https://github-mock.test/__gcp/token",
            GCP_RUN_BASE: "https://github-mock.test/__gcp/run",
          },
          serviceBindings: { GITHUB_API: "github-mock", GCP_API: "github-mock" },
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
