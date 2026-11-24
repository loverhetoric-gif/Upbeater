// 自動生成（tools/build-love-connect-hub.sh）。手で編集しない。元は loverhetoric-gif/love-connect-hub 2.2.0（5654bd6）の src/。
// love-connect-hub/src/lanes.ts
var SPEC_VERSION = 2;
var SPEC_VERSIONS = [1, 2];
var TASK_ID_RE = /^w-[0-9A-Za-z]{8}$/;
function versionFor(tk) {
  return tk === void 0 ? 1 : 2;
}
var KiB = 1024;
var LANES = Object.freeze({
  // 鍵：値は運ばない。置き場所の参照だけを運ぶ
  key: Object.freeze({
    delivery: "once",
    priority: 0,
    inlineMax: 0,
    deadlineMs: 2e3,
    retentionSec: 0,
    required: ["ref"],
    minClass: 3
  }),
  // ストリーミング：遅れたものは価値がないので、締め切りを短くする
  stream: Object.freeze({
    delivery: "continuous",
    priority: 1,
    inlineMax: 16 * KiB,
    deadlineMs: 1e3,
    retentionSec: 0,
    required: ["sq"],
    minClass: 0
  }),
  // 同期：元の版（bv）を添え、ぶつかったら土台がまとめる
  sync: Object.freeze({
    delivery: "bidirectional",
    priority: 2,
    inlineMax: 64 * KiB,
    deadlineMs: 3e3,
    retentionSec: 30 * 86400,
    required: ["sq", "bv"],
    minClass: 0
  }),
  // API：二重実行を防ぐため、一意の番号（id）で重複を弾く
  api: Object.freeze({
    delivery: "once",
    priority: 3,
    inlineMax: 256 * KiB,
    deadlineMs: 1e4,
    retentionSec: 7 * 86400,
    required: [],
    minClass: 0
  }),
  // AI：逐次で返るので、断片ごとに順番（sq）を付ける
  ai: Object.freeze({
    delivery: "incremental",
    priority: 4,
    inlineMax: 256 * KiB,
    deadlineMs: 12e4,
    retentionSec: 7 * 86400,
    required: [],
    minClass: 1
  }),
  // レコード：表のデータを 1 件ずつ。更新には元の版（bv）を添える
  record: Object.freeze({
    delivery: "once",
    priority: 5,
    inlineMax: 64 * KiB,
    deadlineMs: 5e3,
    retentionSec: null,
    required: [],
    minClass: 1
  }),
  // イベント：起きたことの知らせ。同じ id は一度だけ処理する
  event: Object.freeze({
    delivery: "oneway",
    priority: 6,
    inlineMax: 16 * KiB,
    deadlineMs: 0,
    retentionSec: 7 * 86400,
    required: [],
    minClass: 0
  }),
  // メディア：本文は直接持ち込まない。大きさとハッシュで照合する
  media: Object.freeze({
    delivery: "chunked",
    priority: 7,
    inlineMax: 0,
    deadlineMs: 0,
    retentionSec: null,
    required: ["ref", "len", "h"],
    minClass: 0
  })
});
var LANE_NAMES = Object.freeze(Object.keys(LANES));
function isLane(name) {
  return typeof name === "string" && Object.prototype.hasOwnProperty.call(LANES, name);
}
var MEDIA_CHUNK_BYTES = 1024 * KiB;
var HEADER_MAX_BYTES = 2 * KiB;

// love-connect-hub/src/envelope.ts
var FIELDS = /* @__PURE__ */ new Set([
  "v",
  "l",
  "f",
  "id",
  "co",
  "by",
  "at",
  "c",
  "dl",
  "ap",
  "ret",
  "sq",
  "bv",
  "ref",
  "len",
  "h",
  "e",
  "b",
  "sig",
  "tk"
]);
var ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
var MSG_ID_RE = /^[A-Za-z0-9_-]{8,64}$/;
var FORMAT_RE = /^[a-z][a-z0-9]*(?:\.[a-z0-9][a-z0-9_-]*){1,7}$/;
var REF_RE = /^[A-Za-z0-9._~:/?#@!$&'()*+,;=%-]{1,512}$/;
var HASH_RE = /^[0-9a-f]{64}$/;
var SIG_RE = /^[A-Za-z0-9_-]{43}$/;
var DEADLINE_MAX_MS = 6e5;
var RETENTION_MAX_SEC = 10 * 365 * 86400;
var encoder = new TextEncoder();
function fail(code, field, message) {
  return { ok: false, code, field, message };
}
function isUint(x, max = Number.MAX_SAFE_INTEGER) {
  return typeof x === "number" && Number.isInteger(x) && x >= 0 && x <= max;
}
function bodyBytes(b) {
  if (b === void 0) return 0;
  if (typeof b === "string") return encoder.encode(b).byteLength;
  if (b instanceof Uint8Array) return b.byteLength;
  return encoder.encode(JSON.stringify(b) ?? "").byteLength;
}
function checkEnvelope(input, opts = {}) {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    return fail("NOT_OBJECT", "", "\u5C01\u7B52\u306E\u5F62\u3067\u306F\u3042\u308A\u307E\u305B\u3093");
  }
  const o = input;
  for (const k of Object.keys(o)) {
    if (!FIELDS.has(k)) return fail("UNKNOWN_FIELD", k, `\u898F\u683C\u306B\u7121\u3044\u9805\u76EE\u3067\u3059\uFF1A${k}`);
  }
  if (typeof o.v !== "number" || !SPEC_VERSIONS.includes(o.v)) return fail("BAD_VERSION", "v", "\u5BFE\u5FDC\u3057\u3066\u3044\u306A\u3044\u898F\u683C\u7248\u3067\u3059");
  if (o.tk !== void 0) {
    if (o.v < 2) return fail("UNKNOWN_FIELD", "tk", "\u4F5C\u696D ID\uFF08tk\uFF09\u306F\u7B2C2\u7248\u306E\u5C01\u7B52\u3060\u3051\u306B\u4ED8\u3051\u3089\u308C\u307E\u3059");
    if (typeof o.tk !== "string" || !TASK_ID_RE.test(o.tk)) return fail("BAD_FIELD", "tk", "\u4F5C\u696D ID \u306F w- \u3068\u82F1\u6570\u5B57 8 \u6587\u5B57\u3067\u3059\uFF08\u4F8B w-a1B2c3D4\uFF09");
  }
  if (!isLane(o.l)) return fail("BAD_LANE", "l", "\u898F\u683C\u306B\u7121\u3044\u30EC\u30FC\u30F3\u3067\u3059");
  const lane = LANES[o.l];
  if (typeof o.f !== "string" || !FORMAT_RE.test(o.f) || !o.f.startsWith(`${o.l}.`)) {
    return fail("BAD_FIELD", "f", "\u5F62\u5F0F\u306E\u540D\u524D\u304C\u6B63\u3057\u304F\u3042\u308A\u307E\u305B\u3093\uFF08\u30EC\u30FC\u30F3\u540D.\u5206\u985E.\u540D\u524D\uFF09");
  }
  if (typeof o.id !== "string" || !MSG_ID_RE.test(o.id)) return fail("BAD_FIELD", "id", "\u4E00\u610F\u306E\u756A\u53F7\u304C\u6B63\u3057\u304F\u3042\u308A\u307E\u305B\u3093");
  if (typeof o.co !== "string" || !ID_RE.test(o.co)) return fail("BAD_FIELD", "co", "\u4F1A\u793E ID \u304C\u6B63\u3057\u304F\u3042\u308A\u307E\u305B\u3093");
  if (typeof o.by !== "string" || !ID_RE.test(o.by)) return fail("BAD_FIELD", "by", "\u9001\u308A\u624B\u306E ID \u304C\u6B63\u3057\u304F\u3042\u308A\u307E\u305B\u3093");
  if (!isUint(o.at) || o.at === 0) return fail("BAD_FIELD", "at", "\u6642\u523B\u304C\u6B63\u3057\u304F\u3042\u308A\u307E\u305B\u3093");
  if (!isUint(o.c, 3)) return fail("BAD_FIELD", "c", "\u6A5F\u5BC6\u5EA6\u306F 0\u301C3 \u3067\u3059");
  if (opts.formats) {
    const allowed = opts.formats[o.l];
    if (!allowed || !allowed.has(o.f)) return fail("FORMAT_NOT_ALLOWED", "f", "\u8A31\u53EF\u3055\u308C\u3066\u3044\u306A\u3044\u5F62\u5F0F\u3067\u3059");
  }
  if (o.dl !== void 0 && !isUint(o.dl, DEADLINE_MAX_MS)) return fail("BAD_FIELD", "dl", "\u7DE0\u3081\u5207\u308A\u304C\u6B63\u3057\u304F\u3042\u308A\u307E\u305B\u3093");
  if (o.ap !== void 0 && typeof o.ap !== "boolean") return fail("BAD_FIELD", "ap", "\u627F\u8A8D\u306E\u6307\u5B9A\u304C\u6B63\u3057\u304F\u3042\u308A\u307E\u305B\u3093");
  if (o.ret !== void 0 && !isUint(o.ret, RETENTION_MAX_SEC)) return fail("BAD_FIELD", "ret", "\u4FDD\u5B58\u671F\u9593\u304C\u6B63\u3057\u304F\u3042\u308A\u307E\u305B\u3093");
  if (o.sq !== void 0 && !isUint(o.sq)) return fail("BAD_FIELD", "sq", "\u9806\u756A\u304C\u6B63\u3057\u304F\u3042\u308A\u307E\u305B\u3093");
  if (o.bv !== void 0 && !isUint(o.bv)) return fail("BAD_FIELD", "bv", "\u5143\u306E\u7248\u304C\u6B63\u3057\u304F\u3042\u308A\u307E\u305B\u3093");
  if (o.ref !== void 0 && (typeof o.ref !== "string" || !REF_RE.test(o.ref))) return fail("BAD_FIELD", "ref", "\u7F6E\u304D\u5834\u6240\u304C\u6B63\u3057\u304F\u3042\u308A\u307E\u305B\u3093");
  if (o.len !== void 0 && !isUint(o.len)) return fail("BAD_FIELD", "len", "\u5927\u304D\u3055\u304C\u6B63\u3057\u304F\u3042\u308A\u307E\u305B\u3093");
  if (o.h !== void 0 && (typeof o.h !== "string" || !HASH_RE.test(o.h))) return fail("BAD_FIELD", "h", "\u30CF\u30C3\u30B7\u30E5\u304C\u6B63\u3057\u304F\u3042\u308A\u307E\u305B\u3093");
  if (o.e !== void 0 && o.e !== "A256GCM") return fail("BAD_FIELD", "e", "\u5BFE\u5FDC\u3057\u3066\u3044\u306A\u3044\u6697\u53F7\u65B9\u5F0F\u3067\u3059");
  if (o.sig !== void 0 && (typeof o.sig !== "string" || !SIG_RE.test(o.sig))) return fail("BAD_FIELD", "sig", "\u7F72\u540D\u306E\u5F62\u304C\u6B63\u3057\u304F\u3042\u308A\u307E\u305B\u3093");
  for (const k of lane.required) {
    if (o[k] === void 0) return fail("MISSING_FIELD", k, `\u3053\u306E\u30EC\u30FC\u30F3\u3067\u306F\u5FC5\u9808\u306E\u9805\u76EE\u3067\u3059\uFF1A${k}`);
  }
  const c = o.c;
  if (c < lane.minClass) return fail("CLASS_TOO_LOW", "c", "\u3053\u306E\u30EC\u30FC\u30F3\u306E\u6A5F\u5BC6\u5EA6\u306E\u4E0B\u9650\u3092\u4E0B\u56DE\u3063\u3066\u3044\u307E\u3059");
  if (o.l === "key" && o.ret !== void 0 && o.ret !== 0) return fail("BAD_FIELD", "ret", "\u9375\u30EC\u30FC\u30F3\u306F\u4FDD\u5B58\u3067\u304D\u307E\u305B\u3093");
  if (c >= 2 && o.sig === void 0) return fail("SIGNATURE_REQUIRED", "sig", "\u6A5F\u5BC6\u4EE5\u4E0A\u306F\u7F72\u540D\u304C\u5FC5\u9808\u3067\u3059");
  const hasBody = o.b !== void 0;
  const headerBytes = encoder.encode(JSON.stringify(o, (k, val) => k === "b" ? void 0 : val)).byteLength;
  if (headerBytes > HEADER_MAX_BYTES) return fail("HEADER_TOO_LARGE", "", "\u898B\u51FA\u3057\u304C\u5927\u304D\u3059\u304E\u307E\u3059");
  if (hasBody) {
    if (lane.inlineMax === 0) return fail("BODY_FORBIDDEN", "b", "\u3053\u306E\u30EC\u30FC\u30F3\u3067\u306F\u672C\u6587\u3092\u76F4\u63A5\u904B\u3079\u307E\u305B\u3093");
    if (o.ref !== void 0) return fail("BODY_AND_REF", "b", "\u672C\u6587\u3068\u7F6E\u304D\u5834\u6240\u306F\u3001\u3069\u3061\u3089\u304B\u4E00\u65B9\u3060\u3051\u3067\u3059");
    if (c === 3 && o.e === void 0) return fail("ENCRYPTION_REQUIRED", "e", "\u6975\u79D8\u306E\u672C\u6587\u306F\u6697\u53F7\u5316\u304C\u5FC5\u9808\u3067\u3059");
    if (o.e !== void 0 && typeof o.b !== "string") return fail("BAD_FIELD", "b", "\u6697\u53F7\u5316\u3057\u305F\u672C\u6587\u306F\u6587\u5B57\u5217\u3067\u3059");
    if (bodyBytes(o.b) > lane.inlineMax) return fail("BODY_TOO_LARGE", "b", "\u672C\u6587\u304C\u5927\u304D\u3059\u304E\u307E\u3059\u3002\u7F6E\u304D\u5834\u6240\uFF08ref\uFF09\u3067\u6E21\u3057\u3066\u304F\u3060\u3055\u3044");
  } else if (o.e !== void 0) {
    return fail("BAD_FIELD", "e", "\u672C\u6587\u304C\u7121\u3044\u306E\u306B\u6697\u53F7\u65B9\u5F0F\u304C\u3042\u308A\u307E\u3059");
  }
  return { ok: true, env: o };
}
function isExpired(env, now) {
  const dl = env.dl ?? LANES[env.l].deadlineMs;
  return dl > 0 && now > env.at + dl;
}
function retentionOf(env) {
  if (env.l === "key") return 0;
  return env.ret ?? LANES[env.l].retentionSec;
}
function redact(env) {
  const { b, sig: _sig, ...rest } = env;
  if (b === void 0) return rest;
  if (env.c === 0) return { ...rest, b };
  return { ...rest, len: rest.len ?? bodyBytes(b) };
}

