/** ログに紛れた秘密情報を伏せる。Hub に送る前・画面に出す前に必ず通す */
const PATTERNS = [
    /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
    /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g,
    /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g,
    /\bupb_[a-z]{1,2}_[A-Za-z0-9_-]{10,}/g,
    /x-access-token:[^@\s]+/g,
    /\b(Basic|Bearer)\s+[A-Za-z0-9+/=._-]{16,}/g,
];
export class Redactor {
    secrets = new Set();
    /** 形に関係なく伏せたい値（取得用トークンなど）を加える */
    add(secret) {
        if (secret && secret.length >= 6)
            this.secrets.add(secret);
    }
    redact(text) {
        let out = text;
        for (const s of this.secrets)
            out = out.split(s).join("[伏せ字]");
        for (const re of PATTERNS)
            out = out.replace(re, "[伏せ字]");
        return out;
    }
}
/** 末尾だけを残すログ（大きなビルドでも記憶を使い過ぎない） */
export class TailBuffer {
    max;
    text = "";
    constructor(max = 16 * 1024) {
        this.max = max;
    }
    append(chunk) {
        this.text += chunk;
        if (this.text.length > this.max * 2)
            this.text = this.text.slice(-this.max);
    }
    read(redactor) {
        return redactor.redact(this.text).slice(-this.max);
    }
}
