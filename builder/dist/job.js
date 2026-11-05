/**
 * 1 件のビルド指示の実行
 * 点検 → 取得（git fetch）→ コミットの照合 → ビルド → 成果物の確認 → SHA-256 → 提出
 *
 * - 作業場所は指示ごとに使い捨て。成功・失敗・中断のどれでも必ず消す
 * - 完了し検証を通った成果物だけを上げる。中途半端な成果物は絶対に上げない
 * - 取得用のトークンは git の取得にだけ渡す。ビルド手順（リポジトリのコード）の環境には渡さない
 * - アプリ固有の処理は持たない。手順はすべて Hub から受け取る
 */
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, mkdir, mkdtemp, realpath, rm, stat } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { pipeline } from "node:stream/promises";
import { HubUnavailable } from "./hub.js";
import { hasTool, run } from "./process.js";
import { Redactor, TailBuffer } from "./redact.js";
class StageError extends Error {
    stage;
    retryable;
    constructor(stage, message, retryable) {
        super(message);
        this.stage = stage;
        this.retryable = retryable;
    }
}
/** ビルド手順に渡す環境。Builder 自身の設定・取得用の資格情報は渡さない */
function buildEnv(job) {
    const env = {};
    for (const [k, v] of Object.entries(process.env)) {
        if (k.startsWith("UPBEATER_") || k.startsWith("GIT_CONFIG"))
            continue;
        env[k] = v;
    }
    env.UPBEATER_APP_ID = job.app_id;
    env.UPBEATER_SEQ = String(job.seq);
    env.UPBEATER_COMMIT = job.commit_sha;
    env.UPBEATER_OS = job.os;
    env.CI = "true";
    return env;
}
async function sha256File(file) {
    const h = createHash("sha256");
    await pipeline(createReadStream(file), h);
    return h.digest("hex");
}
/** 成果物のパスが作業場所の中にあることを確かめる（../ やシンボリックリンクでの逸脱を拒否） */
async function resolveInside(root, rel) {
    if (isAbsolute(rel))
        throw new StageError("artifact", `成果物のパスは相対パスで指定してください：${rel}`, false);
    const target = resolve(root, rel);
    let real;
    try {
        real = await realpath(target);
    }
    catch {
        throw new StageError("artifact", `成果物が見つかりません：${rel}`, false);
    }
    const realRoot = await realpath(root);
    const r = relative(realRoot, real);
    if (r.startsWith("..") || isAbsolute(r))
        throw new StageError("artifact", `成果物が作業場所の外を指しています：${rel}`, false);
    return real;
}
export async function runJob(claimed, deps) {
    const { job, source, steps } = claimed;
    const log = deps.log ?? (() => undefined);
    const redactor = new Redactor();
    redactor.add(source.auth_header);
    if (source.auth_header)
        redactor.add(source.auth_header.replace(/^Authorization:\s*Basic\s+/i, ""));
    const tail = new TailBuffer();
    const output = (chunk) => tail.append(chunk);
    const cancel = new AbortController(); // Hub が取り消した
    const abort = new AbortController(); // 取り消し・停止のどちらでも止める
    const onShutdown = () => abort.abort();
    deps.shutdown?.addEventListener("abort", onShutdown, { once: true });
    let stage = "preflight";
    const heartbeat = setInterval(() => {
        deps.hub
            .heartbeat(job.id, stage)
            .then((ok) => {
            if (!ok) {
                cancel.abort();
                abort.abort();
            }
        })
            .catch(() => undefined); // Hub に一時的に届かなくても続ける（期限内に戻れば問題ない）
    }, deps.heartbeatMs ?? 30_000);
    const timeoutMs = Math.min(steps.timeout_minutes * 60_000, deps.timeoutCapMs ?? Infinity);
    const deadline = Date.now() + timeoutMs;
    const remaining = () => Math.max(1, deadline - Date.now());
    let jobRoot = null;
    const check = (r, st, what, retryable) => {
        if (r.aborted)
            throw new StageError("interrupted", "中断しました", true);
        if (r.timedOut)
            throw new StageError(st, `時間切れです（${Math.round(timeoutMs / 60_000) || 1} 分）：${what}`, false);
        if (r.code !== 0)
            throw new StageError(st, `${what} が失敗しました（終了コード ${r.code}）`, retryable);
    };
    try {
        // 1. 点検：必要な道具を開始前に確かめ、足りないものを具体的に報告する
        const required = [...new Set(["git", "tar", ...steps.requires])];
        const missing = [];
        for (const t of required)
            if (!(await hasTool(t, process.env)))
                missing.push(t);
        if (missing.length)
            throw new StageError("preflight", `必要な道具がありません：${missing.join(", ")}`, false);
        // 2. 作業場所（使い捨て）
        await mkdir(deps.workRoot, { recursive: true });
        jobRoot = await mkdtemp(join(deps.workRoot, "job-"));
        const src = join(jobRoot, "src");
        const out = join(jobRoot, "out");
        await mkdir(src);
        await mkdir(out);
        // 3. 取得：指示されたコミットだけを取る。資格情報は環境変数で git にだけ渡す（コマンドラインに出さない）
        stage = "fetch";
        log(`取得：${job.app_name} 通番 ${job.seq}（${job.commit_sha.slice(0, 12)}）`);
        const gitEnv = { PATH: process.env.PATH, HOME: process.env.HOME, GIT_TERMINAL_PROMPT: "0", LANG: "C" };
        if (source.auth_header) {
            gitEnv.GIT_CONFIG_COUNT = "1";
            gitEnv.GIT_CONFIG_KEY_0 = "http.extraHeader";
            gitEnv.GIT_CONFIG_VALUE_0 = source.auth_header;
        }
        const git = (args) => run("git", args, { cwd: src, env: gitEnv, timeoutMs: remaining(), signal: abort.signal, onOutput: output });
        check(await git(["init", "-q"]), "fetch", "git init", false);
        check(await git(["fetch", "--depth", "1", "--no-tags", "-q", source.clone_url, job.commit_sha]), "fetch", "git fetch", true);
        check(await git(["checkout", "-q", "--detach", "FETCH_HEAD"]), "fetch", "git checkout", false);
        let head = "";
        const rp = await run("git", ["rev-parse", "HEAD"], { cwd: src, env: gitEnv, timeoutMs: 30_000, onOutput: (d) => (head += d) });
        if (rp.code !== 0 || head.trim() !== job.commit_sha)
            throw new StageError("fetch", "取得したコミットが指示と一致しません", false);
        // 4. ビルド：手順を順に実行する
        stage = "build";
        const env = buildEnv(job);
        for (const cmd of steps.build) {
            log(`実行：${redactor.redact(cmd)}`);
            output(`$ ${cmd}\n`);
            const r = await run("/bin/sh", ["-c", cmd], { cwd: src, env, timeoutMs: remaining(), signal: abort.signal, onOutput: output });
            check(r, "build", `「${cmd.length > 80 ? cmd.slice(0, 80) + "…" : cmd}」`, false);
        }
        // 5. 成果物：作業場所の中にあることを確かめ、フォルダなら tar.gz にまとめる
        stage = "artifact";
        const target = await resolveInside(src, steps.artifact);
        let file = target;
        const info = await lstat(target);
        if (info.isDirectory()) {
            file = join(out, "artifact.tar.gz");
            const args = target === (await realpath(src)) ? ["-czf", file, "--exclude=.git", "-C", target, "."] : ["-czf", file, "-C", dirname(target), basename(target)];
            check(await run("tar", args, { cwd: src, env: gitEnv, timeoutMs: remaining(), signal: abort.signal, onOutput: output }), "artifact", "tar", false);
        }
        else if (!info.isFile()) {
            throw new StageError("artifact", `成果物が通常のファイルではありません：${steps.artifact}`, false);
        }
        const size = (await stat(file)).size;
        if (size === 0)
            throw new StageError("artifact", `成果物が空です：${steps.artifact}`, false);
        const sha = await sha256File(file);
        if (abort.signal.aborted)
            throw new StageError("interrupted", "中断しました", true);
        // 6. 提出：Hub が SHA-256 を照合し、一致したものだけを配信対象にする
        stage = "upload";
        log(`提出：${size} バイト、SHA-256 ${sha.slice(0, 16)}…`);
        try {
            await deps.hub.upload(job.id, file, sha, size);
        }
        catch (e) {
            throw new StageError("upload", redactor.redact(e instanceof Error ? e.message : "提出に失敗しました"), true);
        }
        log("完了");
        return "succeeded";
    }
    catch (e) {
        if (cancel.signal.aborted) {
            log("Hub が指示を取り消したため中断しました");
            return "cancelled"; // 取り消し済みの指示には報告しない
        }
        const err = e instanceof StageError
            ? e
            : new StageError(stage === "preflight" ? "preflight" : stage, e instanceof Error ? e.message : "想定外の失敗", true);
        const interrupted = err.stage === "interrupted" || Boolean(deps.shutdown?.aborted);
        log(`失敗（${err.stage}）：${redactor.redact(err.message)}`);
        try {
            await deps.hub.fail(job.id, {
                stage: interrupted ? "interrupted" : err.stage,
                reason: redactor.redact(err.message),
                log_tail: tail.read(redactor),
                retryable: interrupted || err.retryable,
            });
        }
        catch (re) {
            if (!(re instanceof HubUnavailable))
                throw re;
            // Hub に届かなくても、期限切れで待ち行列に戻る
        }
        return interrupted ? "interrupted" : "failed";
    }
    finally {
        clearInterval(heartbeat);
        deps.shutdown?.removeEventListener("abort", onShutdown);
        if (jobRoot)
            await rm(jobRoot, { recursive: true, force: true });
    }
}