// love-connect-hub/src/crypto.ts
var subtle = globalThis.crypto.subtle;
var encoder2 = new TextEncoder();
var decoder = new TextDecoder();
function toBase64Url(bytes) {
  let s2 = "";
  for (let i = 0; i < bytes.length; i += 32768) {
    s2 += String.fromCharCode(...bytes.subarray(i, i + 32768));
  }
  return btoa(s2).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function fromBase64Url(s2) {
  if (!/^[A-Za-z0-9_-]*$/.test(s2)) throw new Error("base64url \u306E\u5F62\u3067\u306F\u3042\u308A\u307E\u305B\u3093");
  const pad2 = s2.length % 4 === 0 ? "" : "=".repeat(4 - s2.length % 4);
  const bin = atob(s2.replace(/-/g, "+").replace(/_/g, "/") + pad2);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
function toBytes(data) {
  return typeof data === "string" ? encoder2.encode(data) : data;
}
function canonicalJson(value) {
  if (value === null || typeof value !== "object") {
    const s2 = JSON.stringify(value);
    if (s2 === void 0) throw new Error("\u7F72\u540D\u3067\u304D\u306A\u3044\u5024\u304C\u542B\u307E\u308C\u3066\u3044\u307E\u3059");
    return s2;
  }
  if (value instanceof Uint8Array) return JSON.stringify(toBase64Url(value));
  if (Array.isArray(value)) return `[${value.map((v) => canonicalJson(v === void 0 ? null : v)).join(",")}]`;
  const obj = value;
  const keys = Object.keys(obj).filter((k) => obj[k] !== void 0).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`).join(",")}}`;
}
function signingBytes(env) {
  const { sig: _sig, ...rest } = env;
  return encoder2.encode(canonicalJson(rest));
}
function importSigningKey(raw) {
  if (raw.byteLength < 32) throw new Error("\u7F72\u540D\u7528\u306E\u9375\u306F 32 \u30D0\u30A4\u30C8\u4EE5\u4E0A\u306B\u3057\u3066\u304F\u3060\u3055\u3044");
  return subtle.importKey("raw", raw, { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
}
async function signEnvelope(env, key) {
  const mac = new Uint8Array(await subtle.sign("HMAC", key, signingBytes(env)));
  return { ...env, sig: toBase64Url(mac) };
}
async function verifyEnvelope(env, key) {
  if (typeof env.sig !== "string") return false;
  let mac;
  try {
    mac = fromBase64Url(env.sig);
  } catch {
    return false;
  }
  if (mac.byteLength !== 32) return false;
  return subtle.verify("HMAC", key, mac, signingBytes(env));
}
async function sha256Hex(data) {
  const d = new Uint8Array(await subtle.digest("SHA-256", toBytes(data)));
  let s2 = "";
  for (const x of d) s2 += x.toString(16).padStart(2, "0");
  return s2;
}
async function matchesBody(env, data) {
  if (env.len !== void 0 && env.len !== data.byteLength) return false;
  if (env.h === void 0) return false;
  return await sha256Hex(data) === env.h;
}
function importSealKey(raw) {
  if (raw.byteLength !== 32) throw new Error("\u6697\u53F7\u5316\u7528\u306E\u9375\u306F 32 \u30D0\u30A4\u30C8\u3067\u3059");
  return subtle.importKey("raw", raw, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
}
function aadOf(env) {
  return encoder2.encode(`lch1|${env.co}|${env.id}`);
}
async function sealBody(env, data, key) {
  const iv = globalThis.crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(
    await subtle.encrypt({ name: "AES-GCM", iv, additionalData: aadOf(env) }, key, toBytes(data))
  );
  const out = new Uint8Array(iv.length + ct.length);
  out.set(iv, 0);
  out.set(ct, iv.length);
  return toBase64Url(out);
}
async function openBody(env, key) {
  if (typeof env.b !== "string") throw new Error("\u6697\u53F7\u5316\u3055\u308C\u305F\u672C\u6587\u304C\u3042\u308A\u307E\u305B\u3093");
  const raw = fromBase64Url(env.b);
  if (raw.byteLength < 12 + 16) throw new Error("\u6697\u53F7\u6587\u304C\u77ED\u3059\u304E\u307E\u3059");
  const pt = await subtle.decrypt(
    { name: "AES-GCM", iv: raw.subarray(0, 12), additionalData: aadOf(env) },
    key,
    raw.subarray(12)
  );
  return new Uint8Array(pt);
}
function openBodyText(env, key) {
  return openBody(env, key).then((b) => decoder.decode(b));
}

// love-connect-hub/src/dedupe.ts
function createDedupe(opts) {
  const { windowMs, capacity } = opts;
  if (!(windowMs > 0) || !(capacity > 0)) throw new Error("windowMs \u3068 capacity \u306F\u6B63\u306E\u6570\u3067\u3059");
  const seen = /* @__PURE__ */ new Map();
  function sweep(now) {
    for (const [k, t] of seen) {
      if (now - t < windowMs && seen.size <= capacity) break;
      seen.delete(k);
    }
  }
  return {
    first(co, id, now) {
      const k = `${co}\0${id}`;
      const t = seen.get(k);
      if (t !== void 0 && now - t < windowMs) return false;
      if (t !== void 0) seen.delete(k);
      seen.set(k, now);
      sweep(now);
      return true;
    },
    get size() {
      return seen.size;
    }
  };
}
var pad = (n2) => String(Math.max(0, Math.floor(n2))).padStart(16, "0");
async function storageFirst(storage, key, now, windowMs, sweepLimit = 128) {
  if (!(windowMs > 0)) throw new Error("windowMs \u306F\u6B63\u306E\u6570\u3067\u3059");
  const seen = await storage.get(`s:${key}`);
  if (typeof seen === "number" && now - seen < windowMs) return false;
  await storage.put(`s:${key}`, now);
  await storage.put(`t:${pad(now)}:${key}`, now);
  const old = await storage.list({ prefix: "t:", end: `t:${pad(now - windowMs)}`, limit: sweepLimit });
  const drop = [];
  for (const [k, t] of old) {
    const rest = k.slice(2 + 16 + 1);
    if (await storage.get(`s:${rest}`) === t) drop.push(`s:${rest}`);
    drop.push(k);
  }
  if (drop.length) await storage.delete(drop);
  return true;
}

// love-connect-hub/src/sender.ts
var SendError = class extends Error {
  code;
  field;
  constructor(code, field, message) {
    super(message);
    this.name = "SendError";
    this.code = code;
    this.field = field;
  }
};
function randomId() {
  return toBase64Url(globalThis.crypto.getRandomValues(new Uint8Array(16)));
}
function createSender(opts) {
  const newId = opts.newId ?? randomId;
  return {
    async make(lane, f, input = {}) {
      const c = input.c ?? LANES[lane].minClass;
      let env = { v: versionFor(input.tk), l: lane, f, id: input.id ?? newId(), co: opts.co, by: opts.by, at: opts.now(), c };
      for (const k of ["tk", "dl", "ap", "ret", "sq", "bv", "ref", "len", "h"]) {
        if (input[k] !== void 0) env[k] = input[k];
      }
      if (input.b !== void 0) {
        if (c === 3) {
          if (!opts.sealKey) throw new SendError("NO_SEAL_KEY", "e", "\u6975\u79D8\u306E\u672C\u6587\u3092\u9001\u308B\u306B\u306F\u6697\u53F7\u5316\u7528\u306E\u9375\u304C\u5FC5\u8981\u3067\u3059");
          env.e = "A256GCM";
          env.b = await sealBody(env, JSON.stringify(input.b), opts.sealKey);
        } else {
          env.b = input.b;
        }
      }
      if (opts.signingKey) env = await signEnvelope(env, opts.signingKey);
      else if (c >= 2) throw new SendError("NO_SIGNING_KEY", "sig", "\u6A5F\u5BC6\u4EE5\u4E0A\u3092\u9001\u308B\u306B\u306F\u7F72\u540D\u7528\u306E\u9375\u304C\u5FC5\u8981\u3067\u3059");
      const r = checkEnvelope(env);
      if (!r.ok) throw new SendError(r.code, r.field, r.message);
      return env;
    }
  };
}

// love-connect-hub/src/receiver.ts
var RAW_MAX_BYTES = HEADER_MAX_BYTES + Math.ceil(Math.max(...Object.values(LANES).map((p) => p.inlineMax)) * 4 / 3) + 1024;
function no(code, field, message) {
  return { ok: false, code, field, message };
}
function createReceiver(opts) {
  const dedupe = opts.dedupe ?? createDedupe({ windowMs: 864e5, capacity: 1e4 });
  const skew = opts.skewMs ?? 6e4;
  const encoder4 = new TextEncoder();
  return {
    async receive(raw) {
      let input = raw;
      if (typeof raw === "string") {
        if (raw.length > RAW_MAX_BYTES || encoder4.encode(raw).byteLength > RAW_MAX_BYTES) {
          return no("TOO_LARGE", "", "\u53D7\u3051\u53D6\u308C\u308B\u5927\u304D\u3055\u3092\u8D85\u3048\u3066\u3044\u307E\u3059");
        }
        try {
          input = JSON.parse(raw);
        } catch {
          return no("BAD_JSON", "", "JSON \u3068\u3057\u3066\u8AAD\u3081\u307E\u305B\u3093");
        }
      }
      const r = checkEnvelope(input, { formats: opts.formats });
      if (!r.ok) return r;
      const env = r.env;
      const now = opts.now();
      if (env.at > now + skew) return no("FUTURE_TIME", "at", "\u6642\u523B\u304C\u672A\u6765\u306B\u306A\u3063\u3066\u3044\u307E\u3059");
      if (isExpired(env, now)) return no("EXPIRED", "dl", "\u7DE0\u3081\u5207\u308A\u3092\u904E\u304E\u3066\u3044\u307E\u3059");
      if (env.sig !== void 0) {
        const got = await opts.signingKey(env.co);
        const keys = got === void 0 ? [] : Array.isArray(got) ? got : [got];
        if (keys.length === 0) return no("NO_KEY", "sig", "\u3053\u306E\u4F1A\u793E\u306E\u7F72\u540D\u7528\u306E\u9375\u304C\u3042\u308A\u307E\u305B\u3093");
        let valid = false;
        for (const key of keys) {
          if (await verifyEnvelope(env, key)) {
            valid = true;
            break;
          }
        }
        if (!valid) return no("BAD_SIGNATURE", "sig", "\u7F72\u540D\u304C\u4E00\u81F4\u3057\u307E\u305B\u3093");
      }
      if (!await dedupe.first(env.co, env.id, now)) return no("DUPLICATE", "id", "\u540C\u3058\u756A\u53F7\u306E\u5C01\u7B52\u3092\u53D7\u3051\u53D6\u308A\u6E08\u307F\u3067\u3059");
      return { ok: true, env };
    }
  };
}
async function readBody(env, sealKey) {
  if (env.e === void 0) return env.b;
  const keys = sealKey === void 0 ? [] : Array.isArray(sealKey) ? sealKey : [sealKey];
  if (keys.length === 0) throw new Error("\u6697\u53F7\u5316\u7528\u306E\u9375\u304C\u3042\u308A\u307E\u305B\u3093");
  let last;
  for (const key of keys) {
    try {
      return JSON.parse(await openBodyText(env, key));
    } catch (e) {
      last = e;
    }
  }
  throw last instanceof Error ? last : new Error("\u672C\u6587\u3092\u958B\u3051\u307E\u305B\u3093");
}
function formatTable(t) {
  const out = {};
  for (const [lane, list] of Object.entries(t)) {
    for (const f of list) {
      if (!f.startsWith(`${lane}.`)) throw new Error(`\u5F62\u5F0F\u306E\u540D\u524D\u306F\u300C\u30EC\u30FC\u30F3\u540D.\u300D\u3067\u59CB\u3081\u3066\u304F\u3060\u3055\u3044\uFF1A${f}`);
    }
    out[lane] = new Set(list);
  }
  return out;
}

// love-connect-hub/src/batch.ts
var BATCH_ID_RE = /^[A-Za-z0-9-]{8,48}$/;
var PART_RE = /^([A-Za-z0-9-]{8,48})_(\d{1,9}|end)$/;
var BATCH_PART_BYTES = LANES.record.inlineMax - 1024;
function partId(batchId, sq) {
  if (!BATCH_ID_RE.test(batchId)) throw new Error("\u4E00\u62EC\u756A\u53F7\u306F\u82F1\u6570\u5B57\u3068\u30CF\u30A4\u30D5\u30F3\u306E 8\u301C48 \u5B57\u3067\u3059");
  return `${batchId}_${sq}`;
}
async function planBatch(rows, maxBytes = BATCH_PART_BYTES) {
  const parts = [];
  let cur = [];
  let size = 2;
  for (const row of rows) {
    const n2 = bodyBytes(row) + 1;
    if (n2 + 2 > maxBytes) throw new Error("1 \u884C\u304C\u5927\u304D\u3059\u304E\u3066\u5206\u3051\u3089\u308C\u307E\u305B\u3093");
    if (size + n2 > maxBytes) {
      parts.push(cur);
      cur = [];
      size = 2;
    }
    cur.push(row);
    size += n2;
  }
  if (cur.length) parts.push(cur);
  return { parts, rows: rows.length, h: await sha256Hex(canonicalJson(rows)) };
}
function createBatchAssembler(opts = {}) {
  const maxParts = opts.maxParts ?? 1e4;
  const maxRows = opts.maxRows ?? 1e6;
  const parts = /* @__PURE__ */ new Map();
  let batchId;
  let end;
  let rowCount = 0;
  let finished = false;
  const err = (code, message) => ({ state: "error", code, message });
  async function tryFinish() {
    if (!end || parts.size < end.parts) return { state: "partial", received: parts.size };
    const rows = [];
    for (let i = 0; i < end.parts; i++) {
      const p = parts.get(i);
      if (!p) return { state: "partial", received: parts.size };
      for (const r of p) rows.push(r);
    }
    if (rows.length !== end.rows) return err("COUNT_MISMATCH", "\u4EF6\u6570\u304C\u4E00\u81F4\u3057\u307E\u305B\u3093");
    if (await sha256Hex(canonicalJson(rows)) !== end.h) return err("HASH_MISMATCH", "\u30CF\u30C3\u30B7\u30E5\u304C\u4E00\u81F4\u3057\u307E\u305B\u3093");
    finished = true;
    return { state: "done", batchId, rows };
  }
  return {
    async add(env) {
      if (finished) return err("FINISHED", "\u3053\u306E\u4E00\u62EC\u306F\u7D44\u307F\u7ACB\u3066\u6E08\u307F\u3067\u3059");
      if (env.l !== "record") return err("BAD_LANE", "\u4E00\u62EC\u306F\u30EC\u30B3\u30FC\u30C9\u30EC\u30FC\u30F3\u3060\u3051\u3067\u3059");
      const m = PART_RE.exec(env.id);
      if (!m) return err("BAD_ID", "\u4E00\u62EC\u306E\u756A\u53F7\u306E\u5F62\u3067\u306F\u3042\u308A\u307E\u305B\u3093");
      if (batchId === void 0) batchId = m[1];
      else if (batchId !== m[1]) return err("OTHER_BATCH", "\u5225\u306E\u4E00\u62EC\u306E\u5C01\u7B52\u3067\u3059");
      if (m[2] === "end") {
        const b = env.b;
        if (end) return err("DUPLICATE_END", "\u7D42\u308F\u308A\u306E\u5C01\u7B52\u304C\u4E8C\u5EA6\u5C4A\u304D\u307E\u3057\u305F");
        if (!b || !Number.isInteger(b.parts) || !Number.isInteger(b.rows) || typeof env.h !== "string") {
          return err("BAD_END", "\u7D42\u308F\u308A\u306E\u5C01\u7B52\u306B\u306F parts\u30FBrows\u30FBh \u304C\u5FC5\u8981\u3067\u3059");
        }
        const p = b.parts;
        const r = b.rows;
        if (p < 0 || p > maxParts || r < 0 || r > maxRows) return err("TOO_LARGE", "\u4E00\u62EC\u304C\u5927\u304D\u3059\u304E\u307E\u3059");
        if (parts.size > p || [...parts.keys()].some((k) => k >= p)) return err("BAD_PART", "\u7247\u306E\u6570\u304C\u5408\u3044\u307E\u305B\u3093");
        end = { parts: p, rows: r, h: env.h };
        return tryFinish();
      }
      const sq = Number(m[2]);
      if (env.sq !== sq) return err("BAD_PART", "\u756A\u53F7\u3068\u9806\u756A\uFF08sq\uFF09\u304C\u4E00\u81F4\u3057\u307E\u305B\u3093");
      if (sq >= maxParts || end && sq >= end.parts) return err("BAD_PART", "\u7247\u306E\u756A\u53F7\u304C\u7BC4\u56F2\u5916\u3067\u3059");
      if (parts.has(sq)) return err("DUPLICATE_PART", "\u540C\u3058\u7247\u304C\u4E8C\u5EA6\u5C4A\u304D\u307E\u3057\u305F");
      if (!Array.isArray(env.b)) return err("BAD_PART", "\u7247\u306E\u672C\u6587\u306F\u884C\u306E\u4E26\u3073\u3067\u3059");
      rowCount += env.b.length;
      if (rowCount > maxRows) return err("TOO_LARGE", "\u4E00\u62EC\u304C\u5927\u304D\u3059\u304E\u307E\u3059");
      parts.set(sq, env.b);
      return tryFinish();
    }
  };
}

// love-connect-hub/src/media.ts
function partCount(len, chunk = MEDIA_CHUNK_BYTES) {
  return len === 0 ? 1 : Math.ceil(len / chunk);
}
function* splitMedia(bytes, chunk = MEDIA_CHUNK_BYTES) {
  const n2 = partCount(bytes.byteLength, chunk);
  for (let sq = 0; sq < n2; sq++) yield { sq, bytes: bytes.subarray(sq * chunk, Math.min(bytes.byteLength, (sq + 1) * chunk)) };
}
async function describeMedia(bytes) {
  return { len: bytes.byteLength, h: await sha256Hex(bytes) };
}
function createMediaAssembler(env, opts = {}) {
  const maxBytes = opts.maxBytes ?? 100 * 1024 * 1024;
  const chunk = opts.chunk ?? MEDIA_CHUNK_BYTES;
  if (env.len === void 0 || env.h === void 0) throw new Error("\u5927\u304D\u3055\uFF08len\uFF09\u3068\u30CF\u30C3\u30B7\u30E5\uFF08h\uFF09\u304C\u5FC5\u8981\u3067\u3059");
  if (env.len > maxBytes) throw new Error("\u53D7\u3051\u53D6\u308C\u308B\u5927\u304D\u3055\u3092\u8D85\u3048\u3066\u3044\u307E\u3059");
  const len = env.len;
  const h = env.h;
  const total = partCount(len, chunk);
  const buf = new Uint8Array(len);
  const got = /* @__PURE__ */ new Set();
  return {
    add(sq, bytes) {
      if (!Number.isInteger(sq) || sq < 0 || sq >= total) return { ok: false, code: "BAD_PART", message: "\u7247\u306E\u756A\u53F7\u304C\u7BC4\u56F2\u5916\u3067\u3059" };
      if (got.has(sq)) return { ok: false, code: "DUPLICATE_PART", message: "\u540C\u3058\u7247\u304C\u4E8C\u5EA6\u5C4A\u304D\u307E\u3057\u305F" };
      const expect = sq === total - 1 ? len - sq * chunk : chunk;
      if (bytes.byteLength !== expect) return { ok: false, code: "BAD_SIZE", message: "\u7247\u306E\u5927\u304D\u3055\u304C\u5408\u3044\u307E\u305B\u3093" };
      buf.set(bytes, sq * chunk);
      got.add(sq);
      return { ok: true, received: got.size, total };
    },
    get complete() {
      return got.size === total;
    },
    async finish() {
      if (got.size !== total) throw new Error("\u307E\u3060\u5168\u90E8\u306E\u7247\u304C\u5C4A\u3044\u3066\u3044\u307E\u305B\u3093");
      if (await sha256Hex(buf) !== h) throw new Error("\u30CF\u30C3\u30B7\u30E5\u304C\u4E00\u81F4\u3057\u307E\u305B\u3093");
      return buf;
    }
  };
}

// love-connect-hub/src/seq.ts
var GROUP_RE = /^[A-Za-z0-9-]{8,48}$/;
var SEQ_ID_RE = /^([A-Za-z0-9-]{8,48})_(\d{1,9}|end)$/;
function seqId(group, sq) {
  if (!GROUP_RE.test(group)) throw new Error("\u307E\u3068\u307E\u308A\u756A\u53F7\u306F\u82F1\u6570\u5B57\u3068\u30CF\u30A4\u30D5\u30F3\u306E 8\u301C48 \u5B57\u3067\u3059");
  if (sq !== "end" && (!Number.isInteger(sq) || sq < 0 || sq > 999999999)) throw new Error("\u9806\u756A\u304C\u6B63\u3057\u304F\u3042\u308A\u307E\u305B\u3093");
  return `${group}_${sq}`;
}
function parseSeqId(id) {
  const m = SEQ_ID_RE.exec(id);
  if (!m) return void 0;
  return { group: m[1], sq: m[2] === "end" ? "end" : Number(m[2]) };
}

// love-connect-hub/src/stream.ts
function createStreamReorder(opts = {}) {
  const waitMs = opts.waitMs ?? 200;
  const maxBuffered = opts.maxBuffered ?? 256;
  if (!(waitMs >= 0) || !(maxBuffered > 0)) throw new Error("waitMs \u3068 maxBuffered \u306E\u5024\u304C\u6B63\u3057\u304F\u3042\u308A\u307E\u305B\u3093");
  const buf = /* @__PURE__ */ new Map();
  let next;
  let gapSince;
  const stats = { delivered: 0, late: 0, duplicate: 0, skipped: 0, overflow: 0 };
  function drain(now) {
    const out = [];
    for (; ; ) {
      if (next === void 0) break;
      const e = buf.get(next);
      if (e) {
        buf.delete(next);
        out.push(e);
        next++;
        gapSince = void 0;
        continue;
      }
      if (buf.size === 0) break;
      if (gapSince === void 0) gapSince = now;
      if (now - gapSince >= waitMs || buf.size > maxBuffered) {
        let min = Number.POSITIVE_INFINITY;
        for (const k of buf.keys()) if (k < min) min = k;
        stats.skipped += min - next;
        next = min;
        gapSince = void 0;
        continue;
      }
      break;
    }
    stats.delivered += out.length;
    return out;
  }
  return {
    push(env, now) {
      const sq = env.sq;
      if (sq === void 0) throw new Error("\u30B9\u30C8\u30EA\u30FC\u30DF\u30F3\u30B0\u306E\u7247\u306B\u306F\u9806\u756A\uFF08sq\uFF09\u304C\u5FC5\u8981\u3067\u3059");
      if (next === void 0) next = sq;
      if (sq < next) {
        stats.late++;
        return [];
      }
      if (buf.has(sq)) {
        stats.duplicate++;
        return [];
      }
      buf.set(sq, env);
      if (buf.size > maxBuffered * 2) {
        let max = -1;
        for (const k of buf.keys()) if (k > max) max = k;
        buf.delete(max);
        stats.overflow++;
      }
      return drain(now);
    },
    flush(now) {
      return drain(now);
    },
    get next() {
      return next;
    },
    get stats() {
      return stats;
    }
  };
}

// love-connect-hub/src/sync.ts
function checkVersion(current, bv) {
  if (bv === void 0 || bv !== current) return { ok: false, code: "VERSION_CONFLICT", current };
  return { ok: true, next: current + 1 };
}
var same = (a, b) => {
  if (a === b) return true;
  if (a === void 0 || b === void 0) return false;
  return canonicalJson(a) === canonicalJson(b);
};
function mergeFields(base, theirs, mine) {
  const keys = /* @__PURE__ */ new Set([...Object.keys(base), ...Object.keys(theirs), ...Object.keys(mine)]);
  const merged = {};
  const conflicts = [];
  for (const k of [...keys].sort()) {
    if (k === "__proto__" || k === "constructor" || k === "prototype") {
      conflicts.push(k);
      continue;
    }
    const b = base[k];
    const t = theirs[k];
    const m = mine[k];
    let v;
    if (same(t, m)) v = t;
    else if (same(b, t)) v = m;
    else if (same(b, m)) v = t;
    else {
      conflicts.push(k);
      v = t;
    }
    if (v !== void 0) merged[k] = v;
  }
  return conflicts.length ? { ok: false, code: "MERGE_CONFLICT", fields: conflicts, merged } : { ok: true, merged };
}

// love-connect-hub/src/api.ts
function isRetryable(status) {
  return status === 0 || status === 408 || status === 425 || status === 429 || status >= 500 && status <= 599 && status !== 501;
}
function cryptoRandom() {
  const a = globalThis.crypto.getRandomValues(new Uint32Array(1));
  return a[0] / 2 ** 32;
}
async function withRetry(fn, opts) {
  const attempts = opts.attempts ?? 4;
  const baseMs = opts.baseMs ?? 200;
  const maxMs = opts.maxMs ?? 5e3;
  const sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  const random = opts.random ?? cryptoRandom;
  if (!(attempts >= 1)) throw new Error("attempts \u306F 1 \u4EE5\u4E0A\u3067\u3059");
  let last = 0;
  for (let i = 1; i <= attempts; i++) {
    let r;
    try {
      r = await fn(i);
    } catch {
      r = { status: 0 };
    }
    if (r.status >= 200 && r.status <= 299) return { ok: true, value: r.value, attempts: i };
    last = r.status;
    if (!isRetryable(r.status)) return { ok: false, status: r.status, attempts: i, reason: "NOT_RETRYABLE" };
    if (i === attempts) break;
    const cap = Math.min(maxMs, baseMs * 2 ** (i - 1));
    let wait = Math.floor(cap / 2 + random() * (cap / 2));
    if (r.retryAfterSec !== void 0 && r.retryAfterSec >= 0) wait = Math.max(wait, Math.min(r.retryAfterSec * 1e3, maxMs));
    if (opts.deadlineAt !== void 0 && opts.now() + wait >= opts.deadlineAt) {
      return { ok: false, status: last, attempts: i, reason: "DEADLINE" };
    }
    await sleep(wait);
  }
  return { ok: false, status: last, attempts, reason: "ATTEMPTS" };
}

// love-connect-hub/src/ai.ts
function aiDelta(d) {
  return { d };
}
function aiEnd(n2, usage) {
  return usage ? { n: n2, u: usage } : { n: n2 };
}
function createAiAssembler(opts = {}) {
  const maxChars = opts.maxChars ?? 1e6;
  const maxParts = opts.maxParts ?? 1e5;
  const pending = /* @__PURE__ */ new Map();
  let group;
  let next = 0;
  let text = "";
  let total;
  let usage;
  let finished = false;
  const err = (code, message) => ({ state: "error", code, message });
  function advance() {
    let delta = "";
    for (let s2 = pending.get(next); s2 !== void 0; s2 = pending.get(next)) {
      pending.delete(next);
      delta += s2;
      next++;
    }
    text += delta;
    return delta;
  }
  function result(delta) {
    if (total !== void 0 && next === total) {
      finished = true;
      return usage ? { state: "done", delta, text, usage } : { state: "done", delta, text };
    }
    return { state: "partial", delta, text };
  }
  return {
    add(env) {
      if (finished) return err("FINISHED", "\u3053\u306E\u5FDC\u7B54\u306F\u53D7\u3051\u53D6\u308A\u6E08\u307F\u3067\u3059");
      if (env.l !== "ai") return err("BAD_LANE", "AI \u30EC\u30FC\u30F3\u306E\u5C01\u7B52\u3067\u306F\u3042\u308A\u307E\u305B\u3093");
      const p = parseSeqId(env.id);
      if (!p) return err("BAD_ID", "\u65AD\u7247\u306E\u756A\u53F7\u306E\u5F62\u3067\u306F\u3042\u308A\u307E\u305B\u3093");
      if (group === void 0) group = p.group;
      else if (group !== p.group) return err("OTHER_GROUP", "\u5225\u306E\u5FDC\u7B54\u306E\u65AD\u7247\u3067\u3059");
      const b = env.b;
      if (p.sq === "end") {
        if (total !== void 0) return err("DUPLICATE_END", "\u7D42\u308F\u308A\u306E\u5C01\u7B52\u304C\u4E8C\u5EA6\u5C4A\u304D\u307E\u3057\u305F");
        if (!b || !Number.isInteger(b.n) || b.n < 0 || b.n > maxParts) {
          return err("BAD_END", "\u7D42\u308F\u308A\u306E\u5C01\u7B52\u306B\u306F\u65AD\u7247\u306E\u6570\uFF08n\uFF09\u304C\u5FC5\u8981\u3067\u3059");
        }
        const n2 = b.n;
        if (next > n2 || [...pending.keys()].some((k) => k >= n2)) return err("BAD_PART", "\u65AD\u7247\u306E\u6570\u304C\u5408\u3044\u307E\u305B\u3093");
        if (b.u !== void 0) {
          if (!Number.isInteger(b.u.in) || !Number.isInteger(b.u.out) || b.u.in < 0 || b.u.out < 0) {
            return err("BAD_END", "\u4F7F\u3063\u305F\u91CF\uFF08u\uFF09\u306E\u5F62\u304C\u6B63\u3057\u304F\u3042\u308A\u307E\u305B\u3093");
          }
          usage = { in: b.u.in, out: b.u.out };
        }
        total = n2;
        return result("");
      }
      const sq = p.sq;
      if (env.sq !== sq) return err("BAD_PART", "\u756A\u53F7\u3068\u9806\u756A\uFF08sq\uFF09\u304C\u4E00\u81F4\u3057\u307E\u305B\u3093");
      if (sq >= maxParts || total !== void 0 && sq >= total) return err("BAD_PART", "\u65AD\u7247\u306E\u756A\u53F7\u304C\u7BC4\u56F2\u5916\u3067\u3059");
      if (sq < next || pending.has(sq)) return err("DUPLICATE_PART", "\u540C\u3058\u65AD\u7247\u304C\u4E8C\u5EA6\u5C4A\u304D\u307E\u3057\u305F");
      if (!b || typeof b.d !== "string") return err("BAD_PART", "\u65AD\u7247\u306E\u672C\u6587\u306F { d: \u6587\u5B57 } \u3067\u3059");
      let size = text.length + b.d.length;
      for (const s2 of pending.values()) size += s2.length;
      if (size > maxChars) return err("TOO_LARGE", "\u5FDC\u7B54\u304C\u5927\u304D\u3059\u304E\u307E\u3059");
      pending.set(sq, b.d);
      return result(advance());
    },
    get text() {
      return text;
    }
  };
}

// love-connect-hub/src/http.ts
var HTTP_PATH = "/lch/v1/envelope";
var HTTP_STATUS = Object.freeze({
  TOO_LARGE: 413,
  HEADER_TOO_LARGE: 413,
  BODY_TOO_LARGE: 413,
  BAD_JSON: 400,
  NOT_OBJECT: 400,
  UNKNOWN_FIELD: 400,
  BAD_VERSION: 400,
  BAD_LANE: 400,
  BAD_FIELD: 400,
  MISSING_FIELD: 400,
  BODY_FORBIDDEN: 400,
  BODY_AND_REF: 400,
  FUTURE_TIME: 400,
  FORMAT_NOT_ALLOWED: 403,
  CLASS_TOO_LOW: 403,
  ENCRYPTION_REQUIRED: 403,
  SIGNATURE_REQUIRED: 401,
  NO_KEY: 401,
  BAD_SIGNATURE: 401,
  EXPIRED: 410,
  DUPLICATE: 409,
  METHOD: 405,
  NOT_FOUND: 404,
  CONTENT_TYPE: 415,
  HANDLER: 500
});
var SECURITY_HEADERS = {
  "content-type": "application/json; charset=utf-8",
  "cache-control": "no-store",
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer"
};
function json(status, body, extra) {
  return new Response(JSON.stringify(body), { status, headers: { ...SECURITY_HEADERS, ...extra } });
}
function reject(code, field, message) {
  return json(HTTP_STATUS[code], { ok: false, code, field, message });
}
async function readLimited(req, max) {
  const declared = Number(req.headers.get("content-length") ?? "NaN");
  if (Number.isFinite(declared) && declared > max) return void 0;
  if (!req.body) return "";
  const reader = req.body.getReader();
  const chunks = [];
  let size = 0;
  for (; ; ) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) {
      await reader.cancel().catch(() => {
      });
      return void 0;
    }
    chunks.push(value);
  }
  const all = new Uint8Array(size);
  let off = 0;
  for (const c of chunks) {
    all.set(c, off);
    off += c.byteLength;
  }
  return new TextDecoder("utf-8", { fatal: false }).decode(all);
}
function createHttpHandler(opts) {
  const path = opts.path ?? HTTP_PATH;
  return async (req) => {
    const url = new URL(req.url);
    if (url.pathname !== path) return reject("NOT_FOUND", "", "\u5165\u53E3\u304C\u9055\u3044\u307E\u3059");
    if (req.method !== "POST") return new Response(null, { status: 405, headers: { ...SECURITY_HEADERS, allow: "POST" } });
    const type = (req.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase();
    if (type !== "application/json") return reject("CONTENT_TYPE", "", "application/json \u3067\u9001\u3063\u3066\u304F\u3060\u3055\u3044");
    const raw = await readLimited(req, RAW_MAX_BYTES);
    if (raw === void 0) return reject("TOO_LARGE", "", "\u53D7\u3051\u53D6\u308C\u308B\u5927\u304D\u3055\u3092\u8D85\u3048\u3066\u3044\u307E\u3059");
    const r = await opts.receiver.receive(raw);
    if (!r.ok) return reject(r.code, r.field, r.message);
    try {
      const reply2 = await opts.onEnvelope(r.env);
      if (reply2) return json(200, { ok: true, env: reply2 });
      return json(202, { ok: true, id: r.env.id });
    } catch (error) {
      opts.onError?.({ id: r.env.id, lane: r.env.l, error });
      return reject("HANDLER", "", "\u51E6\u7406\u4E2D\u306B\u554F\u984C\u304C\u8D77\u304D\u307E\u3057\u305F");
    }
  };
}
function createHttpClient(opts) {
  const u = new URL(opts.url);
  const local = u.hostname === "localhost" || u.hostname === "127.0.0.1";
  if (u.protocol !== "https:" && !(local && u.protocol === "http:")) throw new Error("\u9001\u308A\u5148\u306F https \u306B\u3057\u3066\u304F\u3060\u3055\u3044");
  const doFetch = opts.fetch ?? ((r) => fetch(r));
  return {
    async send(env) {
      const body = JSON.stringify(env);
      const dl = env.dl ?? LANES[env.l].deadlineMs;
      let lastCode;
      const res = await withRetry(
        async () => {
          const resp = await doFetch(new Request(u, { method: "POST", headers: { "content-type": "application/json" }, body }));
          const status = resp.status;
          let data = {};
          try {
            data = await resp.json();
          } catch {
          }
          lastCode = data.code;
          if (status === 409 && data.code === "DUPLICATE") return { status: 200, value: { status, duplicate: true } };
          if (status >= 200 && status <= 299) {
            const value = data.env ? { status, reply: data.env, duplicate: false } : { status, duplicate: false };
            return { status, value };
          }
          const ra = Number(resp.headers.get("retry-after") ?? "NaN");
          return Number.isFinite(ra) ? { status, retryAfterSec: ra } : { status };
        },
        { ...opts, ...dl > 0 ? { deadlineAt: env.at + dl } : {} }
      );
      if (res.ok) return { ok: true, ...res.value, attempts: res.attempts };
      return lastCode ? { ok: false, status: res.status, code: lastCode, attempts: res.attempts, reason: res.reason } : { ok: false, status: res.status, attempts: res.attempts, reason: res.reason };
    }
  };
}

// love-connect-hub/src/socket.ts
var SOCKET_LANES_DEFAULT = Object.freeze(["stream", "sync", "ai", "event"]);
var CLOSE_POLICY = 1008;
function attachSocket(ws, opts) {
  const lanes = new Set(opts.lanes ?? SOCKET_LANES_DEFAULT);
  const maxStrikes = opts.maxStrikes ?? 10;
  let strikes = 0;
  let closed = false;
  let chain = Promise.resolve();
  const nack = (id, code, message) => {
    if (closed) return;
    ws.send(JSON.stringify({ ok: false, id, code, message }));
    if (++strikes >= maxStrikes) {
      closed = true;
      ws.close(CLOSE_POLICY, "too many rejected messages");
    }
  };
  ws.addEventListener("message", (ev) => {
    if (closed) return;
    const data = ev.data;
    chain = chain.then(async () => {
      if (closed) return;
      if (typeof data !== "string") return nack("", "BAD_FRAME", "\u6587\u5B57\u306E\u901A\u4FE1\u3060\u3051\u3092\u53D7\u3051\u4ED8\u3051\u307E\u3059");
      const r = await opts.receiver.receive(data);
      if (!r.ok) return nack("", r.code, r.message);
      if (!lanes.has(r.env.l)) return nack(r.env.id, "LANE_NOT_ON_SOCKET", "\u3053\u306E\u30EC\u30FC\u30F3\u306F HTTP \u3067\u9001\u3063\u3066\u304F\u3060\u3055\u3044");
      strikes = 0;
      try {
        await opts.onEnvelope(r.env);
      } catch (error) {
        opts.onError?.({ id: r.env.id, lane: r.env.l, error });
        nack(r.env.id, "HANDLER", "\u51E6\u7406\u4E2D\u306B\u554F\u984C\u304C\u8D77\u304D\u307E\u3057\u305F");
      }
    });
  });
  ws.addEventListener("close", () => {
    closed = true;
  });
  return {
    send(env) {
      if (closed) throw new Error("\u63A5\u7D9A\u306F\u9589\u3058\u3066\u3044\u307E\u3059");
      if (!lanes.has(env.l)) throw new Error("\u3053\u306E\u30EC\u30FC\u30F3\u306F HTTP \u3067\u9001\u3063\u3066\u304F\u3060\u3055\u3044");
      ws.send(JSON.stringify(env));
    },
    get closed() {
      return closed;
    }
  };
}

// love-connect-hub/src/token.ts
var TOKEN_MAX_CHARS = 8192;
var subtle2 = globalThis.crypto.subtle;
var encoder3 = new TextEncoder();
var decoder2 = new TextDecoder("utf-8", { fatal: true });
var TOKEN_RE = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;
function bad(message) {
  return { ok: false, code: "TOKEN_INVALID", message };
}
function readJson(part) {
  try {
    const v = JSON.parse(decoder2.decode(fromBase64Url(part)));
    return typeof v === "object" && v !== null && !Array.isArray(v) ? v : void 0;
  } catch {
    return void 0;
  }
}
function bearerToken(header) {
  if (!header) return void 0;
  const m = /^Bearer[ ]+([A-Za-z0-9_.-]+)$/i.exec(header.trim());
  return m?.[1];
}
async function importPublic(jwk, alg) {
  if (jwk.alg !== void 0 && jwk.alg !== alg) return void 0;
  if (jwk.use !== void 0 && jwk.use !== "sig") return void 0;
  try {
    if (alg === "ES256") {
      if (jwk.kty !== "EC" || jwk.crv !== "P-256" || !jwk.x || !jwk.y) return void 0;
      const k2 = { kty: "EC", crv: "P-256", x: jwk.x, y: jwk.y };
      return await subtle2.importKey("jwk", k2, { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]);
    }
    if (jwk.kty !== "RSA" || !jwk.n || !jwk.e) return void 0;
    if (fromBase64Url(jwk.n).byteLength < 256) return void 0;
    const k = { kty: "RSA", n: jwk.n, e: jwk.e };
    return await subtle2.importKey("jwk", k, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]);
  } catch {
    return void 0;
  }
}
function createTokenVerifier(opts) {
  if (!opts.jwks && !opts.hsKey) throw new Error("\u516C\u958B\u9375\u306E\u4E00\u89A7\uFF08jwks\uFF09\u304B\u5171\u901A\u9375\uFF08hsKey\uFF09\u306E\u3069\u3061\u3089\u304B\u304C\u5FC5\u8981\u3067\u3059");
  if (!opts.issuer || !opts.audience) throw new Error("\u767A\u884C\u5143\uFF08issuer\uFF09\u3068\u5B9B\u5148\uFF08audience\uFF09\u306F\u5FC5\u9808\u3067\u3059");
  const skew = opts.skewSec ?? 30;
  const maxLife = opts.maxLifetimeSec ?? 3600;
  const refreshMs = opts.refreshMs ?? 6e4;
  const keys = /* @__PURE__ */ new Map();
  let lastFetch = Number.NEGATIVE_INFINITY;
  let loading;
  async function load() {
    if (!opts.jwks) return;
    const set = await opts.jwks();
    keys.clear();
    for (const jwk of set.keys ?? []) {
      if (typeof jwk.kid !== "string" || jwk.kid === "") continue;
      for (const alg of ["ES256", "RS256"]) {
        const k = await importPublic(jwk, alg);
        if (k) keys.set(`${alg}|${jwk.kid}`, k);
      }
    }
  }
  async function publicKey(alg, kid) {
    const name = `${alg}|${kid}`;
    const hit = keys.get(name);
    if (hit) return hit;
    const t = opts.now();
    if (t - lastFetch < refreshMs) {
      if (loading) await loading.catch(() => {
      });
      return keys.get(name);
    }
    lastFetch = t;
    loading = load();
    try {
      await loading;
    } catch {
      return void 0;
    } finally {
      loading = void 0;
    }
    return keys.get(name);
  }
  return {
    async verify(token) {
      if (token === void 0 || token === "") return { ok: false, code: "TOKEN_MISSING", message: "\u30ED\u30B0\u30A4\u30F3\u306E\u30C8\u30FC\u30AF\u30F3\u304C\u3042\u308A\u307E\u305B\u3093" };
      if (token.length > TOKEN_MAX_CHARS || !TOKEN_RE.test(token)) return bad("\u30C8\u30FC\u30AF\u30F3\u306E\u5F62\u304C\u6B63\u3057\u304F\u3042\u308A\u307E\u305B\u3093");
      const [h64, p64, s64] = token.split(".");
      const header = readJson(h64);
      if (!header) return bad("\u30C8\u30FC\u30AF\u30F3\u306E\u898B\u51FA\u3057\u304C\u8AAD\u3081\u307E\u305B\u3093");
      const alg = header.alg;
      if (alg !== "ES256" && alg !== "RS256" && alg !== "HS256") return bad("\u53D7\u3051\u4ED8\u3051\u306A\u3044\u7F72\u540D\u65B9\u5F0F\u3067\u3059");
      if (header.crit !== void 0) return bad("\u7406\u89E3\u3067\u304D\u306A\u3044\u5FC5\u9808\u306E\u62E1\u5F35\u304C\u3042\u308A\u307E\u3059");
      let sig;
      try {
        sig = fromBase64Url(s64);
      } catch {
        return bad("\u7F72\u540D\u304C\u8AAD\u3081\u307E\u305B\u3093");
      }
      const data = encoder3.encode(`${h64}.${p64}`);
      let valid = false;
      if (alg === "HS256") {
        if (!opts.hsKey) return bad("\u53D7\u3051\u4ED8\u3051\u306A\u3044\u7F72\u540D\u65B9\u5F0F\u3067\u3059");
        valid = sig.byteLength === 32 && await subtle2.verify("HMAC", opts.hsKey, sig, data);
      } else {
        if (!opts.jwks) return bad("\u53D7\u3051\u4ED8\u3051\u306A\u3044\u7F72\u540D\u65B9\u5F0F\u3067\u3059");
        const kid = header.kid;
        if (typeof kid !== "string" || kid === "" || kid.length > 256) return bad("\u9375\u306E\u756A\u53F7\uFF08kid\uFF09\u304C\u3042\u308A\u307E\u305B\u3093");
        const key = await publicKey(alg, kid);
        if (!key) return bad("\u77E5\u3089\u306A\u3044\u9375\u3067\u7F72\u540D\u3055\u308C\u3066\u3044\u307E\u3059");
        valid = alg === "ES256" ? sig.byteLength === 64 && await subtle2.verify({ name: "ECDSA", hash: "SHA-256" }, key, sig, data) : await subtle2.verify("RSASSA-PKCS1-v1_5", key, sig, data);
      }
      if (!valid) return bad("\u7F72\u540D\u304C\u4E00\u81F4\u3057\u307E\u305B\u3093");
      const c = readJson(p64);
      if (!c) return bad("\u30C8\u30FC\u30AF\u30F3\u306E\u4E2D\u8EAB\u304C\u8AAD\u3081\u307E\u305B\u3093");
      if (typeof c.sub !== "string" || c.sub === "") return bad("\u672C\u4EBA\u306E ID\uFF08sub\uFF09\u304C\u3042\u308A\u307E\u305B\u3093");
      if (c.iss !== opts.issuer) return bad("\u767A\u884C\u5143\u304C\u9055\u3044\u307E\u3059");
      const aud = c.aud;
      const auds = typeof aud === "string" ? [aud] : Array.isArray(aud) ? aud : [];
      if (!auds.includes(opts.audience)) return bad("\u5B9B\u5148\u304C\u9055\u3044\u307E\u3059");
      if (typeof c.exp !== "number" || !Number.isFinite(c.exp)) return bad("\u671F\u9650\u304C\u3042\u308A\u307E\u305B\u3093");
      if (c.iat !== void 0 && (typeof c.iat !== "number" || !Number.isFinite(c.iat))) return bad("\u767A\u884C\u6642\u523B\u304C\u6B63\u3057\u304F\u3042\u308A\u307E\u305B\u3093");
      if (c.nbf !== void 0 && (typeof c.nbf !== "number" || !Number.isFinite(c.nbf))) return bad("\u958B\u59CB\u6642\u523B\u304C\u6B63\u3057\u304F\u3042\u308A\u307E\u305B\u3093");
      const nowSec = opts.now() / 1e3;
      if (nowSec > c.exp + skew) return { ok: false, code: "TOKEN_EXPIRED", message: "\u30ED\u30B0\u30A4\u30F3\u306E\u671F\u9650\u304C\u5207\u308C\u3066\u3044\u307E\u3059" };
      if (typeof c.nbf === "number" && nowSec + skew < c.nbf) return bad("\u307E\u3060\u4F7F\u3048\u306A\u3044\u30C8\u30FC\u30AF\u30F3\u3067\u3059");
      if (typeof c.iat === "number" && nowSec + skew < c.iat) return bad("\u767A\u884C\u6642\u523B\u304C\u672A\u6765\u306B\u306A\u3063\u3066\u3044\u307E\u3059");
      const start = typeof c.iat === "number" ? c.iat : nowSec;
      if (c.exp - start > maxLife) return bad("\u6709\u52B9\u671F\u9593\u304C\u9577\u3059\u304E\u308B\u30C8\u30FC\u30AF\u30F3\u3067\u3059");
      return { ok: true, claims: c };
    }
  };
}

// love-connect-hub/src/device.ts
var DEVICE_HEADER = "lch-device";
var DEVICE_PATH = "/lch/v1/device";
var DEVICE_SKEW_MS = 12e4;
var DEVICE_NONCE_MS = 3e5;
var PAIRING_TTL_MS = 3e5;
var APPROVAL_SKEW_MS = 3e5;
var DEVICE_HTTP_STATUS = Object.freeze({
  DEVICE_MISSING: 401,
  DEVICE_BAD_PROOF: 401,
  DEVICE_CLOCK: 401,
  DEVICE_UNKNOWN: 403,
  DEVICE_REPLAY: 401,
  PAIR_BAD_REQUEST: 400,
  PAIR_BAD_PROOF: 401,
  PAIR_CODE: 403,
  PAIR_ATTEST: 403
});
var enc = new TextEncoder();
var PUB_RE = /^[A-Za-z0-9_-]{87}$/;
var SIG_RE2 = /^[A-Za-z0-9_-]{86}$/;
var NONCE_RE = /^[A-Za-z0-9_-]{22}$/;
var CODE_RE = /^[A-Za-z0-9_-]{43}$/;
var TS_RE = /^[0-9]{1,16}$/;
var ECDSA = { name: "ECDSA", hash: "SHA-256" };
var subtle3 = globalThis.crypto.subtle;
async function importDevicePublicKey(pub) {
  if (!PUB_RE.test(pub)) return void 0;
  const raw = fromBase64Url(pub);
  if (raw.length !== 65 || raw[0] !== 4) return void 0;
  try {
    return await subtle3.importKey("raw", raw, { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]);
  } catch {
    return void 0;
  }
}
async function verifyDeviceSignature(pub, sig, message) {
  if (!SIG_RE2.test(sig)) return false;
  const key = await importDevicePublicKey(pub);
  if (!key) return false;
  const s2 = fromBase64Url(sig);
  if (s2.length !== 64) return false;
  return subtle3.verify(ECDSA, key, s2, enc.encode(message));
}
function deviceProofMessage(p) {
  return ["lch-device-v1", p.method.toUpperCase(), p.path, String(p.ts), p.nonce, p.tokenHash, p.bodyHash, p.pub].join("\n");
}
function pairingMessage(p) {
  return ["lch-pair-v1", p.co, p.by, p.use, p.pub, p.codeHash].join("\n");
}
async function approvalMessage(env, ts) {
  const { sig: _sig, ...rest } = env;
  return ["lch-approve-v1", env.co, env.id, await sha256Hex(canonicalJson(rest)), String(ts)].join("\n");
}
async function createWebDeviceKey(pair) {
  const kp = pair ?? await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, false, ["sign", "verify"]);
  if (kp.privateKey.extractable) throw new Error("\u7AEF\u672B\u306E\u9375\u306F\u53D6\u308A\u51FA\u305B\u306A\u3044\u5F62\uFF08extractable: false\uFF09\u3067\u4F5C\u3063\u3066\u304F\u3060\u3055\u3044");
  const pub = toBase64Url(new Uint8Array(await crypto.subtle.exportKey("raw", kp.publicKey)));
  return {
    pub,
    pair: kp,
    async sign(message) {
      return new Uint8Array(await subtle3.sign(ECDSA, kp.privateKey, message));
    }
  };
}
async function deviceProofHeader(signer, p) {
  const nonce = toBase64Url(crypto.getRandomValues(new Uint8Array(16)));
  const msg = deviceProofMessage({
    method: p.method,
    path: p.path,
    ts: p.now,
    nonce,
    tokenHash: await sha256Hex(p.token),
    bodyHash: await sha256Hex(p.body),
    pub: signer.pub
  });
  const sig = toBase64Url(await signer.sign(enc.encode(msg)));
  return `v1.${signer.pub}.${p.now}.${nonce}.${sig}`;
}
async function pairingRequest(signer, p) {
  const msg = pairingMessage({ co: p.co, by: p.by, use: p.use, pub: signer.pub, codeHash: await sha256Hex(p.code) });
  return { pub: signer.pub, use: p.use, code: p.code, sig: toBase64Url(await signer.sign(enc.encode(msg))) };
}
async function signApproval(signer, env, now) {
  return { pub: signer.pub, ts: now, sig: toBase64Url(await signer.sign(enc.encode(await approvalMessage(env, now)))) };
}
function createDeviceVerifier(opts) {
  const skew = opts.skewMs ?? DEVICE_SKEW_MS;
  const nonces = opts.nonces ?? createDedupe({ windowMs: DEVICE_NONCE_MS, capacity: 1e5 });
  const fail4 = (code, message) => ({ ok: false, code, message });
  return {
    async verify({ header, method, path, token, body, who }) {
      if (!header) return fail4("DEVICE_MISSING", "\u7AEF\u672B\u306E\u8A3C\u660E\u304C\u3042\u308A\u307E\u305B\u3093");
      const parts = header.split(".");
      if (parts.length !== 5 || parts[0] !== "v1") return fail4("DEVICE_BAD_PROOF", "\u7AEF\u672B\u306E\u8A3C\u660E\u306E\u5F62\u304C\u9055\u3044\u307E\u3059");
      const [, pub, tsText, nonce, sig] = parts;
      if (!PUB_RE.test(pub) || !TS_RE.test(tsText) || !NONCE_RE.test(nonce) || !SIG_RE2.test(sig)) {
        return fail4("DEVICE_BAD_PROOF", "\u7AEF\u672B\u306E\u8A3C\u660E\u306E\u5F62\u304C\u9055\u3044\u307E\u3059");
      }
      const ts = Number(tsText), now = opts.now();
      if (Math.abs(now - ts) > skew) return fail4("DEVICE_CLOCK", "\u7AEF\u672B\u306E\u6642\u8A08\u304C\u305A\u308C\u3066\u3044\u307E\u3059");
      const keys = await opts.directory.keys(who.co, who.by);
      if (!keys.some((k) => k.use === "device" && k.pub === pub)) return fail4("DEVICE_UNKNOWN", "\u767B\u9332\u3055\u308C\u3066\u3044\u306A\u3044\u7AEF\u672B\u3067\u3059");
      const msg = deviceProofMessage({ method, path, ts, nonce, tokenHash: await sha256Hex(token), bodyHash: await sha256Hex(body), pub });
      if (!await verifyDeviceSignature(pub, sig, msg)) return fail4("DEVICE_BAD_PROOF", "\u7AEF\u672B\u306E\u8A3C\u660E\u304C\u5408\u3044\u307E\u305B\u3093");
      if (!await nonces.first(who.co, `${who.by}\0${pub}\0${nonce}`, now)) return fail4("DEVICE_REPLAY", "\u540C\u3058\u8A3C\u660E\u304C\u4F7F\u3044\u56DE\u3055\u308C\u307E\u3057\u305F");
      return { ok: true, pub };
    }
  };
}
async function issuePairingCode(now, ttlMs = PAIRING_TTL_MS) {
  const code = toBase64Url(crypto.getRandomValues(new Uint8Array(32)));
  return { code, hash: await sha256Hex(code), expiresAt: now + ttlMs };
}
var ID_RE2 = /^[A-Za-z0-9_-]{1,64}$/;
function reply(status, body, extra) {
  return new Response(JSON.stringify(body), { status, headers: { ...SECURITY_HEADERS, ...extra } });
}
function refuse(code, message) {
  const status = DEVICE_HTTP_STATUS[code] ?? { TOKEN_MISSING: 401, TOKEN_INVALID: 401, TOKEN_EXPIRED: 401, USER_FORBIDDEN: 403, NOT_FOUND: 404, CONTENT_TYPE: 415, TOO_LARGE: 413, BAD_JSON: 400, HANDLER: 500 }[code] ?? 400;
  const extra = status === 401 && code.startsWith("TOKEN_") ? { "www-authenticate": `Bearer error="${code === "TOKEN_MISSING" ? "invalid_request" : "invalid_token"}"` } : void 0;
  return reply(status, { ok: false, code, message }, extra);
}
function createDeviceEnrollment(opts) {
  const path = opts.path ?? DEVICE_PATH;
  return async (req) => {
    const url = new URL(req.url);
    if (url.pathname !== path) return refuse("NOT_FOUND", "\u5165\u53E3\u304C\u9055\u3044\u307E\u3059");
    if (req.method !== "POST") return new Response(null, { status: 405, headers: { ...SECURITY_HEADERS, allow: "POST" } });
    const type = (req.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase();
    if (type !== "application/json") return refuse("CONTENT_TYPE", "application/json \u3067\u9001\u3063\u3066\u304F\u3060\u3055\u3044");
    const t = await opts.verifier.verify(bearerToken(req.headers.get("authorization")));
    if (!t.ok) return refuse(t.code, t.message);
    let who;
    try {
      who = await opts.identify(t.claims);
    } catch (error) {
      opts.onError?.({ error });
      return refuse("HANDLER", "\u51E6\u7406\u4E2D\u306B\u554F\u984C\u304C\u8D77\u304D\u307E\u3057\u305F");
    }
    if (!who || !ID_RE2.test(who.co) || !ID_RE2.test(who.by)) return refuse("USER_FORBIDDEN", "\u3053\u306E\u5229\u7528\u8005\u306F\u4F7F\u3048\u307E\u305B\u3093");
    const raw = await readLimited(req, 16384);
    if (raw === void 0) return refuse("TOO_LARGE", "\u53D7\u3051\u53D6\u308C\u308B\u5927\u304D\u3055\u3092\u8D85\u3048\u3066\u3044\u307E\u3059");
    let o;
    try {
      o = JSON.parse(raw);
    } catch {
      return refuse("BAD_JSON", "JSON \u3068\u3057\u3066\u8AAD\u3081\u307E\u305B\u3093");
    }
    if (typeof o !== "object" || o === null || Array.isArray(o) || Object.keys(o).some((k) => !["pub", "use", "code", "sig", "att"].includes(k))) {
      return refuse("PAIR_BAD_REQUEST", "\u767B\u9332\u306E\u5F62\u304C\u9055\u3044\u307E\u3059");
    }
    const { pub, use, code, sig, att } = o;
    if (typeof pub !== "string" || !PUB_RE.test(pub) || use !== "device" && use !== "approve" || typeof code !== "string" || !CODE_RE.test(code) || typeof sig !== "string") {
      return refuse("PAIR_BAD_REQUEST", "\u767B\u9332\u306E\u5F62\u304C\u9055\u3044\u307E\u3059");
    }
    const codeHash = await sha256Hex(code);
    if (!await verifyDeviceSignature(pub, sig, pairingMessage({ co: who.co, by: who.by, use, pub, codeHash }))) {
      return refuse("PAIR_BAD_PROOF", "\u9375\u3092\u6301\u3063\u3066\u3044\u308B\u8A3C\u660E\u304C\u5408\u3044\u307E\u305B\u3093");
    }
    if (opts.attest) {
      let a;
      try {
        a = await opts.attest({ who, pub, use, att });
      } catch (error) {
        opts.onError?.({ error });
        return refuse("HANDLER", "\u51E6\u7406\u4E2D\u306B\u554F\u984C\u304C\u8D77\u304D\u307E\u3057\u305F");
      }
      if (!a.ok) return reply(403, { ok: false, code: "PAIR_ATTEST", reason: a.code, message: a.message });
    }
    try {
      if (!await opts.store.take(who.co, who.by, codeHash, opts.now())) return refuse("PAIR_CODE", "\u5408\u8A00\u8449\u304C\u9055\u3046\u304B\u3001\u671F\u9650\u304C\u5207\u308C\u3066\u3044\u307E\u3059");
      await opts.store.add(who.co, who.by, { pub, use });
    } catch (error) {
      opts.onError?.({ error });
      return refuse("HANDLER", "\u51E6\u7406\u4E2D\u306B\u554F\u984C\u304C\u8D77\u304D\u307E\u3057\u305F");
    }
    return reply(200, { ok: true, pub, use });
  };
}
async function verifyApproval(p) {
  const a = p.approval;
  if (!a || typeof a.pub !== "string" || typeof a.sig !== "string" || !Number.isSafeInteger(a.ts)) return { ok: false, code: "APPROVAL_BAD", message: "\u627F\u8A8D\u306E\u5F62\u304C\u9055\u3044\u307E\u3059" };
  if (p.approver.co !== p.env.co) return { ok: false, code: "APPROVAL_UNKNOWN", message: "\u5225\u306E\u4F1A\u793E\u306E\u627F\u8A8D\u3067\u3059" };
  if (Math.abs(p.now - a.ts) > (p.skewMs ?? APPROVAL_SKEW_MS)) return { ok: false, code: "APPROVAL_CLOCK", message: "\u627F\u8A8D\u306E\u6642\u523B\u304C\u305A\u308C\u3066\u3044\u307E\u3059" };
  const keys = await p.directory.keys(p.approver.co, p.approver.by);
  if (!keys.some((k) => k.use === "approve" && k.pub === a.pub)) return { ok: false, code: "APPROVAL_UNKNOWN", message: "\u767B\u9332\u3055\u308C\u3066\u3044\u306A\u3044\u627F\u8A8D\u306E\u9375\u3067\u3059" };
  if (!await verifyDeviceSignature(a.pub, a.sig, await approvalMessage(p.env, a.ts))) return { ok: false, code: "APPROVAL_BAD", message: "\u627F\u8A8D\u306E\u7F72\u540D\u304C\u5408\u3044\u307E\u305B\u3093" };
  return { ok: true };
}

// love-connect-hub/src/user.ts
var USER_PATH = "/lch/v1/user";
var DRAFT_FIELDS = /* @__PURE__ */ new Set(["v", "l", "f", "id", "tk", "c", "dl", "ap", "ret", "sq", "bv", "ref", "len", "h", "b"]);
var STAMPED_FIELDS = /* @__PURE__ */ new Set(["co", "by", "at", "sig", "e"]);
var USER_FORBIDDEN_LANES = /* @__PURE__ */ new Set(["key"]);
var USER_HTTP_STATUS = Object.freeze({
  ...HTTP_STATUS,
  TOKEN_MISSING: 401,
  TOKEN_INVALID: 401,
  TOKEN_EXPIRED: 401,
  ...DEVICE_HTTP_STATUS,
  USER_FORBIDDEN: 403,
  STAMPED_FIELD: 400,
  LANE_NOT_ALLOWED: 403,
  SERVER_KEY: 500
});
function json2(status, body, extra) {
  return new Response(JSON.stringify(body), { status, headers: { ...SECURITY_HEADERS, ...extra } });
}
function reject2(code, field, message) {
  const status = USER_HTTP_STATUS[code] ?? 400;
  const extra = status === 401 ? { "www-authenticate": `Bearer error="${code === "TOKEN_MISSING" ? "invalid_request" : "invalid_token"}"` } : void 0;
  return json2(status, { ok: false, code, field, message }, extra);
}
var ID_RE3 = /^[A-Za-z0-9_-]{1,64}$/;
function checkDraft(input) {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    return { ok: false, code: "NOT_OBJECT", field: "", message: "\u4E0B\u66F8\u304D\u306E\u5F62\u3067\u306F\u3042\u308A\u307E\u305B\u3093" };
  }
  for (const k of Object.keys(input)) {
    if (STAMPED_FIELDS.has(k)) return { ok: false, code: "STAMPED_FIELD", field: k, message: `\u3053\u306E\u9805\u76EE\u306F\u571F\u53F0\u304C\u4ED8\u3051\u307E\u3059\uFF1A${k}` };
    if (!DRAFT_FIELDS.has(k)) return { ok: false, code: "UNKNOWN_FIELD", field: k, message: `\u898F\u683C\u306B\u7121\u3044\u9805\u76EE\u3067\u3059\uFF1A${k}` };
  }
  const o = input;
  if (typeof o.v !== "number" || !SPEC_VERSIONS.includes(o.v)) return { ok: false, code: "BAD_VERSION", field: "v", message: "\u5BFE\u5FDC\u3057\u3066\u3044\u306A\u3044\u898F\u683C\u7248\u3067\u3059" };
  if (o.tk !== void 0) {
    if (o.v < 2) return { ok: false, code: "UNKNOWN_FIELD", field: "tk", message: "\u4F5C\u696D ID\uFF08tk\uFF09\u306F\u7B2C2\u7248\u306E\u4E0B\u66F8\u304D\u3060\u3051\u306B\u4ED8\u3051\u3089\u308C\u307E\u3059" };
    if (typeof o.tk !== "string" || !TASK_ID_RE.test(o.tk)) return { ok: false, code: "BAD_FIELD", field: "tk", message: "\u4F5C\u696D ID \u306F w- \u3068\u82F1\u6570\u5B57 8 \u6587\u5B57\u3067\u3059\uFF08\u4F8B w-a1B2c3D4\uFF09" };
  }
  if (o.c !== void 0 && !(o.c === 0 || o.c === 1 || o.c === 2 || o.c === 3)) {
    return { ok: false, code: "BAD_FIELD", field: "c", message: "\u6A5F\u5BC6\u5EA6\u306F 0\u301C3 \u3067\u3059" };
  }
  if (!isLane(o.l)) return { ok: false, code: "BAD_LANE", field: "l", message: "\u898F\u683C\u306B\u7121\u3044\u30EC\u30FC\u30F3\u3067\u3059" };
  if (USER_FORBIDDEN_LANES.has(o.l)) return { ok: false, code: "LANE_NOT_ALLOWED", field: "l", message: "\u3053\u306E\u30EC\u30FC\u30F3\u306F\u5229\u7528\u8005\u306E\u53E3\u304B\u3089\u4F7F\u3048\u307E\u305B\u3093" };
  if (o.id === void 0) return { ok: false, code: "MISSING_FIELD", field: "id", message: "\u4E00\u610F\u306E\u756A\u53F7\uFF08id\uFF09\u306F\u9001\u308A\u624B\u304C\u4ED8\u3051\u307E\u3059" };
  return { ok: true, draft: o };
}
function createUserGateway(opts) {
  const path = opts.path ?? USER_PATH;
  const dedupe = opts.dedupe ?? createDedupe({ windowMs: 864e5, capacity: 1e4 });
  return async (req) => {
    const url = new URL(req.url);
    if (url.pathname !== path) return reject2("NOT_FOUND", "", "\u5165\u53E3\u304C\u9055\u3044\u307E\u3059");
    if (req.method !== "POST") return new Response(null, { status: 405, headers: { ...SECURITY_HEADERS, allow: "POST" } });
    const type = (req.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase();
    if (type !== "application/json") return reject2("CONTENT_TYPE", "", "application/json \u3067\u9001\u3063\u3066\u304F\u3060\u3055\u3044");
    const t = await opts.verifier.verify(bearerToken(req.headers.get("authorization")));
    if (!t.ok) return reject2(t.code, "authorization", t.message);
    let who;
    try {
      who = await opts.identify(t.claims);
    } catch (error) {
      opts.onError?.({ id: "", lane: "", error });
      return reject2("HANDLER", "", "\u51E6\u7406\u4E2D\u306B\u554F\u984C\u304C\u8D77\u304D\u307E\u3057\u305F");
    }
    if (!who || !ID_RE3.test(who.co) || !ID_RE3.test(who.by)) return reject2("USER_FORBIDDEN", "", "\u3053\u306E\u5229\u7528\u8005\u306F\u4F7F\u3048\u307E\u305B\u3093");
    const raw = await readLimited(req, RAW_MAX_BYTES);
    if (raw === void 0) return reject2("TOO_LARGE", "", "\u53D7\u3051\u53D6\u308C\u308B\u5927\u304D\u3055\u3092\u8D85\u3048\u3066\u3044\u307E\u3059");
    if (opts.device) {
      const token = bearerToken(req.headers.get("authorization")) ?? "";
      const dv = await opts.device.verify({ header: req.headers.get(DEVICE_HEADER), method: req.method, path: url.pathname, token, body: raw, who });
      if (!dv.ok) return reject2(dv.code, DEVICE_HEADER, dv.message);
    }
    let input;
    try {
      input = JSON.parse(raw);
    } catch {
      return reject2("BAD_JSON", "", "JSON \u3068\u3057\u3066\u8AAD\u3081\u307E\u305B\u3093");
    }
    const d = checkDraft(input);
    if (!d.ok) return reject2(d.code, d.field, d.message);
    const draft = d.draft;
    const allowed = opts.formats[draft.l];
    if (typeof draft.f !== "string" || !allowed || !allowed.has(draft.f)) return reject2("FORMAT_NOT_ALLOWED", "f", "\u8A31\u53EF\u3055\u308C\u3066\u3044\u306A\u3044\u5F62\u5F0F\u3067\u3059");
    const c = draft.c ?? LANES[draft.l].minClass;
    const signingKey = await opts.signingKey?.(who.co);
    const sealKey = c === 3 && draft.b !== void 0 ? await opts.sealKey?.(who.co) : void 0;
    if (c >= 2 && !signingKey) return reject2("SERVER_KEY", "sig", "\u3053\u306E\u4F1A\u793E\u306F\u6A5F\u5BC6\u4EE5\u4E0A\u3092\u53D7\u3051\u4ED8\u3051\u308B\u8A2D\u5B9A\u304C\u3042\u308A\u307E\u305B\u3093");
    if (c === 3 && draft.b !== void 0 && !sealKey) return reject2("SERVER_KEY", "e", "\u3053\u306E\u4F1A\u793E\u306F\u6975\u79D8\u306E\u672C\u6587\u3092\u53D7\u3051\u4ED8\u3051\u308B\u8A2D\u5B9A\u304C\u3042\u308A\u307E\u305B\u3093");
    const sender = createSender({
      co: who.co,
      by: who.by,
      now: opts.now,
      ...signingKey ? { signingKey } : {},
      ...sealKey ? { sealKey } : {}
    });
    let env;
    try {
      const { v: _v, l, f, ...rest } = draft;
      env = await sender.make(l, f, { ...rest, c });
    } catch (e) {
      if (e instanceof SendError) {
        const code = e.code in USER_HTTP_STATUS ? e.code : "BAD_FIELD";
        return reject2(code, e.field, e.message);
      }
      throw e;
    }
    const r = checkEnvelope(env, { formats: opts.formats });
    if (!r.ok) return reject2(r.code, r.field, r.message);
    if (!await dedupe.first(who.co, `${who.by}\0${env.id}`, opts.now())) {
      return reject2("DUPLICATE", "id", "\u540C\u3058\u756A\u53F7\u306E\u4E0B\u66F8\u304D\u3092\u53D7\u3051\u53D6\u308A\u6E08\u307F\u3067\u3059");
    }
    try {
      const reply2 = await opts.onEnvelope(env, who);
      const body = { ok: true, id: env.id, at: env.at };
      if (reply2 !== void 0) body.b = reply2;
      return json2(reply2 === void 0 ? 202 : 200, body);
    } catch (error) {
      opts.onError?.({ id: env.id, lane: env.l, error });
      return reject2("HANDLER", "", "\u51E6\u7406\u4E2D\u306B\u554F\u984C\u304C\u8D77\u304D\u307E\u3057\u305F");
    }
  };
}
function createUserClient(opts) {
  const u = new URL(opts.url);
  const local = u.hostname === "localhost" || u.hostname === "127.0.0.1";
  if (u.protocol !== "https:" && !(local && u.protocol === "http:")) throw new Error("\u9001\u308A\u5148\u306F https \u306B\u3057\u3066\u304F\u3060\u3055\u3044");
  const doFetch = opts.fetch ?? ((r) => fetch(r));
  return {
    async send(input) {
      const draft = { v: versionFor(input.tk), ...input, id: input.id ?? randomId() };
      const body = JSON.stringify(draft);
      const dl = draft.dl ?? LANES[draft.l].deadlineMs;
      const start = opts.now();
      let refreshed = false;
      let lastCode;
      const res = await withRetry(
        async () => {
          for (; ; ) {
            const token = await opts.token(refreshed);
            const headers = { "content-type": "application/json", authorization: `Bearer ${token}` };
            if (opts.device) headers[DEVICE_HEADER] = await deviceProofHeader(opts.device, { method: "POST", path: u.pathname, token, body, now: opts.now() });
            const resp = await doFetch(new Request(u, { method: "POST", headers, body }));
            let data = {};
            try {
              data = await resp.json();
            } catch {
            }
            lastCode = data.code;
            if (resp.status === 401 && data.code === "TOKEN_EXPIRED" && !refreshed) {
              refreshed = true;
              continue;
            }
            if (resp.status === 409 && data.code === "DUPLICATE") return { status: 200, value: { status: 409, id: draft.id, duplicate: true } };
            if (resp.status >= 200 && resp.status <= 299) {
              const value = { status: resp.status, id: draft.id, duplicate: false };
              if (typeof data.at === "number") value.at = data.at;
              if (data.b !== void 0) value.b = data.b;
              return { status: resp.status, value };
            }
            const ra = Number(resp.headers.get("retry-after") ?? "NaN");
            return Number.isFinite(ra) ? { status: resp.status, retryAfterSec: ra } : { status: resp.status };
          }
        },
        { ...opts, ...dl > 0 ? { deadlineAt: start + dl } : {} }
      );
      if (res.ok) return { ok: true, ...res.value, attempts: res.attempts };
      return lastCode ? { ok: false, status: res.status, code: lastCode, attempts: res.attempts } : { ok: false, status: res.status, attempts: res.attempts };
    }
  };
}

// love-connect-hub/src/hub.ts
var HUB_RE = /^[a-z][a-z0-9]{0,31}$/;
var FORMAT_RE2 = /^[a-z][a-z0-9]*(?:\.[a-z0-9][a-z0-9_-]*){1,7}$/;
function laneOf(f) {
  const lane = f.split(".")[0];
  if (!FORMAT_RE2.test(f) || !isLane(lane)) throw new Error(`\u5F62\u5F0F\u306E\u540D\u524D\u304C\u6B63\u3057\u304F\u3042\u308A\u307E\u305B\u3093\uFF1A${f}`);
  return lane;
}
function add(t, f) {
  const lane = laneOf(f);
  (t[lane] ??= /* @__PURE__ */ new Set()).add(f);
}
function buildHubTables(hubs) {
  const all = {};
  const user = {};
  const owner = /* @__PURE__ */ new Map();
  const subs = /* @__PURE__ */ new Map();
  const ids = /* @__PURE__ */ new Set();
  for (const h of hubs) {
    if (!HUB_RE.test(h.hub)) throw new Error(`\u30CF\u30D6 ID \u304C\u6B63\u3057\u304F\u3042\u308A\u307E\u305B\u3093\uFF1A${h.hub}`);
    if (ids.has(h.hub)) throw new Error(`\u30CF\u30D6 ID \u304C\u91CD\u8907\u3057\u3066\u3044\u307E\u3059\uFF1A${h.hub}`);
    ids.add(h.hub);
    for (const f of h.emits ?? []) {
      laneOf(f);
      if (f.split(".")[1] !== h.hub) throw new Error(`\u30CF\u30D6\u300C${h.hub}\u300D\u306F\u81EA\u5206\u306E\u5F62\u5F0F\u3060\u3051\u3092\u51FA\u305B\u307E\u3059\uFF1A${f}`);
      if (owner.has(f)) throw new Error(`\u5F62\u5F0F\u304C\u91CD\u8907\u3057\u3066\u3044\u307E\u3059\uFF1A${f}`);
      owner.set(f, h.hub);
      add(all, f);
    }
  }
  for (const h of hubs) {
    const mine = new Set(h.emits ?? []);
    for (const f of h.accepts ?? []) {
      laneOf(f);
      const o = owner.get(f);
      if (!o) throw new Error(`\u8AB0\u3082\u51FA\u3055\u306A\u3044\u5F62\u5F0F\u306F\u53D7\u3051\u53D6\u308C\u307E\u305B\u3093\uFF1A${f}\uFF08${h.hub}\uFF09`);
      if (o === h.hub) continue;
      const list = subs.get(f) ?? [];
      if (!list.includes(h.hub)) list.push(h.hub);
      subs.set(f, list);
    }
    for (const f of h.user ?? []) {
      if (!mine.has(f)) throw new Error(`\u81EA\u5206\u304C\u51FA\u3055\u306A\u3044\u5F62\u5F0F\u306F\u5229\u7528\u8005\u306E\u53E3\u306B\u958B\u3051\u307E\u305B\u3093\uFF1A${f}\uFF08${h.hub}\uFF09`);
      if (laneOf(f) === "key") throw new Error(`\u9375\u30EC\u30FC\u30F3\u306F\u5229\u7528\u8005\u306E\u53E3\u306B\u958B\u3051\u307E\u305B\u3093\uFF1A${f}`);
      add(user, f);
    }
  }
  return { all, user, owner, subscribers: subs };
}

// love-connect-hub/src/keys.ts
var ENV_RE = /^[A-Z][A-Z0-9_]{1,63}$/;
var UT_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;
function parseKeyRef(ref) {
  const i = ref.indexOf(":");
  const store = i > 0 ? ref.slice(0, i) : "";
  const name = i > 0 ? ref.slice(i + 1) : "";
  if (store === "env" && ENV_RE.test(name)) return { store, name };
  if (store === "ut" && UT_RE.test(name)) return { store, name };
  throw new Error(`\u9375\u306E\u53C2\u7167\u306E\u5F62\u304C\u6B63\u3057\u304F\u3042\u308A\u307E\u305B\u3093\uFF08env:\u5927\u6587\u5B57\u306E\u540D\u524D \u304B ut:\u30AB\u30C6\u30B4\u30EA\uFF09\uFF1A${ref.slice(0, 80)}`);
}
function envOnly(refs, what) {
  return refs.map((r) => {
    const k = parseKeyRef(r);
    if (k.store !== "env") throw new Error(`${what}\u306F\u571F\u53F0\u306E\u79D8\u5BC6\u306E\u5024\uFF08env:\uFF09\u306B\u3060\u3051\u7F6E\u3051\u307E\u3059\uFF1A${r}`);
    return k.name;
  });
}
function createCompanyKeys(opts) {
  const signing = new Map(Object.entries(opts.signing).map(([co, refs]) => [co, envOnly(refs, "\u7F72\u540D\u7528\u306E\u9375")]));
  const seal = new Map(Object.entries(opts.seal ?? {}).map(([co, refs]) => [co, envOnly(refs, "\u6697\u53F7\u5316\u7528\u306E\u9375")]));
  const cache = /* @__PURE__ */ new Map();
  async function load(name, kind) {
    const raw = opts.read(name);
    if (raw === void 0 || raw === "") return void 0;
    const fp = await sha256Hex(`${kind}|${raw}`);
    const hit = cache.get(`${kind}|${name}`);
    if (hit && hit.fp === fp) return hit.key;
    let bytes;
    try {
      bytes = fromBase64Url(raw.trim());
    } catch {
      throw new Error(`\u79D8\u5BC6\u306E\u5024\u306E\u5F62\u304C\u6B63\u3057\u304F\u3042\u308A\u307E\u305B\u3093\uFF08base64url\uFF09\uFF1A${name}`);
    }
    const key = kind === "sign" ? await importSigningKey(bytes) : await importSealKey(bytes);
    bytes.fill(0);
    cache.set(`${kind}|${name}`, { fp, key });
    return key;
  }
  async function all(names, kind) {
    const out = [];
    for (const n2 of names ?? []) {
      const k = await load(n2, kind);
      if (k) out.push(k);
    }
    return out;
  }
  return {
    async signingKey(co) {
      const first = signing.get(co)?.[0];
      return first ? load(first, "sign") : void 0;
    },
    verifyKeys: (co) => all(signing.get(co), "sign"),
    async sealKey(co) {
      const first = seal.get(co)?.[0];
      return first ? load(first, "seal") : void 0;
    },
    openKeys: (co) => all(seal.get(co), "seal")
  };
}
async function callWithKey(ref, broker, op, args) {
  const k = parseKeyRef(ref);
  if (k.store !== "ut") throw new Error("\u4EE3\u7406\u5B9F\u884C\u306B\u4F7F\u3048\u308B\u306E\u306F ut: \u306E\u53C2\u7167\u3060\u3051\u3067\u3059");
  return broker.call(k.name, op, args);
}

// love-connect-hub/src/asn1.ts
var DerError = class extends Error {
};
function readDer(buf, offset = 0) {
  let i = offset;
  const need = (n2) => {
    if (i + n2 > buf.length) throw new DerError("\u9014\u4E2D\u3067\u5207\u308C\u3066\u3044\u307E\u3059");
  };
  need(2);
  const first = buf[i++];
  const cls = first >> 6;
  const constructed = (first & 32) !== 0;
  let tag = first & 31;
  if (tag === 31) {
    tag = 0;
    for (let n2 = 0; ; n2++) {
      need(1);
      const b = buf[i++];
      if (n2 === 0 && b === 128) throw new DerError("\u30BF\u30B0\u306E\u66F8\u304D\u65B9\u304C\u9055\u3044\u307E\u3059");
      tag = tag * 128 + (b & 127);
      if (tag > 16777215) throw new DerError("\u30BF\u30B0\u304C\u5927\u304D\u3059\u304E\u307E\u3059");
      if ((b & 128) === 0) break;
    }
  }
  need(1);
  let len = buf[i++];
  if (len & 128) {
    const n2 = len & 127;
    if (n2 === 0 || n2 > 4) throw new DerError("\u9577\u3055\u306E\u66F8\u304D\u65B9\u304C\u9055\u3044\u307E\u3059");
    need(n2);
    len = 0;
    for (let k = 0; k < n2; k++) len = len * 256 + buf[i++];
  }
  need(len);
  const value = buf.subarray(i, i + len);
  return { der: { cls, constructed, tag, raw: buf.subarray(offset, i + len), value }, end: i + len };
}
function derChildren(d) {
  if (!d.constructed) throw new DerError("\u5165\u308C\u5B50\u3067\u306F\u3042\u308A\u307E\u305B\u3093");
  const out = [];
  let i = 0;
  while (i < d.value.length) {
    const r = readDer(d.value, i);
    out.push(r.der);
    i = r.end;
  }
  return out;
}
function parseDer(buf) {
  const r = readDer(buf, 0);
  if (r.end !== buf.length) throw new DerError("\u5F8C\u308D\u306B\u4F59\u8A08\u306A\u3082\u306E\u304C\u3042\u308A\u307E\u3059");
  return r.der;
}
function expectTag(d, tag, cls = 0) {
  if (!d || d.tag !== tag || d.cls !== cls) throw new DerError(`\u5F62\u304C\u9055\u3044\u307E\u3059\uFF08${cls}:${tag} \u306E\u306F\u305A\uFF09`);
  return d;
}
function derOid(d) {
  expectTag(d, 6);
  const v = d.value;
  if (v.length === 0) throw new DerError("OID \u304C\u7A7A\u3067\u3059");
  const parts = [];
  let n2 = 0;
  for (let k = 0; k < v.length; k++) {
    n2 = n2 * 128 + (v[k] & 127);
    if ((v[k] & 128) === 0) {
      if (parts.length === 0) parts.push(n2 < 80 ? Math.floor(n2 / 40) : 2, n2 < 80 ? n2 % 40 : n2 - 80);
      else parts.push(n2);
      n2 = 0;
    }
  }
  return parts.join(".");
}
function derInt(d) {
  if (!(d.cls === 0 && (d.tag === 2 || d.tag === 10))) throw new DerError("\u6574\u6570\u3067\u306F\u3042\u308A\u307E\u305B\u3093");
  if (d.value.length === 0 || d.value.length > 7) throw new DerError("\u6574\u6570\u306E\u5927\u304D\u3055\u304C\u9055\u3044\u307E\u3059");
  let n2 = d.value[0] & 128 ? -1 : 0;
  for (const b of d.value) n2 = n2 * 256 + b;
  if (!Number.isSafeInteger(n2)) throw new DerError("\u6574\u6570\u304C\u5927\u304D\u3059\u304E\u307E\u3059");
  return n2;
}
function derIntHex(d) {
  expectTag(d, 2);
  let v = d.value;
  while (v.length > 1 && v[0] === 0) v = v.subarray(1);
  return Array.from(v, (b) => b.toString(16).padStart(2, "0")).join("");
}
function derBool(d) {
  expectTag(d, 1);
  if (d.value.length !== 1) throw new DerError("\u771F\u507D\u306E\u5F62\u304C\u9055\u3044\u307E\u3059");
  return d.value[0] !== 0;
}
function derBits(d) {
  expectTag(d, 3);
  if (d.value.length === 0 || d.value[0] !== 0) throw new DerError("\u30D3\u30C3\u30C8\u5217\u306E\u5F62\u304C\u9055\u3044\u307E\u3059");
  return d.value.subarray(1);
}
function derTime(d) {
  const s2 = new TextDecoder().decode(d.value);
  let m;
  if (d.tag === 23 && (m = s2.match(/^(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})Z$/))) {
    const y = Number(m[1]);
    return Date.UTC(y < 50 ? 2e3 + y : 1900 + y, Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]), Number(m[6]));
  }
  if (d.tag === 24 && (m = s2.match(/^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})Z$/))) {
    return Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]), Number(m[6]));
  }
  throw new DerError("\u6642\u523B\u306E\u5F62\u304C\u9055\u3044\u307E\u3059");
}

