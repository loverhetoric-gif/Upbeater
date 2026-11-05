#!/usr/bin/env node
/** Upbeater Builder の起動（launchd から起動する） */
import { Builder } from "./builder.js";
import { loadConfig } from "./config.js";
import { HubClient } from "./hub.js";
const log = (line) => console.log(`${new Date().toISOString()} ${line}`);
async function main() {
    const cfg = await loadConfig(process.argv[2]);
    const shutdown = new AbortController();
    for (const sig of ["SIGTERM", "SIGINT"]) {
        process.on(sig, () => {
            log(`${sig} を受け取りました。実行中のビルドを中断して停止します`);
            shutdown.abort();
        });
    }
    log(`起動：Hub ${cfg.hubUrl}、ビルドできる OS ${cfg.os.join(", ")}`);
    await new Builder({ hub: new HubClient(cfg.hubUrl, cfg.token), workRoot: cfg.workRoot, os: cfg.os, pollMs: cfg.pollMs, log }).loop(shutdown.signal);
    log("停止しました");
}
main().catch((e) => {
    log(`起動できません：${e instanceof Error ? e.message : String(e)}`);
    process.exit(1);
});
