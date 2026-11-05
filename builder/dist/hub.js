/** Hub との通信 */
import { createReadStream } from "node:fs";
import { Readable } from "node:stream";
/** Hub に届かない・Hub が一時的に応答できない */
export class HubUnavailable extends Error {
    retryAfterMs;
    constructor(message, retryAfterMs) {
        super(message);
        this.retryAfterMs = retryAfterMs;
    }
}
export class HubClient {
    baseUrl;
    token;
    fetchImpl;
    constructor(baseUrl, token, fetchImpl = fetch) {
        this.baseUrl = baseUrl;
        this.token = token;
        this.fetchImpl = fetchImpl;
    }
    async send(path, init) {
        let res;
        try {
            res = await this.fetchImpl(this.baseUrl.replace(/\/$/, "") + path, {
                ...init,
                headers: { authorization: `Bearer ${this.token}`, "user-agent": "upbeater-builder", ...init.headers },
            });
        }
        catch {
            throw new HubUnavailable("Hub に接続できません");
        }
        if (res.status >= 500 || res.status === 429) {
            const ra = Number(res.headers.get("retry-after"));
            await res.body?.cancel();
            throw new HubUnavailable(`Hub が応答できません（${res.status}）`, Number.isFinite(ra) && ra > 0 ? ra * 1000 : undefined);
        }
        if (res.status === 401) {
            await res.body?.cancel();
            throw new Error("Builder のトークンが無効です。MCP の create_builder で発行し直してください");
        }
        return res;
    }
    json(path, body) {
        return this.send(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    }
    /** 次の指示。無ければ null */
    async claim(os) {
        const res = await this.json("/v1/builder/claim", { os });
        if (res.status === 204 || res.status === 409) {
            await res.body?.cancel();
            return null;
        }
        if (!res.ok)
            throw new HubUnavailable(`指示を受け取れません（${res.status}）`);
        return (await res.json());
    }
    /** 続けてよいか（取り消されていれば false） */
    async heartbeat(id, stage) {
        const res = await this.json(`/v1/builder/jobs/${id}/heartbeat`, { stage });
        if (res.status === 404)
            return false;
        const b = (await res.json());
        return b.continue === true;
    }
    async upload(id, file, sha256, size) {
        const res = await this.send(`/v1/builder/jobs/${id}/artifact`, {
            method: "PUT",
            headers: { "content-type": "application/octet-stream", "content-length": String(size), "x-upbeater-sha256": sha256 },
            body: Readable.toWeb(createReadStream(file)),
            duplex: "half",
        });
        if (res.status !== 201) {
            const text = await res.text().catch(() => "");
            throw new Error(`成果物を受け付けられませんでした（${res.status}）：${text.slice(0, 300)}`);
        }
        await res.body?.cancel();
    }
    async fail(id, report) {
        const res = await this.json(`/v1/builder/jobs/${id}/fail`, report);
        await res.body?.cancel();
    }
}