// love-connect-hub/src/x509.ts
function parseCert(raw) {
  const [tbsD, algD, sigD] = derChildren(expectTag(parseDer(raw), 16));
  const tbs = derChildren(expectTag(tbsD, 16));
  let k = 0;
  if (tbs[0] && tbs[0].cls === 2 && tbs[0].tag === 0) k++;
  const serial = derIntHex(tbs[k++]);
  k++;
  k++;
  const [nb, na] = derChildren(expectTag(tbs[k++], 16));
  k++;
  const spkiD = expectTag(tbs[k++], 16);
  const [spkiAlgD] = derChildren(spkiD);
  const spkiAlgParts = derChildren(expectTag(spkiAlgD, 16));
  const spkiAlg = derOid(spkiAlgParts[0]);
  const spkiCurve = spkiAlgParts[1] && spkiAlgParts[1].tag === 6 ? derOid(spkiAlgParts[1]) : void 0;
  const extensions = /* @__PURE__ */ new Map();
  for (; k < tbs.length; k++) {
    const d = tbs[k];
    if (d.cls === 2 && d.tag === 3) {
      for (const ext of derChildren(expectTag(derChildren(d)[0], 16))) {
        const parts = derChildren(expectTag(ext, 16));
        const oid = derOid(parts[0]);
        const val = expectTag(parts[parts.length - 1], 4).value;
        if (extensions.has(oid)) throw new DerError("\u540C\u3058\u62E1\u5F35\u304C 2 \u3064\u3042\u308A\u307E\u3059");
        extensions.set(oid, val);
      }
    }
  }
  const out = {
    tbs: tbsD.raw,
    sigAlg: derOid(derChildren(expectTag(algD, 16))[0]),
    sig: derBits(sigD),
    serial,
    notBefore: derTime(nb),
    notAfter: derTime(na),
    spki: spkiD.raw,
    spkiAlg,
    extensions
  };
  if (spkiCurve) out.spkiCurve = spkiCurve;
  return out;
}
var SIG_ALGS = {
  "1.2.840.10045.4.3.2": { kind: "ecdsa", hash: "SHA-256" },
  "1.2.840.10045.4.3.3": { kind: "ecdsa", hash: "SHA-384" },
  "1.2.840.10045.4.3.4": { kind: "ecdsa", hash: "SHA-512" },
  "1.2.840.113549.1.1.11": { kind: "rsa", hash: "SHA-256" },
  "1.2.840.113549.1.1.12": { kind: "rsa", hash: "SHA-384" },
  "1.2.840.113549.1.1.13": { kind: "rsa", hash: "SHA-512" }
};
var CURVES = {
  "1.2.840.10045.3.1.7": { name: "P-256", size: 32 },
  "1.3.132.0.34": { name: "P-384", size: 48 },
  "1.3.132.0.35": { name: "P-521", size: 66 }
};
function ecdsaRaw(der, size) {
  const [r, s2] = derChildren(expectTag(parseDer(der), 16));
  const out = new Uint8Array(size * 2);
  [r, s2].forEach((d, i) => {
    let v = expectTag(d, 2).value;
    while (v.length > size && v[0] === 0) v = v.subarray(1);
    if (v.length > size) throw new DerError("\u7F72\u540D\u306E\u5927\u304D\u3055\u304C\u9055\u3044\u307E\u3059");
    out.set(v, i * size + (size - v.length));
  });
  return out;
}
var subtle4 = globalThis.crypto.subtle;
async function signedBy(child, issuer) {
  const alg = SIG_ALGS[child.sigAlg];
  if (!alg) return false;
  try {
    if (alg.kind === "rsa") {
      if (issuer.spkiAlg !== "1.2.840.113549.1.1.1") return false;
      const key2 = await subtle4.importKey("spki", issuer.spki, { name: "RSASSA-PKCS1-v1_5", hash: alg.hash }, false, ["verify"]);
      return await subtle4.verify("RSASSA-PKCS1-v1_5", key2, child.sig, child.tbs);
    }
    const curve = issuer.spkiAlg === "1.2.840.10045.2.1" && issuer.spkiCurve ? CURVES[issuer.spkiCurve] : void 0;
    if (!curve) return false;
    const key = await subtle4.importKey("spki", issuer.spki, { name: "ECDSA", namedCurve: curve.name }, false, ["verify"]);
    return await subtle4.verify({ name: "ECDSA", hash: alg.hash }, key, ecdsaRaw(child.sig, curve.size), child.tbs);
  } catch {
    return false;
  }
}
async function verifyChain(certs, now) {
  for (let i = 0; i < certs.length; i++) {
    const c = certs[i];
    if (now < c.notBefore || now > c.notAfter) return "time";
    if (!await signedBy(c, certs[Math.min(i + 1, certs.length - 1)])) return "signature";
  }
  return "ok";
}
function p256PublicKeyOf(c) {
  if (c.spkiAlg !== "1.2.840.10045.2.1" || c.spkiCurve !== "1.2.840.10045.3.1.7") return void 0;
  const [, bitsD] = derChildren(parseDer(c.spki));
  const raw = derBits(bitsD);
  return raw.length === 65 && raw[0] === 4 ? raw : void 0;
}

