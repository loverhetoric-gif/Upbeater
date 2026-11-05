/** 外部コマンドの実行。プロセスグループごと止められるようにし、中断・時間切れで子プロセスを残さない */
import { spawn } from "node:child_process";
export function run(command, args, opts) {
    return new Promise((resolve) => {
        if (opts.signal?.aborted)
            return resolve({ code: null, signal: null, timedOut: false, aborted: true });
        const child = spawn(command, args, { cwd: opts.cwd, env: opts.env, detached: true, stdio: ["ignore", "pipe", "pipe"] });
        let timedOut = false;
        let aborted = false;
        let killTimer;
        const stop = () => {
            if (child.pid === undefined || child.exitCode !== null)
                return;
            try {
                process.kill(-child.pid, "SIGTERM");
            }
            catch {
                /* 既に終了している */
            }
            killTimer = setTimeout(() => {
                try {
                    if (child.pid !== undefined)
                        process.kill(-child.pid, "SIGKILL");
                }
                catch {
                    /* 既に終了している */
                }
            }, 5000);
        };
        const timer = setTimeout(() => {
            timedOut = true;
            stop();
        }, opts.timeoutMs);
        const onAbort = () => {
            aborted = true;
            stop();
        };
        opts.signal?.addEventListener("abort", onAbort, { once: true });
        child.stdout.setEncoding("utf8").on("data", (d) => opts.onOutput?.(d));
        child.stderr.setEncoding("utf8").on("data", (d) => opts.onOutput?.(d));
        child.on("error", (e) => opts.onOutput?.(`起動できません：${e.message}\n`));
        child.on("close", (code, signal) => {
            clearTimeout(timer);
            if (killTimer)
                clearTimeout(killTimer);
            opts.signal?.removeEventListener("abort", onAbort);
            resolve({ code, signal, timedOut, aborted });
        });
    });
}
/** 道具が使えるか（PATH 上にあるか） */
export async function hasTool(name, env) {
    if (!/^[A-Za-z0-9._+-]+$/.test(name))
        return false;
    const r = await run("/bin/sh", ["-c", `command -v "$1" >/dev/null 2>&1`, "sh", name], { cwd: "/", env, timeoutMs: 10_000 });
    return r.code === 0;
}
