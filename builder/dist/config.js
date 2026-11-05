/** Builder の設定。トークンは別のファイルに置き、他の利用者が読める状態なら起動しない */
import { readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
export const SUPPORTED_OS = ["android", "ios", "macos", "linux"];
export async function loadConfig(path = process.env.UPBEATER_BUILDER_CONFIG ?? join(homedir(), ".upbeater", "builder.json")) {
    let raw;
    try {
        raw = JSON.parse(await readFile(path, "utf8"));
    }
    catch {
        throw new Error(`設定ファイルを読めません：${path}`);
    }
    const hubUrl = typeof raw.hub_url === "string" ? raw.hub_url : "";
    if (!/^https:\/\/|^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?/.test(hubUrl))
        throw new Error("hub_url は https の URL で指定してください");
    const os = Array.isArray(raw.os) ? raw.os.filter((x) => SUPPORTED_OS.includes(x)) : [];
    if (os.length === 0)
        throw new Error(`os にビルドできる OS を指定してください（${SUPPORTED_OS.join(" / ")}）`);
    const tokenFile = typeof raw.token_file === "string" ? raw.token_file : join(homedir(), ".upbeater", "builder.token");
    const st = await stat(tokenFile).catch(() => null);
    if (!st)
        throw new Error(`トークンのファイルがありません：${tokenFile}`);
    if ((st.mode & 0o077) !== 0)
        throw new Error(`トークンのファイルを他の利用者が読めます。chmod 600 ${tokenFile} を実行してください`);
    const token = (await readFile(tokenFile, "utf8")).trim();
    if (!token.startsWith("upb_b_"))
        throw new Error("トークンの形式が正しくありません（MCP の create_builder で発行したもの）");
    return {
        hubUrl,
        token,
        workRoot: typeof raw.work_root === "string" ? raw.work_root : join(homedir(), ".upbeater", "work"),
        os,
        pollMs: Math.max(5, typeof raw.poll_seconds === "number" ? raw.poll_seconds : 20) * 1000,
    };
}