// love-connect-hub/src/attestation.ts
var GOOGLE_ATTESTATION_ROOTS = Object.freeze([
  "feb2ea7551ee316ed4bb443c8293b884dbfdea40b603ee3e4f4a897e4580fbae",
  "3ee44512a1af2beb39c889490c60ea3f82e43f5d5a5532f5ab9419f676cd07ec"
]);
var KEY_DESCRIPTION_OID = "1.3.6.1.4.1.11129.2.1.17";
var enc2 = new TextEncoder();
async function attestationChallenge(co, by) {
  const hex = await sha256Hex(`lch-attest-v1
${co}
${by}`);
  return Uint8Array.from(hex.match(/../g), (h) => parseInt(h, 16));
}
function authorizations(d) {
  const out = { purpose: [], noAuthRequired: false, unlockedDeviceRequired: false };
  for (const f of derChildren(expectTag(d, 16))) {
    if (f.cls !== 2) throw new DerError("\u9375\u306E\u6027\u8CEA\u306E\u5F62\u304C\u9055\u3044\u307E\u3059");
    const inner = derChildren(f)[0];
    switch (f.tag) {
      case 1:
        out.purpose = derChildren(expectTag(inner, 17)).map(derInt);
        break;
      case 2:
        out.algorithm = derInt(inner);
        break;
      case 10:
        out.ecCurve = derInt(inner);
        break;
      case 503:
        out.noAuthRequired = true;
        break;
      case 504:
        out.userAuthType = derInt(inner);
        break;
      case 505:
        out.authTimeout = derInt(inner);
        break;
      case 509:
        out.unlockedDeviceRequired = true;
        break;
      case 702:
        out.origin = derInt(inner);
        break;
      case 704: {
        const r = derChildren(expectTag(inner, 16));
        out.rootOfTrust = { deviceLocked: derBool(r[1]), verifiedBootState: derInt(r[2]) };
        break;
      }
      case 709:
        out.attestationApplicationId = expectTag(inner, 4).value;
        break;
      default:
        break;
    }
  }
  return out;
}
function parseKeyDescription(ext) {
  const f = derChildren(expectTag(parseDer(ext), 16));
  if (f.length < 8) throw new DerError("\u9375\u306E\u8A18\u8FF0\u306E\u5F62\u304C\u9055\u3044\u307E\u3059");
  return {
    attestationVersion: derInt(f[0]),
    attestationSecurityLevel: derInt(f[1]),
    keyMintSecurityLevel: derInt(f[3]),
    challenge: expectTag(f[4], 4).value,
    software: authorizations(f[6]),
    hardware: authorizations(f[7])
  };
}
function parseApplicationId(raw) {
  const [infos, digests] = derChildren(expectTag(parseDer(raw), 16));
  const packages = derChildren(expectTag(infos, 17)).map((p) => new TextDecoder().decode(expectTag(derChildren(expectTag(p, 16))[0], 4).value));
  const signatureDigests = derChildren(expectTag(digests, 17)).map((d) => Array.from(expectTag(d, 4).value, (b) => b.toString(16).padStart(2, "0")).join(""));
  return { packages, signatureDigests };
}
var fail2 = (code, message) => ({ ok: false, code, message });
function decodeDer(s2) {
  return fromBase64Url(s2.replace(/\s+/g, "").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, ""));
}
function p256Spki(pubRaw) {
  const head = Uint8Array.from([48, 89, 48, 19, 6, 7, 42, 134, 72, 206, 61, 2, 1, 6, 8, 42, 134, 72, 206, 61, 3, 1, 7, 3, 66, 0]);
  const out = new Uint8Array(head.length + pubRaw.length);
  out.set(head);
  out.set(pubRaw, head.length);
  return out;
}
var eq = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);
async function verifyAndroidAttestation(o) {
  let certs;
  try {
    if (!Array.isArray(o.chain) || o.chain.length < 2 || o.chain.length > 10) return fail2("ATTEST_BAD", "\u8A3C\u660E\u66F8\u306E\u9396\u306E\u5F62\u304C\u9055\u3044\u307E\u3059");
    certs = o.chain.map((c) => parseCert(decodeDer(c)));
  } catch {
    return fail2("ATTEST_BAD", "\u8A3C\u660E\u66F8\u3092\u8AAD\u3081\u307E\u305B\u3093");
  }
  const chainCheck = await verifyChain(certs, o.now);
  if (chainCheck === "time") return fail2("ATTEST_CHAIN", "\u6709\u52B9\u671F\u9593\u306E\u5916\u306E\u8A3C\u660E\u66F8\u304C\u3042\u308A\u307E\u3059");
  if (chainCheck === "signature") return fail2("ATTEST_CHAIN", "\u8A3C\u660E\u66F8\u306E\u7F72\u540D\u304C\u5408\u3044\u307E\u305B\u3093");
  const root = certs[certs.length - 1];
  if (!(o.roots ?? GOOGLE_ATTESTATION_ROOTS).includes(await sha256Hex(root.spki))) return fail2("ATTEST_ROOT", "Google \u306E\u6839\u306E\u8A3C\u660E\u66F8\u306B\u3064\u306A\u304C\u3063\u3066\u3044\u307E\u305B\u3093");
  if (o.revoked) {
    for (const c of certs) if (await o.revoked(c.serial)) return fail2("ATTEST_REVOKED", "\u53D6\u308A\u6D88\u3055\u308C\u305F\u8A3C\u660E\u66F8\u304C\u3042\u308A\u307E\u3059");
  }
  const leaf = certs[0];
  let pubRaw;
  try {
    pubRaw = fromBase64Url(o.pub);
  } catch {
    return fail2("ATTEST_KEY", "\u516C\u958B\u9375\u306E\u5F62\u304C\u9055\u3044\u307E\u3059");
  }
  if (pubRaw.length !== 65 || !eq(leaf.spki, p256Spki(pubRaw))) return fail2("ATTEST_KEY", "\u8A3C\u660E\u66F8\u306E\u9375\u304C\u3001\u767B\u9332\u3059\u308B\u9375\u3068\u9055\u3044\u307E\u3059");
  const ext = leaf.extensions.get(KEY_DESCRIPTION_OID);
  if (!ext) return fail2("ATTEST_BAD", "\u9375\u306E\u8A18\u8FF0\u304C\u3042\u308A\u307E\u305B\u3093");
  let kd;
  try {
    kd = parseKeyDescription(ext);
  } catch {
    return fail2("ATTEST_BAD", "\u9375\u306E\u8A18\u8FF0\u3092\u8AAD\u3081\u307E\u305B\u3093");
  }
  const level = Math.min(kd.attestationSecurityLevel, kd.keyMintSecurityLevel);
  if (level < (o.requireStrongBox ? 2 : 1)) return fail2("ATTEST_LEVEL", o.requireStrongBox ? "StrongBox \u3067\u4F5C\u3089\u308C\u305F\u9375\u3067\u306F\u3042\u308A\u307E\u305B\u3093" : "\u7AEF\u672B\u306E\u91D1\u5EAB\u306E\u90E8\u54C1\u3067\u4F5C\u3089\u308C\u305F\u9375\u3067\u306F\u3042\u308A\u307E\u305B\u3093");
  if (!eq(kd.challenge, o.challenge)) return fail2("ATTEST_CHALLENGE", "\u554F\u3044\u304B\u3051\u304C\u9055\u3044\u307E\u3059");
  const hw = kd.hardware;
  if (!hw.purpose.includes(2) || hw.algorithm !== 3 || hw.ecCurve !== 1) return fail2("ATTEST_POLICY", "\u7F72\u540D\u7528\u306E P-256 \u306E\u9375\u3067\u306F\u3042\u308A\u307E\u305B\u3093");
  if (hw.origin !== 0) return fail2("ATTEST_POLICY", "\u7AEF\u672B\u306E\u4E2D\u3067\u4F5C\u3089\u308C\u305F\u9375\u3067\u306F\u3042\u308A\u307E\u305B\u3093");
  if (o.use === "approve") {
    if (hw.noAuthRequired || hw.userAuthType === void 0 || (hw.userAuthType & 2) === 0 || (hw.userAuthType & 1) !== 0 || hw.authTimeout !== void 0 && hw.authTimeout !== 0) {
      return fail2("ATTEST_POLICY", "\u627F\u8A8D\u306E\u9375\u304C\u3001\u4F7F\u3046\u305F\u3073\u306B\u751F\u4F53\u8A8D\u8A3C\u3092\u6C42\u3081\u308B\u4F5C\u308A\u65B9\u306B\u306A\u3063\u3066\u3044\u307E\u305B\u3093");
    }
  }
  if (o.requireVerifiedBoot !== false) {
    const rot = hw.rootOfTrust;
    if (!rot || !rot.deviceLocked || rot.verifiedBootState !== 0) return fail2("ATTEST_BOOT", "\u8D77\u52D5\u306E\u691C\u67FB\u304C\u901A\u3063\u3066\u3044\u306A\u3044\u7AEF\u672B\u3067\u3059\uFF08\u6539\u9020\u30FB\u958B\u767A\u7528\u306E\u53EF\u80FD\u6027\uFF09");
  }
  let packages = [];
  const appId = kd.software.attestationApplicationId ?? hw.attestationApplicationId;
  if (appId) {
    try {
      const a = parseApplicationId(appId);
      packages = a.packages;
      if (o.apps && !o.apps.some((x) => a.packages.includes(x.packageName) && a.signatureDigests.some((d) => x.signatureDigests.includes(d)))) {
        return fail2("ATTEST_APP", "\u8A31\u53EF\u3057\u3066\u3044\u306A\u3044\u30A2\u30D7\u30EA\u3067\u4F5C\u3089\u308C\u305F\u9375\u3067\u3059");
      }
    } catch {
      return fail2("ATTEST_BAD", "\u30A2\u30D7\u30EA\u306E\u8B58\u5225\u3092\u8AAD\u3081\u307E\u305B\u3093");
    }
  } else if (o.apps) {
    return fail2("ATTEST_APP", "\u30A2\u30D7\u30EA\u306E\u8B58\u5225\u304C\u3042\u308A\u307E\u305B\u3093");
  }
  return { ok: true, securityLevel: level >= 2 ? "strongbox" : "tee", packages };
}
var certToBase64Url = (der) => toBase64Url(der);

