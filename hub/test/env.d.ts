import type { D1Migration } from "@cloudflare/vitest-pool-workers";
import type { Env as HubEnv } from "../src/env";

declare global {
  namespace Cloudflare {
    interface Env extends HubEnv {
      TEST_MIGRATIONS: D1Migration[];
      TEST_ALL_SIGNING_KEYS: string;
      TEST_APP_PUBLIC_JWK: string;
    }
  }
}
export {};