// love-connect-hub/src/cbor.ts
var CborError = class extends Error {
};
var MAX_DEPTH = 16;
function decodeCbor(buf) {
  let i = 0;
  const need = (n2) => {
    if (n2 < 0 || i + n2 > buf.length) throw new CborError("\u9014\u4E2D\u3067\u5207\u308C\u3066\u3044\u307E\u3059");
  };
  const arg = (info) => {
    if (info < 24) return info;
    const n2 = info === 24 ? 1 : info === 25 ? 2 : info === 26 ? 4 : info === 27 ? 8 : -1;
    if (n2 < 0) throw new CborError("\u9577\u3055\u4E0D\u5B9A\u306E\u5024\u306F\u8AAD\u307F\u307E\u305B\u3093");
    need(n2);
    let v2 = 0;
    for (let k = 0; k < n2; k++) v2 = v2 * 256 + buf[i++];
    if (!Number.isSafeInteger(v2)) throw new CborError("\u6570\u304C\u5927\u304D\u3059\u304E\u307E\u3059");
    return v2;
  };
  const item = (depth) => {
    if (depth > MAX_DEPTH) throw new CborError("\u5165\u308C\u5B50\u304C\u6DF1\u3059\u304E\u307E\u3059");
    need(1);
    const first = buf[i++];
    const major = first >> 5;
    const info = first & 31;
    switch (major) {
      case 0:
        return arg(info);
      case 1:
        return -1 - arg(info);
      case 2: {
        const n2 = arg(info);
        need(n2);
        const v2 = buf.subarray(i, i + n2);
        i += n2;
        return v2;
      }
      case 3: {
        const n2 = arg(info);
        need(n2);
        const v2 = new TextDecoder("utf-8", { fatal: true }).decode(buf.subarray(i, i + n2));
        i += n2;
        return v2;
      }
      case 4: {
        const n2 = arg(info);
        if (n2 > buf.length - i) throw new CborError("\u9014\u4E2D\u3067\u5207\u308C\u3066\u3044\u307E\u3059");
        const out = [];
        for (let k = 0; k < n2; k++) out.push(item(depth + 1));
        return out;
      }
      case 5: {
        const n2 = arg(info);
        if (n2 * 2 > buf.length - i) throw new CborError("\u9014\u4E2D\u3067\u5207\u308C\u3066\u3044\u307E\u3059");
        const out = /* @__PURE__ */ new Map();
        for (let k = 0; k < n2; k++) {
          const key = item(depth + 1);
          if (typeof key !== "string" && typeof key !== "number") throw new CborError("\u30DE\u30C3\u30D7\u306E\u30AD\u30FC\u306E\u5F62\u304C\u9055\u3044\u307E\u3059");
          if (out.has(key)) throw new CborError("\u540C\u3058\u30AD\u30FC\u304C 2 \u3064\u3042\u308A\u307E\u3059");
          out.set(key, item(depth + 1));
        }
        return out;
      }
      case 7:
        if (info === 20) return false;
        if (info === 21) return true;
        if (info === 22) return null;
        throw new CborError("\u8AAD\u307E\u306A\u3044\u7A2E\u985E\u306E\u5024\u3067\u3059");
      default:
        throw new CborError("\u30BF\u30B0\u4ED8\u304D\u306E\u5024\u306F\u8AAD\u307F\u307E\u305B\u3093");
    }
  };
  const v = item(0);
  if (i !== buf.length) throw new CborError("\u5F8C\u308D\u306B\u4F59\u8A08\u306A\u3082\u306E\u304C\u3042\u308A\u307E\u3059");
  return v;
}

// love-connect-hub/src/appattest.ts
var APPLE_APP_ATTEST_ROOT = "MIICITCCAaegAwIBAgIQC_O-DvHN0uD7jG5yH2IXmDAKBggqhkjOPQQDAzBSMSYwJAYDVQQDDB1BcHBsZSBBcHAgQXR0ZXN0YXRpb24gUm9vdCBDQTETMBEGA1UECgwKQXBwbGUgSW5jLjETMBEGA1UECAwKQ2FsaWZvcm5pYTAeFw0yMDAzMTgxODMyNTNaFw00NTAzMTUwMDAwMDBaMFIxJjAkBgNVBAMMHUFwcGxlIEFwcCBBdHRlc3RhdGlvbiBSb290IENBMRMwEQYDVQQKDApBcHBsZSBJbmMuMRMwEQYDVQQIDApDYWxpZm9ybmlhMHYwEAYHKoZIzj0CAQYFK4EEACIDYgAERTHhmLW07ATaFQIEVwTtT4dyctdhNbJhFs_Ii2FdCgAHGbpphY3-d8qjuDngIN3WVhQUBHAoMeQ_cLiP1sOUtgjqK9auYen1mMEvRq9Sk3Jm5X8U62H-xTD3FE9TgS41o0IwQDAPBgNVHRMBAf8EBTADAQH_MB0GA1UdDgQWBBSskRBTM72-aEH_pwyp5frq5eWKoTAOBgNVHQ8BAf8EBAMCAQYwCgYIKoZIzj0EAwMDaAAwZQIwQgFGnByvsiVbpTKwSga0kP0e8EeDS4-sQmTvb7vn53O5-FRXgeLhpJ06ysC5PrOyAjEAp5U4xDgEgllF7En3VcE3iexZZtKeYnpqtijVoyFraWVIyd_dganmrduC1bmTBGwD";
var APPLE_APP_ATTEST_ROOT_SPKI_SHA256 = "1ae751fd29896d0f1f13fe226c063f445d40d8938acc6245c251ecc0679330bd";
var NONCE_OID = "1.2.840.113635.100.8.2";
var enc3 = new TextEncoder();
var AAGUID_PROD = Uint8Array.from([..."appattest"].map((c) => c.charCodeAt(0)).concat([0, 0, 0, 0, 0, 0, 0]));
var AAGUID_DEV = enc3.encode("appattestdevelop");
var eq2 = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);
var hexBytes = (hex) => Uint8Array.from(hex.match(/../g), (h) => parseInt(h, 16));
var sha256 = async (d) => hexBytes(await sha256Hex(d));
var concat = (a, b) => {
  const o = new Uint8Array(a.length + b.length);
  o.set(a);
  o.set(b, a.length);
  return o;
};
function appAttestClientDataHash(p) {
  return sha256(`lch-appattest-v1
${p.co}
${p.by}
${p.use}
${p.pub}`);
}
var fail3 = (code, message) => ({ ok: false, code, message });
function decodeB64(s2) {
  return fromBase64Url(s2.replace(/\s+/g, "").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, ""));
}
function nonceOf(ext) {
  for (const f of derChildren(expectTag(parseDer(ext), 16))) {
    if (f.cls === 2 && f.tag === 1) return expectTag(derChildren(f)[0], 4).value;
  }
  throw new DerError("nonce \u304C\u3042\u308A\u307E\u305B\u3093");
}
function parseAuthData(a) {
  if (a.length < 55 || (a[32] & 64) === 0) throw new CborError("authenticatorData \u306E\u5F62\u304C\u9055\u3044\u307E\u3059");
  const signCount = (a[33] << 24 >>> 0) + (a[34] << 16) + (a[35] << 8) + a[36];
  const len = (a[53] << 8) + a[54];
  if (55 + len > a.length) throw new CborError("authenticatorData \u306E\u5F62\u304C\u9055\u3044\u307E\u3059");
  return { rpIdHash: a.subarray(0, 32), signCount, aaguid: a.subarray(37, 53), credentialId: a.subarray(55, 55 + len) };
}
async function verifyAppleAppAttest(o) {
  let x5c;
  let authData;
  let receipt;
  let keyId;
  try {
    keyId = decodeB64(o.keyId);
    const obj = decodeCbor(decodeB64(o.attestation));
    if (!(obj instanceof Map) || obj.get("fmt") !== "apple-appattest") return fail3("APPATTEST_BAD", "App Attest \u306E\u8A3C\u660E\u3067\u306F\u3042\u308A\u307E\u305B\u3093");
    const st = obj.get("attStmt");
    const ad = obj.get("authData");
    if (!(st instanceof Map) || !(ad instanceof Uint8Array)) return fail3("APPATTEST_BAD", "\u8A3C\u660E\u306E\u5F62\u304C\u9055\u3044\u307E\u3059");
    const chain = st.get("x5c");
    const rc = st.get("receipt");
    if (!Array.isArray(chain) || chain.length < 2 || chain.length > 5 || !chain.every((c) => c instanceof Uint8Array) || !(rc instanceof Uint8Array)) {
      return fail3("APPATTEST_BAD", "\u8A3C\u660E\u306E\u5F62\u304C\u9055\u3044\u307E\u3059");
    }
    x5c = chain;
    authData = ad;
    receipt = rc;
  } catch {
    return fail3("APPATTEST_BAD", "\u8A3C\u660E\u3092\u8AAD\u3081\u307E\u305B\u3093");
  }
  if (keyId.length !== 32) return fail3("APPATTEST_BAD", "\u9375\u306E ID \u306E\u5F62\u304C\u9055\u3044\u307E\u3059");
  let certs;
  let root;
  try {
    certs = x5c.map(parseCert);
    root = parseCert(decodeB64(o.root ?? APPLE_APP_ATTEST_ROOT));
  } catch {
    return fail3("APPATTEST_BAD", "\u8A3C\u660E\u66F8\u3092\u8AAD\u3081\u307E\u305B\u3093");
  }
  if (await sha256Hex(root.spki) !== (o.rootSpkiSha256 ?? APPLE_APP_ATTEST_ROOT_SPKI_SHA256)) return fail3("APPATTEST_ROOT", "Apple \u306E\u6839\u306E\u8A3C\u660E\u66F8\u3067\u306F\u3042\u308A\u307E\u305B\u3093");
  const all = [...certs, root];
  for (let i = 0; i < all.length; i++) {
    const c = all[i];
    if (o.now < c.notBefore || o.now > c.notAfter) return fail3("APPATTEST_CHAIN", "\u6709\u52B9\u671F\u9593\u306E\u5916\u306E\u8A3C\u660E\u66F8\u304C\u3042\u308A\u307E\u3059");
    if (i < all.length - 1 && !await signedBy(c, all[i + 1])) return fail3("APPATTEST_CHAIN", "Apple \u306E\u6839\u306E\u8A3C\u660E\u66F8\u306B\u3064\u306A\u304C\u3063\u3066\u3044\u307E\u305B\u3093");
  }
  const leaf = certs[0];
  const ext = leaf.extensions.get(NONCE_OID);
  let nonce;
  try {
    if (!ext) throw new DerError("nonce \u304C\u3042\u308A\u307E\u305B\u3093");
    nonce = nonceOf(ext);
  } catch {
    return fail3("APPATTEST_BAD", "nonce \u3092\u8AAD\u3081\u307E\u305B\u3093");
  }
  if (!eq2(nonce, await sha256(concat(authData, o.clientDataHash)))) return fail3("APPATTEST_NONCE", "nonce \u304C\u5408\u3044\u307E\u305B\u3093\uFF08\u5225\u306E\u767B\u9332\u306E\u8A3C\u660E\u3067\u3059\uFF09");
  const pub = p256PublicKeyOf(leaf);
  if (!pub || !eq2(await sha256(pub), keyId)) return fail3("APPATTEST_KEY", "\u9375\u306E ID \u304C\u8A3C\u660E\u66F8\u306E\u9375\u3068\u9055\u3044\u307E\u3059");
  let a;
  try {
    a = parseAuthData(authData);
  } catch {
    return fail3("APPATTEST_BAD", "authenticatorData \u3092\u8AAD\u3081\u307E\u305B\u3093");
  }
  let appId;
  for (const id of o.appIds) if (eq2(a.rpIdHash, await sha256(id))) appId = id;
  if (!appId) return fail3("APPATTEST_APP", "\u8A31\u53EF\u3057\u3066\u3044\u306A\u3044\u30A2\u30D7\u30EA\u306E\u8A3C\u660E\u3067\u3059");
  if (a.signCount !== 0) return fail3("APPATTEST_BAD", "\u65B0\u3057\u304F\u4F5C\u3063\u305F\u9375\u306E\u8A3C\u660E\u3067\u306F\u3042\u308A\u307E\u305B\u3093");
  const environment = eq2(a.aaguid, AAGUID_PROD) ? "production" : eq2(a.aaguid, AAGUID_DEV) ? "development" : void 0;
  if (!environment) return fail3("APPATTEST_BAD", "\u8A3C\u660E\u306E\u7A2E\u985E\u304C\u9055\u3044\u307E\u3059");
  if (environment === "development" && !o.allowDevelopment) return fail3("APPATTEST_ENV", "\u958B\u767A\u7528\u306E\u8A3C\u660E\u306F\u53D7\u3051\u4ED8\u3051\u3066\u3044\u307E\u305B\u3093");
  if (!eq2(a.credentialId, keyId)) return fail3("APPATTEST_KEY", "credentialId \u304C\u9375\u306E ID \u3068\u9055\u3044\u307E\u3059");
  return { ok: true, environment, appId, keyId: Array.from(keyId, (b) => b.toString(16).padStart(2, "0")).join(""), receipt };
}

// love-connect-hub/src/attest-policy.ts
var STR = (v, max) => typeof v === "string" && v.length > 0 && v.length <= max;
function createAttestationCheck(policy) {
  const required = new Set(policy.require ?? ["approve"]);
  return async ({ who, pub, use, att }) => {
    if (att === void 0 || att === null) {
      return required.has(use) ? { ok: false, code: "ATTEST_MISSING", message: "\u3053\u306E\u4F7F\u3044\u9053\u306E\u9375\u306B\u306F\u3001\u9375\u306E\u8A3C\u660E\u304C\u5FC5\u8981\u3067\u3059" } : { ok: true };
    }
    if (typeof att !== "object" || Array.isArray(att)) return { ok: false, code: "ATTEST_BAD", message: "\u9375\u306E\u8A3C\u660E\u306E\u5F62\u304C\u9055\u3044\u307E\u3059" };
    const a = att;
    if (a.platform === "android") {
      if (!policy.android) return { ok: false, code: "ATTEST_PLATFORM", message: "Android \u306E\u9375\u306E\u8A3C\u660E\u306F\u53D7\u3051\u4ED8\u3051\u3066\u3044\u307E\u305B\u3093" };
      if (!Array.isArray(a.chain) || !a.chain.every((c) => STR(c, 8192))) return { ok: false, code: "ATTEST_BAD", message: "\u9375\u306E\u8A3C\u660E\u306E\u5F62\u304C\u9055\u3044\u307E\u3059" };
      const r = await verifyAndroidAttestation({ ...policy.android, chain: a.chain, pub, use, challenge: await attestationChallenge(who.co, who.by), now: policy.now() });
      return r.ok ? { ok: true } : r;
    }
    if (a.platform === "apple") {
      if (!policy.apple) return { ok: false, code: "ATTEST_PLATFORM", message: "Apple \u306E\u9375\u306E\u8A3C\u660E\u306F\u53D7\u3051\u4ED8\u3051\u3066\u3044\u307E\u305B\u3093" };
      if (!STR(a.keyId, 64) || !STR(a.attestation, 12288)) return { ok: false, code: "ATTEST_BAD", message: "\u9375\u306E\u8A3C\u660E\u306E\u5F62\u304C\u9055\u3044\u307E\u3059" };
      const r = await verifyAppleAppAttest({
        ...policy.apple,
        attestation: a.attestation,
        keyId: a.keyId,
        clientDataHash: await appAttestClientDataHash({ co: who.co, by: who.by, use, pub }),
        now: policy.now()
      });
      return r.ok ? { ok: true } : r;
    }
    return { ok: false, code: "ATTEST_PLATFORM", message: "\u77E5\u3089\u306A\u3044\u7A2E\u985E\u306E\u9375\u306E\u8A3C\u660E\u3067\u3059" };
  };
}

// love-connect-hub/src/rtc.ts
var enc4 = new TextEncoder();
var RTC_SKEW_MS = 12e4;
var RTC_NONCE_MS = 3e5;
var RTC_MESSAGE_MAX = 64 * 1024;
var RTC_GRANT_MAX_MS = 30 * 6e4;
var ROOM_RE = /^[A-Za-z0-9_-]{8,64}$/;
var PUB_RE2 = /^[A-Za-z0-9_-]{87}$/;
var NONCE_RE2 = /^[A-Za-z0-9_-]{22}$/;
var SID_RE = /^[A-Za-z0-9_-]{8,64}$/;
var TYPES = ["offer", "answer", "ice", "restart", "bye", "grant", "revoke"];
var SCOPES = ["view", "point", "control"];
function rtcSignedText(m) {
  const { v, t, room, from, to, ts, n: n2, b } = m;
  return "lch-rtc-v1\n" + canonicalJson({ v, t, room, from, to, ts, n: n2, b });
}
async function signRtc(signer, p) {
  const body = { v: 1, t: p.t, room: p.room, from: signer.pub, to: p.to, ts: p.now, n: toBase64Url(crypto.getRandomValues(new Uint8Array(16))), b: p.b };
  return { ...body, sig: toBase64Url(await signer.sign(enc4.encode(rtcSignedText(body)))) };
}
var bad2 = (code, message) => ({ ok: false, code, message });
function bodyProblem(t, b) {
  const sid = b.sid;
  if (typeof sid !== "string" || !SID_RE.test(sid)) return "\u63A5\u7D9A\u306E\u756A\u53F7\uFF08sid\uFF09\u306E\u5F62\u304C\u9055\u3044\u307E\u3059";
  switch (t) {
    case "offer":
    case "answer": {
      if (typeof b.sdp !== "string" || b.sdp.length > 48 * 1024) return "SDP \u306E\u5F62\u304C\u9055\u3044\u307E\u3059";
      return sdpProblem(b.sdp);
    }
    case "ice":
      if (b.c !== null && (typeof b.c !== "string" || b.c.length > 1024)) return "\u7D4C\u8DEF\u306E\u5019\u88DC\u306E\u5F62\u304C\u9055\u3044\u307E\u3059";
      if (b.mid !== void 0 && (typeof b.mid !== "string" || b.mid.length > 32)) return "\u7D4C\u8DEF\u306E\u5019\u88DC\u306E\u5F62\u304C\u9055\u3044\u307E\u3059";
      if (b.idx !== void 0 && (typeof b.idx !== "number" || !Number.isInteger(b.idx) || b.idx < 0 || b.idx > 64)) return "\u7D4C\u8DEF\u306E\u5019\u88DC\u306E\u5F62\u304C\u9055\u3044\u307E\u3059";
      return void 0;
    case "grant":
      if (!SCOPES.includes(b.scope)) return "\u8A31\u3059\u7BC4\u56F2\u306E\u5F62\u304C\u9055\u3044\u307E\u3059";
      if (typeof b.until !== "number" || !Number.isSafeInteger(b.until)) return "\u8A31\u53EF\u306E\u671F\u9650\u306E\u5F62\u304C\u9055\u3044\u307E\u3059";
      return void 0;
    default:
      return void 0;
  }
}
function createRtcVerifier(o) {
  const nonces = o.nonces ?? createDedupe({ windowMs: RTC_NONCE_MS, capacity: 5e4 });
  const skew = o.skewMs ?? RTC_SKEW_MS;
  return {
    async verify(raw) {
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) return bad2("RTC_BAD", "\u9023\u7D61\u306E\u5F62\u304C\u9055\u3044\u307E\u3059");
      const m = raw;
      const keys = Object.keys(m).sort().join(",");
      if (keys !== "b,from,n,room,sig,t,to,ts,v") return bad2("RTC_BAD", "\u9023\u7D61\u306E\u5F62\u304C\u9055\u3044\u307E\u3059");
      if (m.v !== 1 || !TYPES.includes(m.t) || typeof m.room !== "string" || !ROOM_RE.test(m.room)) return bad2("RTC_BAD", "\u9023\u7D61\u306E\u5F62\u304C\u9055\u3044\u307E\u3059");
      if (typeof m.from !== "string" || !PUB_RE2.test(m.from) || typeof m.to !== "string" || !PUB_RE2.test(m.to)) return bad2("RTC_BAD", "\u9023\u7D61\u306E\u5F62\u304C\u9055\u3044\u307E\u3059");
      if (typeof m.ts !== "number" || !Number.isSafeInteger(m.ts) || typeof m.n !== "string" || !NONCE_RE2.test(m.n) || typeof m.sig !== "string") return bad2("RTC_BAD", "\u9023\u7D61\u306E\u5F62\u304C\u9055\u3044\u307E\u3059");
      if (!m.b || typeof m.b !== "object" || Array.isArray(m.b)) return bad2("RTC_BAD", "\u9023\u7D61\u306E\u5F62\u304C\u9055\u3044\u307E\u3059");
      if (m.room !== o.room) return bad2("RTC_ROOM", "\u5225\u306E\u90E8\u5C4B\u306E\u9023\u7D61\u3067\u3059");
      if (m.to !== o.me) return bad2("RTC_TO", "\u81EA\u5206\u5B9B\u3066\u306E\u9023\u7D61\u3067\u306F\u3042\u308A\u307E\u305B\u3093");
      const now = o.now();
      if (Math.abs(now - m.ts) > skew) return bad2("RTC_CLOCK", "\u6642\u523B\u304C\u305A\u308C\u3066\u3044\u307E\u3059");
      const p = bodyProblem(m.t, m.b);
      if (p) return bad2((m.t === "offer" || m.t === "answer") && typeof m.b.sdp === "string" && sdpProblem(m.b.sdp) === p ? "RTC_SDP" : "RTC_BAD", p);
      if (!await verifyDeviceSignature(m.from, m.sig, rtcSignedText(m))) return bad2("RTC_SIGNATURE", "\u7F72\u540D\u304C\u5408\u3044\u307E\u305B\u3093");
      if (!await nonces.first(m.room, `${m.from}\0${m.n}`, now)) return bad2("RTC_REPLAY", "\u540C\u3058\u9023\u7D61\u304C\u4F7F\u3044\u56DE\u3055\u308C\u307E\u3057\u305F");
      return { ok: true, msg: m };
    }
  };
}
function sdpFingerprints(sdp) {
  const out = [];
  for (const line of sdp.split(/\r?\n/)) {
    const m = /^a=fingerprint:(\S+) ([0-9A-Fa-f:]+)\s*$/.exec(line);
    if (m) out.push({ hash: m[1].toLowerCase(), value: m[2].toUpperCase() });
  }
  return out;
}
function sdpProblem(sdp) {
  const fps = sdpFingerprints(sdp);
  if (fps.length === 0) return "\u6697\u53F7\u306E\u9375\u306E\u6307\u7D0B\u304C\u3042\u308A\u307E\u305B\u3093";
  if (fps.some((f) => !["sha-256", "sha-384", "sha-512"].includes(f.hash))) return "\u5F31\u3044\u6307\u7D0B\uFF08SHA-1 \u306A\u3069\uFF09\u306F\u4F7F\u3048\u307E\u305B\u3093";
  if (new Set(fps.map((f) => f.hash + " " + f.value)).size !== 1) return "\u6307\u7D0B\u304C\u98DF\u3044\u9055\u3063\u3066\u3044\u307E\u3059";
  return void 0;
}
var RTC_VIDEO_ORDER = Object.freeze(["H265", "H264", "VP9", "AV1", "VP8"]);
function h264Rank(fmtp) {
  const m = /profile-level-id=([0-9A-Fa-f]{6})/.exec(fmtp ?? "");
  const p = m ? m[1].slice(0, 2).toLowerCase() : "42";
  return p === "64" ? 0 : p === "4d" ? 1 : 2;
}
function preferVideoCodecs(sdp, order = RTC_VIDEO_ORDER) {
  const nl = sdp.includes("\r\n") ? "\r\n" : "\n";
  const lines = sdp.split(/\r?\n/);
  let i = 0;
  while (i < lines.length) {
    if (!lines[i].startsWith("m=video ")) {
      i++;
      continue;
    }
    let end = i + 1;
    while (end < lines.length && !lines[end].startsWith("m=")) end++;
    const head = lines[i].split(" ");
    const pts = head.slice(3);
    const name = /* @__PURE__ */ new Map();
    const fmtp = /* @__PURE__ */ new Map();
    for (let k = i + 1; k < end; k++) {
      const r = /^a=rtpmap:(\d+) ([^/]+)\//.exec(lines[k]);
      if (r) name.set(r[1], r[2].toUpperCase());
      const f = /^a=fmtp:(\d+) (.*)$/.exec(lines[k]);
      if (f) fmtp.set(f[1], f[2]);
    }
    const rank = (pt) => {
      const c = order.indexOf(name.get(pt) ?? "");
      return c < 0 ? order.length : c;
    };
    const sorted = pts.map((pt, idx) => ({ pt, idx })).sort((a, b) => rank(a.pt) - rank(b.pt) || (name.get(a.pt) === "H264" && name.get(b.pt) === "H264" ? h264Rank(fmtp.get(a.pt)) - h264Rank(fmtp.get(b.pt)) : 0) || a.idx - b.idx).map((x) => x.pt);
    lines[i] = [...head.slice(0, 3), ...sorted].join(" ");
    i = end;
  }
  return lines.join(nl);
}
function tuneOpus(sdp) {
  const nl = sdp.includes("\r\n") ? "\r\n" : "\n";
  const lines = sdp.split(/\r?\n/);
  const opus = /* @__PURE__ */ new Set();
  for (const l of lines) {
    const r = /^a=rtpmap:(\d+) opus\//i.exec(l);
    if (r) opus.add(r[1]);
  }
  return lines.map((l) => {
    const f = /^a=fmtp:(\d+) (.*)$/.exec(l);
    if (!f || !opus.has(f[1])) return l;
    const params = new Map(f[2].split(";").filter(Boolean).map((kv) => {
      const [k, v] = kv.split("=");
      return [k.trim(), (v ?? "").trim()];
    }));
    params.set("useinbandfec", "1");
    params.set("usedtx", "1");
    return `a=fmtp:${f[1]} ` + [...params].map(([k, v]) => `${k}=${v}`).join(";");
  }).join(nl);
}
function rtcBudget(p) {
  const cell = p.network === "cellular";
  const fps = Math.max(1, Math.min(240, Math.floor(p.displayFps ?? 60)));
  if (p.source === "screen") {
    if (cell) return { maxBitrate: 6e6, maxFps: Math.min(fps, 60), maxLongEdge: 1920, audioBitrate: 24e3, contentHint: "text", degradation: "maintain-resolution" };
    return { maxBitrate: fps > 60 ? 24e6 : 16e6, maxFps: Math.min(fps, 120), maxLongEdge: 3840, audioBitrate: 32e3, contentHint: "text", degradation: "maintain-resolution" };
  }
  if (cell) return { maxBitrate: 1e6, maxFps: Math.min(fps, 30), maxLongEdge: 960, audioBitrate: 24e3, contentHint: "motion", degradation: "maintain-framerate" };
  return { maxBitrate: 25e5, maxFps: Math.min(fps, 30), maxLongEdge: 1280, audioBitrate: 32e3, contentHint: "motion", degradation: "maintain-framerate" };
}
var RTC_CHANNELS = Object.freeze({
  ctl: Object.freeze({ ordered: true }),
  mv: Object.freeze({ ordered: false, maxRetransmits: 0 })
});
var RTC_SIGNAL_MAX = 16 * 1024;
var SUPPORTER_SIGNALS = Object.freeze({
  view: ["st"],
  point: ["st", "pt"],
  control: ["st", "pt", "rm", "ma", "md", "mu", "sc", "kd", "ku", "tx", "rel"]
});
var MV_SIGNALS = ["rm", "ma", "cur", "pt"];
var num = (v, lo, hi) => typeof v === "number" && Number.isFinite(v) && v >= lo && v <= hi;
function checkAssistSignal(channel, scope, raw) {
  if (raw.length > RTC_SIGNAL_MAX) return { ok: false, reason: "\u5927\u304D\u3059\u304E\u308B\u4FE1\u53F7\u3067\u3059" };
  let s2;
  try {
    s2 = JSON.parse(raw);
  } catch {
    return { ok: false, reason: "\u4FE1\u53F7\u3092\u8AAD\u3081\u307E\u305B\u3093" };
  }
  if (!s2 || typeof s2 !== "object" || Array.isArray(s2) || typeof s2.k !== "string") return { ok: false, reason: "\u4FE1\u53F7\u306E\u5F62\u304C\u9055\u3044\u307E\u3059" };
  const k = s2.k;
  if (channel === "mv" && !MV_SIGNALS.includes(k)) return { ok: false, reason: "\u3053\u306E\u9053\u3067\u306F\u9001\u308C\u306A\u3044\u4FE1\u53F7\u3067\u3059" };
  if (!scope || !SUPPORTER_SIGNALS[scope].includes(k)) return { ok: false, reason: "\u8A31\u3055\u308C\u3066\u3044\u306A\u3044\u64CD\u4F5C\u3067\u3059" };
  const okShape = k === "rm" ? num(s2.dx, -1e4, 1e4) && num(s2.dy, -1e4, 1e4) : k === "ma" || k === "pt" ? num(s2.x, 0, 1) && num(s2.y, 0, 1) : k === "md" || k === "mu" ? s2.b === 0 || s2.b === 1 || s2.b === 2 : k === "sc" ? num(s2.dx, -1e5, 1e5) && num(s2.dy, -1e5, 1e5) : k === "kd" || k === "ku" ? typeof s2.c === "number" && Number.isInteger(s2.c) && s2.c >= 0 && s2.c <= 65535 : k === "tx" ? typeof s2.s === "string" && s2.s.length <= 4096 : true;
  return okShape ? { ok: true, signal: s2 } : { ok: false, reason: "\u4FE1\u53F7\u306E\u5F62\u304C\u9055\u3044\u307E\u3059" };
}
async function verifyControlGrant(p) {
  const g = p.grant;
  if (!g || g.t !== "grant" || g.v !== 1 || !g.b || bodyProblem("grant", g.b)) return { ok: false, code: "RTC_GRANT", message: "\u8A31\u53EF\u306E\u5F62\u304C\u9055\u3044\u307E\u3059" };
  if (!p.approverKeys.includes(g.from)) return { ok: false, code: "RTC_GRANT", message: "\u672C\u4EBA\u306E\u627F\u8A8D\u306E\u9375\u3067\u7F72\u540D\u3055\u308C\u3066\u3044\u307E\u305B\u3093" };
  if (g.to !== p.supporter || g.b.sid !== p.sid) return { ok: false, code: "RTC_GRANT", message: "\u5225\u306E\u76F8\u624B\u30FB\u5225\u306E\u63A5\u7D9A\u3078\u306E\u8A31\u53EF\u3067\u3059" };
  const until = g.b.until;
  if (until <= p.now || until - g.ts > RTC_GRANT_MAX_MS || g.ts > p.now + RTC_SKEW_MS) return { ok: false, code: "RTC_GRANT", message: "\u8A31\u53EF\u306E\u671F\u9650\u304C\u5207\u308C\u3066\u3044\u308B\u304B\u3001\u9577\u3059\u304E\u307E\u3059" };
  if (!await verifyDeviceSignature(g.from, g.sig, rtcSignedText(g))) return { ok: false, code: "RTC_SIGNATURE", message: "\u7F72\u540D\u304C\u5408\u3044\u307E\u305B\u3093" };
  return { ok: true, scope: g.b.scope, until };
}
function createRestartPolicy(o = {}) {
  const retryMs = o.retryMs ?? 5e3, giveUpMs = o.giveUpMs ?? 2e4;
  let since, last = 0, closed = false;
  return {
    /** 接続の状態が変わったとき。行うこと（restart・close）を返す */
    onState(state, now) {
      if (closed) return [];
      if (state === "connected") {
        since = void 0;
        return [];
      }
      if (state === "closed") {
        closed = true;
        return [];
      }
      if ((state === "disconnected" || state === "failed") && since === void 0) {
        since = now;
        last = now;
        return ["restart"];
      }
      return [];
    },
    /** 端末の回線が変わったとき */
    onNetworkChange(now) {
      if (closed) return [];
      last = now;
      return ["restart"];
    },
    /** 定期的に呼ぶ（1 秒ごとなど） */
    tick(now) {
      if (closed || since === void 0) return [];
      if (now - since >= giveUpMs) {
        closed = true;
        return ["close"];
      }
      if (now - last >= retryMs) {
        last = now;
        return ["restart"];
      }
      return [];
    }
  };
}
var TURN_TTL_SEC = 24 * 60 * 60;
var ICE_URL_RE = /^(stun|turn|turns):[A-Za-z0-9.\-:?=&_]{1,200}$/;
function sanitizeIceServers(raw) {
  const list = raw?.iceServers;
  const items = Array.isArray(list) ? list : list && typeof list === "object" ? [list] : [];
  const out = [];
  for (const item of items.slice(0, 8)) {
    if (!item || typeof item !== "object") continue;
    const { urls, username, credential } = item;
    const all = (Array.isArray(urls) ? urls : [urls]).filter((u) => typeof u === "string" && ICE_URL_RE.test(u));
    if (all.length === 0) continue;
    const s2 = { urls: all.slice(0, 8) };
    if (typeof username === "string" && username.length <= 512) s2.username = username;
    if (typeof credential === "string" && credential.length <= 512) s2.credential = credential;
    if (all.some((u) => u.startsWith("turn")) && (!s2.username || !s2.credential)) continue;
    out.push(s2);
  }
  return out;
}
var n = (v) => typeof v === "number" && Number.isFinite(v) ? v : void 0;
var s = (v) => typeof v === "string" ? v : void 0;
function clean(o) {
  for (const k of Object.keys(o)) if (o[k] === void 0) delete o[k];
  return o;
}
function summarizeRtcStats(reports) {
  const all = [...reports];
  const byId = new Map(all.filter((r) => typeof r.id === "string").map((r) => [r.id, r]));
  const pair = all.find((r) => r.type === "candidate-pair" && (r.selected === true || r.nominated === true) && r.state === "succeeded");
  const local = pair ? byId.get(s(pair.localCandidateId) ?? "") : void 0;
  const remote = pair ? byId.get(s(pair.remoteCandidateId) ?? "") : void 0;
  const lt = s(local?.candidateType), rt = s(remote?.candidateType);
  const codec = (id) => s(byId.get(s(id) ?? "")?.mimeType)?.replace(/^video\//i, "");
  const outV = all.find((r) => r.type === "outbound-rtp" && r.kind === "video");
  const inV = all.find((r) => r.type === "inbound-rtp" && r.kind === "video");
  const sum = { path: !pair ? "unknown" : lt === "relay" || rt === "relay" ? "relay" : "direct" };
  if (lt) sum.local = lt;
  if (rt) sum.remote = rt;
  const rp = s(local?.relayProtocol);
  if (rp) sum.relayProtocol = rp;
  const rtt = n(pair?.currentRoundTripTime);
  if (rtt !== void 0) sum.rttMs = Math.round(rtt * 1e3);
  const bw = n(pair?.availableOutgoingBitrate);
  if (bw !== void 0) sum.availableOutgoingBps = Math.round(bw);
  if (outV) sum.out = clean({ codec: codec(outV.codecId), impl: s(outV.encoderImplementation), fps: n(outV.framesPerSecond), width: n(outV.frameWidth), height: n(outV.frameHeight), nack: n(outV.nackCount), pli: n(outV.pliCount), limited: s(outV.qualityLimitationReason) });
  if (inV) {
    const jb = n(inV.jitterBufferDelay), jbc = n(inV.jitterBufferEmittedCount), jit = n(inV.jitter);
    sum.in = clean({
      codec: codec(inV.codecId),
      impl: s(inV.decoderImplementation),
      fps: n(inV.framesPerSecond),
      width: n(inV.frameWidth),
      height: n(inV.frameHeight),
      dropped: n(inV.framesDropped),
      freezes: n(inV.freezeCount),
      jitterBufferMs: jb !== void 0 && jbc ? Math.round(jb / jbc * 1e3) : void 0,
      lost: n(inV.packetsLost),
      jitterMs: jit !== void 0 ? Math.round(jit * 1e3) : void 0
    });
  }
  return sum;
}
function newRoomId() {
  return toBase64Url(crypto.getRandomValues(new Uint8Array(16)));
}
function newSessionId() {
  return toBase64Url(crypto.getRandomValues(new Uint8Array(12)));
}

// love-connect-hub/src/rtc-room.ts
var RTC_ROOM_LIMITS = Object.freeze({
  /** 直接つなぐ（全員が全員とつなぐ）会議の人数の上限。これより多い会議は、映像を配る中継（SFU）を使う（第23章 次の段階） */
  meetingPeers: 4,
  /** 遠隔支援は 2 人（支援する人と、支援される人） */
  assistPeers: 2,
  rateWindowMs: 1e4,
  rateCount: 400
});
var RTC_CLOSE = Object.freeze({ replaced: 4e3, badRequest: 4400, forbidden: 4403, full: 4409, tooMany: 4429 });
function createRtcRoom(o) {
  const members = /* @__PURE__ */ new Map();
  const max = o.purpose === "assist" ? RTC_ROOM_LIMITS.assistPeers : RTC_ROOM_LIMITS.meetingPeers;
  let turnCache = null;
  const view = (p) => ({ pub: p.pub, by: p.by, ...p.name ? { name: p.name.slice(0, 64) } : {} });
  const send = (m, msg) => {
    try {
      m.sink.send(JSON.stringify(msg));
    } catch {
    }
  };
  return {
    get size() {
      return members.size;
    },
    /** 入る。同じ端末がもう一度入ったら、古い接続を閉じて置き換える */
    join(peer, sink) {
      if (peer.co !== o.co) {
        sink.close(RTC_CLOSE.forbidden, "\u5225\u306E\u4F1A\u793E\u306E\u90E8\u5C4B\u3067\u3059");
        return { ok: false, code: RTC_CLOSE.forbidden, reason: "\u5225\u306E\u4F1A\u793E\u306E\u90E8\u5C4B\u3067\u3059" };
      }
      const old = members.get(peer.pub);
      if (!old && members.size >= max) {
        sink.close(RTC_CLOSE.full, "\u90E8\u5C4B\u304C\u3044\u3063\u3071\u3044\u3067\u3059");
        return { ok: false, code: RTC_CLOSE.full, reason: "\u90E8\u5C4B\u304C\u3044\u3063\u3071\u3044\u3067\u3059" };
      }
      if (old) {
        try {
          old.sink.close(RTC_CLOSE.replaced, "\u540C\u3058\u7AEF\u672B\u304C\u5165\u308A\u76F4\u3057\u307E\u3057\u305F");
        } catch {
        }
      }
      const m = { peer, sink, win: o.now(), count: 0 };
      members.set(peer.pub, m);
      send(m, { t: "welcome", purpose: o.purpose, me: view(peer), peers: [...members.values()].filter((x) => x !== m).map((x) => view(x.peer)) });
      if (!old) {
        for (const x of members.values()) if (x !== m) send(x, { t: "presence", join: view(peer) });
      }
      return { ok: true };
    },
    /** 出る（接続が切れたとき） */
    leave(pub, sink) {
      const m = members.get(pub);
      if (!m || sink && m.sink !== sink) return;
      members.delete(pub);
      for (const x of members.values()) send(x, { t: "presence", leave: pub });
    },
    /** 参加者から届いた文字を処理する */
    async receive(pub, text) {
      const m = members.get(pub);
      if (!m) return;
      const now = o.now();
      if (now - m.win > RTC_ROOM_LIMITS.rateWindowMs) {
        m.win = now;
        m.count = 0;
      }
      if (++m.count > RTC_ROOM_LIMITS.rateCount) {
        members.delete(pub);
        m.sink.close(RTC_CLOSE.tooMany, "\u9001\u308B\u56DE\u6570\u304C\u591A\u3059\u304E\u307E\u3059");
        for (const x of members.values()) send(x, { t: "presence", leave: pub });
        return;
      }
      if (text === "ping") {
        try {
          m.sink.send("pong");
        } catch {
        }
        return;
      }
      if (text.length > RTC_MESSAGE_MAX) {
        send(m, { t: "error", code: "TOO_LARGE" });
        return;
      }
      let d;
      try {
        d = JSON.parse(text);
      } catch {
        send(m, { t: "error", code: "BAD_JSON" });
        return;
      }
      if (d && d.t === "turn") {
        if (!o.turn) {
          send(m, { t: "turn", servers: [], ttl: 0 });
          return;
        }
        if (!turnCache || turnCache.until <= now) {
          const g = await o.turn().catch(() => null);
          turnCache = g ? { value: g, until: now + g.ttl * 1e3 / 2 } : null;
        }
        send(m, { t: "turn", servers: turnCache?.value.servers ?? [], ttl: turnCache?.value.ttl ?? 0 });
        return;
      }
      if (!d || d.t !== "msg" || typeof d.to !== "string" || !d.m || typeof d.m !== "object" || Array.isArray(d.m)) {
        send(m, { t: "error", code: "BAD_REQUEST" });
        return;
      }
      if (d.m.from !== pub) {
        send(m, { t: "error", code: "FROM_MISMATCH" });
        return;
      }
      const to = members.get(d.to);
      if (!to || to === m) {
        send(m, { t: "undeliverable", to: d.to });
        return;
      }
      send(to, { t: "msg", from: pub, m: d.m });
    }
  };
}

// love-connect-hub/src/task.ts
var TASK_DEFAULTS = { keepEndedMs: 7 * 864e5, max: 300, titleMax: 120, quotedTitle: "\u307B\u304B\u306E\u9053\u5177\u304B\u3089\u5F15\u7528" };
var ALPHABET = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
function newTaskId() {
  let out = "w-";
  const b = new Uint8Array(16);
  while (out.length < 10) {
    globalThis.crypto.getRandomValues(b);
    for (const x of b) if (x < 248 && out.length < 10) out += ALPHABET[x % 62];
  }
  return out;
}
function isTaskId(x) {
  return typeof x === "string" && TASK_ID_RE.test(x);
}
var badId = () => ({ ok: false, code: "BAD_TASK_ID", field: "tk", message: "\u4F5C\u696D ID \u306F w- \u3068\u82F1\u6570\u5B57 8 \u6587\u5B57\u3067\u3059\uFF08\u4F8B w-a1B2c3D4\uFF09" });
var ended = (id) => ({
  ok: false,
  code: "TASK_ENDED",
  field: "tk",
  message: `\u4F5C\u696D ${id} \u306F\u7D42\u4E86\u304C\u5BA3\u8A00\u3055\u308C\u3066\u3044\u307E\u3059\u3002\u7D42\u308F\u3063\u305F\u4F5C\u696D ID \u306E\u64CD\u4F5C\u306F\u53D7\u3051\u4ED8\u3051\u305A\u3001\u59CB\u3081\u76F4\u3057\u306B\u3082\u4F7F\u3044\u307E\u305B\u3093\u3002\u65B0\u3057\u3044\u4F5C\u696D\u3092\u59CB\u3081\u3066\u304F\u3060\u3055\u3044`
});
var full = (max) => ({
  ok: false,
  code: "TASK_FULL",
  field: "tk",
  message: `\u9032\u884C\u4E2D\u306E\u4F5C\u696D\u304C\u4E0A\u9650\uFF08${max}\uFF09\u306B\u9054\u3057\u3066\u3044\u307E\u3059\u3002\u7D42\u308F\u3063\u305F\u4F5C\u696D\u306E\u7D42\u4E86\u3092\u5BA3\u8A00\u3057\u3066\u304B\u3089\u59CB\u3081\u3066\u304F\u3060\u3055\u3044\uFF08\u81EA\u52D5\u3067\u306F\u7D42\u308F\u308A\u307E\u305B\u3093\uFF09`
});
function createTaskBook(opts) {
  const key = opts.key ?? "tasks";
  const keep = opts.keepEndedMs ?? TASK_DEFAULTS.keepEndedMs;
  const max = opts.max ?? TASK_DEFAULTS.max;
  const quotedTitle = opts.quotedTitle ?? TASK_DEFAULTS.quotedTitle;
  let chain = Promise.resolve();
  const serial = (fn) => {
    const run = chain.then(fn);
    chain = run.catch(() => void 0);
    return run;
  };
  const load = async () => {
    const t = opts.now();
    return (await opts.store.get(key) ?? []).filter((r) => !(r.state === "ended" && t - (r.ended_at ?? 0) > keep));
  };
  const save = async (list) => {
    if (list.length > max) {
      const drop = new Set(
        list.filter((r) => r.state === "ended").sort((a, b) => (a.ended_at ?? 0) - (b.ended_at ?? 0)).slice(0, list.length - max).map((r) => r.id)
      );
      list = list.filter((r) => !drop.has(r.id));
    }
    await opts.store.put(key, list);
  };
  const hasRoom = (list) => list.length < max || list.some((r) => r.state === "ended");
  const fresh = (id, title, issued_by) => {
    const t = opts.now();
    return { id, title, state: "active", issued_by, started_at: t, last_at: t };
  };
  return {
    start(id, title) {
      return serial(async () => {
        if (id !== void 0 && !isTaskId(id)) return badId();
        const list = await load();
        const name = (title ?? "").trim().slice(0, TASK_DEFAULTS.titleMax);
        if (id !== void 0) {
          const ex = list.find((r) => r.id === id);
          if (ex) {
            if (ex.state === "ended") return ended(id);
            ex.last_at = opts.now();
            if (name && ex.title === quotedTitle) ex.title = name;
            await save(list);
            return { ok: true, task: ex, existing: true };
          }
        }
        if (!hasRoom(list)) return full(max);
        let newId = id;
        if (newId === void 0) {
          do
            newId = newTaskId();
          while (list.some((r) => r.id === newId));
        }
        const rec = fresh(newId, name || (id !== void 0 ? quotedTitle : ""), id !== void 0 ? "quoted" : "self");
        list.push(rec);
        await save(list);
        return { ok: true, task: rec, existing: false };
      });
    },
    touch(id) {
      return serial(async () => {
        if (!isTaskId(id)) return badId();
        const list = await load();
        const ex = list.find((r) => r.id === id);
        if (ex) {
          if (ex.state === "ended") return ended(id);
          ex.last_at = opts.now();
          await save(list);
          return { ok: true, task: ex, adopted: false };
        }
        if (!hasRoom(list)) return full(max);
        const rec = fresh(id, quotedTitle, "quoted");
        list.push(rec);
        await save(list);
        return { ok: true, task: rec, adopted: true };
      });
    },
    end(id) {
      return serial(async () => {
        if (!isTaskId(id)) return badId();
        const list = await load();
        const ex = list.find((r) => r.id === id);
        if (!ex) return { ok: false, code: "TASK_UNKNOWN", field: "tk", message: `\u4F5C\u696D ${id} \u306F\u3001\u3053\u306E\u9053\u5177\u3067\u306F\u4F7F\u308F\u308C\u3066\u3044\u307E\u305B\u3093\uFF08\u307E\u305F\u306F\u3001\u7D42\u308F\u3063\u3066\u304B\u3089\u65E5\u6570\u304C\u305F\u3063\u3066\u6D88\u3048\u307E\u3057\u305F\uFF09` };
        if (ex.state === "ended") return { ok: true, task: ex, already: true };
        ex.state = "ended";
        ex.ended_at = opts.now();
        ex.last_at = ex.ended_at;
        await save(list);
        return { ok: true, task: ex, already: false };
      });
    },
    list() {
      return serial(async () => {
        const list = await load();
        return {
          active: list.filter((r) => r.state === "active").sort((a, b) => b.last_at - a.last_at),
          ended: list.filter((r) => r.state === "ended").sort((a, b) => (b.ended_at ?? 0) - (a.ended_at ?? 0)).slice(0, 50)
        };
      });
    }
  };
}

// love-connect-hub/src/index.ts
function compareUrgency(a, b) {
  const p = LANES[a.l].priority - LANES[b.l].priority;
  if (p !== 0) return p;
  const da = dueOf(a);
  const db = dueOf(b);
  if (da !== db) return da < db ? -1 : 1;
  return a.at - b.at;
}
function dueOf(env) {
  const dl = env.dl ?? LANES[env.l].deadlineMs;
  return dl > 0 ? env.at + dl : Number.POSITIVE_INFINITY;
}
export {
  APPLE_APP_ATTEST_ROOT,
  APPLE_APP_ATTEST_ROOT_SPKI_SHA256,
  APPROVAL_SKEW_MS,
  BATCH_PART_BYTES,
  CLOSE_POLICY,
  CborError,
  DEVICE_HEADER,
  DEVICE_HTTP_STATUS,
  DEVICE_NONCE_MS,
  DEVICE_PATH,
  DEVICE_SKEW_MS,
  DerError,
  GOOGLE_ATTESTATION_ROOTS,
  HEADER_MAX_BYTES,
  HTTP_PATH,
  HTTP_STATUS,
  LANES,
  LANE_NAMES,
  MEDIA_CHUNK_BYTES,
  PAIRING_TTL_MS,
  RAW_MAX_BYTES,
  RTC_CHANNELS,
  RTC_CLOSE,
  RTC_GRANT_MAX_MS,
  RTC_MESSAGE_MAX,
  RTC_NONCE_MS,
  RTC_ROOM_LIMITS,
  RTC_SIGNAL_MAX,
  RTC_SKEW_MS,
  RTC_VIDEO_ORDER,
  SECURITY_HEADERS,
  SOCKET_LANES_DEFAULT,
  SPEC_VERSION,
  SPEC_VERSIONS,
  SendError,
  TASK_DEFAULTS,
  TASK_ID_RE,
  TOKEN_MAX_CHARS,
  TURN_TTL_SEC,
  USER_HTTP_STATUS,
  USER_PATH,
  aiDelta,
  aiEnd,
  appAttestClientDataHash,
  approvalMessage,
  attachSocket,
  attestationChallenge,
  bearerToken,
  bodyBytes,
  buildHubTables,
  callWithKey,
  canonicalJson,
  certToBase64Url,
  checkAssistSignal,
  checkDraft,
  checkEnvelope,
  checkVersion,
  compareUrgency,
  createAiAssembler,
  createAttestationCheck,
  createBatchAssembler,
  createCompanyKeys,
  createDedupe,
  createDeviceEnrollment,
  createDeviceVerifier,
  createHttpClient,
  createHttpHandler,
  createMediaAssembler,
  createReceiver,
  createRestartPolicy,
  createRtcRoom,
  createRtcVerifier,
  createSender,
  createStreamReorder,
  createTaskBook,
  createTokenVerifier,
  createUserClient,
  createUserGateway,
  createWebDeviceKey,
  decodeCbor,
  derBits,
  derBool,
  derChildren,
  derInt,
  derIntHex,
  derOid,
  derTime,
  describeMedia,
  deviceProofHeader,
  deviceProofMessage,
  expectTag,
  formatTable,
  fromBase64Url,
  importSealKey,
  importSigningKey,
  isExpired,
  isLane,
  isRetryable,
  isTaskId,
  issuePairingCode,
  matchesBody,
  mergeFields,
  newRoomId,
  newSessionId,
  newTaskId,
  openBody,
  openBodyText,
  p256PublicKeyOf,
  pairingMessage,
  pairingRequest,
  parseApplicationId,
  parseCert,
  parseDer,
  parseKeyDescription,
  parseKeyRef,
  parseSeqId,
  partCount,
  partId,
  planBatch,
  preferVideoCodecs,
  randomId,
  readBody,
  readDer,
  readLimited,
  redact,
  retentionOf,
  rtcBudget,
  rtcSignedText,
  sanitizeIceServers,
  sdpFingerprints,
  sdpProblem,
  sealBody,
  seqId,
  sha256Hex,
  signApproval,
  signEnvelope,
  signRtc,
  signedBy,
  splitMedia,
  storageFirst,
  summarizeRtcStats,
  toBase64Url,
  tuneOpus,
  verifyAndroidAttestation,
  verifyAppleAppAttest,
  verifyApproval,
  verifyChain,
  verifyControlGrant,
  verifyDeviceSignature,
  verifyEnvelope,
  versionFor,
  withRetry
};
