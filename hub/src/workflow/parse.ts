/**
 * 定義ファイルの解析と検証。誤りはすべて集めて、ファイル名・行・列つきで返す。
 */
import { isMap, isScalar, isSeq, LineCounter, parseDocument, type Node, type Pair, type YAMLMap } from "yaml";
import { compileExpr, ExprError } from "./expr";
import { parseCron } from "./cron";
import { expandMatrix } from "./matrix";
import {
  BUILTIN_COMPONENTS,
  DEFAULT_TIMEOUT_MINUTES,
  MAX_TIMEOUT_MINUTES,
  type Concurrency,
  type Job,
  type Matrix,
  type ParseResult,
  type Problem,
  type Step,
  type Triggers,
  type Workflow,
} from "./types";

const ID = /^[A-Za-z_][A-Za-z0-9_-]{0,99}$/;
const SECRET_NAME = /^[A-Z_][A-Z0-9_]{0,99}$/;
const MAX_FILE_BYTES = 256 * 1024;

class Ctx {
  problems: Problem[] = [];
  constructor(
    readonly file: string,
    readonly lc: LineCounter,
  ) {}
  pos(node: Node | null | undefined, extra = 0): { line: number; column: number } {
    const off = (node?.range?.[0] ?? 0) + extra;
    const p = this.lc.linePos(off);
    return { line: p.line, column: p.col };
  }
  err(node: Node | null | undefined, message: string, extra = 0): void {
    this.problems.push({ file: this.file, ...this.pos(node, extra), message });
  }
}

function key(p: Pair): string | null {
  return isScalar(p.key) ? String(p.key.value) : null;
}

function str(c: Ctx, n: Node | null | undefined, what: string): string | undefined {
  if (isScalar(n) && (typeof n.value === "string" || typeof n.value === "number" || typeof n.value === "boolean")) return String(n.value);
  c.err(n, `${what} は文字列で書いてください`);
  return undefined;
}

function strList(c: Ctx, n: Node | null | undefined, what: string): string[] {
  if (isScalar(n)) {
    const v = str(c, n, what);
    return v === undefined ? [] : [v];
  }
  if (!isSeq(n)) {
    c.err(n, `${what} は文字列か、文字列の並びで書いてください`);
    return [];
  }
  return n.items.map((i) => str(c, i as Node, what)).filter((v): v is string => v !== undefined);
}

function strMap(c: Ctx, n: Node | null | undefined, what: string): Record<string, string> {
  const out: Record<string, string> = {};
  if (n == null) return out;
  if (!isMap(n)) {
    c.err(n, `${what} は「名前: 値」の形で書いてください`);
    return out;
  }
  for (const p of n.items) {
    const k = key(p);
    if (!k) {
      c.err(p.key as Node, `${what} の名前が正しくありません`);
      continue;
    }
    const v = str(c, p.value as Node, `${what}.${k}`);
    if (v !== undefined) out[k] = v;
  }
  return out;
}

function checkKeys(c: Ctx, m: YAMLMap, allowed: string[], where: string): void {
  for (const p of m.items) {
    const k = key(p);
    if (k && !allowed.includes(k)) c.err(p.key as Node, `${where} に「${k}」は書けません（使えるもの：${allowed.join("・")}）`);
  }
}

function get(m: YAMLMap, k: string): Node | undefined {
  const p = m.items.find((i) => key(i) === k);
  return (p?.value as Node | undefined) ?? undefined;
}
function getPair(m: YAMLMap, k: string): Pair | undefined {
  return m.items.find((i) => key(i) === k);
}

function checkExpr(c: Ctx, n: Node | undefined, what: string): string | undefined {
  if (n === undefined) return undefined;
  const s = str(c, n, what);
  if (s === undefined) return undefined;
  try {
    compileExpr(s);
  } catch (e) {
    // 引用符の内側の位置にずらす（素の書き方なら 0）
    const quote = isScalar(n) && (n.type === "QUOTE_DOUBLE" || n.type === "QUOTE_SINGLE") ? 1 : 0;
    c.err(n, `${what} の式が正しくありません：${(e as Error).message}`, e instanceof ExprError ? e.pos + quote : 0);
  }
  return s;
}

function triggers(c: Ctx, n: Node | undefined): Triggers {
  const t: Triggers = {};
  if (n === undefined) {
    c.problems.push({ file: c.file, line: 1, column: 1, message: "on（いつ実行するか）がありません" });
    return t;
  }
  const names = ["push", "pull_request", "delete", "schedule", "manual"];
  const add = (name: string, node: Node | undefined, valueNode: Node | null | undefined) => {
    if (!names.includes(name)) return c.err(node, `on に「${name}」は使えません（使えるもの：${names.join("・")}）`);
    if (name === "schedule") {
      const items = isSeq(valueNode) ? valueNode.items : [];
      if (!isSeq(valueNode)) return c.err(valueNode ?? node, "schedule は cron の並びで書いてください（例：[\"0 3 * * *\"]）");
      t.schedule = [];
      for (const it of items as Node[]) {
        // Actions の書き方（- cron: '…'）も受け付ける
        const cronNode = isMap(it) ? (get(it, "cron") ?? it) : it;
        const s = str(c, cronNode, "schedule");
        if (s === undefined) continue;
        try {
          parseCron(s);
          t.schedule.push(s);
        } catch (e) {
          c.err(cronNode, (e as Error).message);
        }
      }
      return;
    }
    const v = valueNode;
    const isEmpty = v == null || (isScalar(v) && v.value == null);
    if (!isEmpty && !isMap(v)) return c.err(v, `on.${name} は設定の並び（または {}）で書いてください`);
    const m = isMap(v) ? v : null;
    if (name === "push") {
      if (m) checkKeys(c, m, ["branches", "tags", "paths"], "on.push");
      t.push = {
        ...(m && get(m, "branches") ? { branches: strList(c, get(m, "branches"), "branches") } : {}),
        ...(m && get(m, "tags") ? { tags: strList(c, get(m, "tags"), "tags") } : {}),
        ...(m && get(m, "paths") ? { paths: strList(c, get(m, "paths"), "paths") } : {}),
      };
    } else if (name === "pull_request") {
      if (m) checkKeys(c, m, ["branches"], "on.pull_request");
      t.pull_request = m && get(m, "branches") ? { branches: strList(c, get(m, "branches"), "branches") } : {};
    } else if (name === "delete") {
      if (m) checkKeys(c, m, ["branches"], "on.delete");
      t.delete = m && get(m, "branches") ? { branches: strList(c, get(m, "branches"), "branches") } : {};
    } else {
      if (m) checkKeys(c, m, ["inputs"], "on.manual");
      const inputs: NonNullable<Triggers["manual"]>["inputs"] = {};
      const im = m ? get(m, "inputs") : undefined;
      if (im && isMap(im)) {
        for (const p of im.items) {
          const k = key(p);
          if (!k || !ID.test(k)) {
            c.err(p.key as Node, "inputs の名前が正しくありません");
            continue;
          }
          const d = p.value as Node;
          const dm = isMap(d) ? d : null;
          inputs[k] = {
            ...(dm && get(dm, "description") ? { description: str(c, get(dm, "description"), "description") } : {}),
            ...(dm && get(dm, "default") ? { default: str(c, get(dm, "default"), "default") } : {}),
            ...(dm && get(dm, "required") ? { required: isScalar(get(dm, "required")) && (get(dm, "required") as { value: unknown }).value === true } : {}),
          };
        }
      }
      t.manual = { inputs };
    }
  };
  if (isScalar(n)) add(String(n.value), n, null);
  else if (isSeq(n)) for (const it of n.items as Node[]) add(isScalar(it) ? String(it.value) : "", it, null);
  else if (isMap(n)) for (const p of n.items) add(key(p) ?? "", p.key as Node, p.value as Node);
  else c.err(n, "on の書き方が正しくありません");
  if (Object.keys(t).length === 0 && c.problems.length === 0) c.err(n, "on に実行の契機がありません");
  return t;
}

function concurrency(c: Ctx, n: Node | undefined): Concurrency | undefined {
  if (n === undefined) return undefined;
  if (isScalar(n)) {
    const g = str(c, n, "concurrency");
    return g ? { group: g, cancelInProgress: true } : undefined;
  }
  if (!isMap(n)) {
    c.err(n, "concurrency は文字列か {group, cancel-in-progress} で書いてください");
    return undefined;
  }
  checkKeys(c, n, ["group", "cancel-in-progress"], "concurrency");
  const g = get(n, "group") ? str(c, get(n, "group"), "concurrency.group") : undefined;
  if (!g) {
    c.err(n, "concurrency.group がありません");
    return undefined;
  }
  const cip = get(n, "cancel-in-progress");
  return { group: g, cancelInProgress: cip === undefined ? true : isScalar(cip) && cip.value === true };
}

type Scalar = string | number | boolean;
function scalarValue(c: Ctx, n: Node, what: string): Scalar | undefined {
  if (isScalar(n) && (typeof n.value === "string" || typeof n.value === "number" || typeof n.value === "boolean")) return n.value;
  c.err(n, `${what} は文字列・数値・真偽値で書いてください`);
  return undefined;
}

function matrix(c: Ctx, n: Node | undefined): Matrix | undefined {
  if (n === undefined) return undefined;
  if (!isMap(n)) {
    c.err(n, "matrix は「名前: [値, …]」の形で書いてください");
    return undefined;
  }
  const m: Matrix = { axes: {}, include: [], exclude: [] };
  const combos = (node: Node | null | undefined, what: string) => {
    if (!isSeq(node)) {
      c.err(node, `matrix.${what} は組み合わせの並びで書いてください`);
      return [];
    }
    return (node.items as Node[]).flatMap((it) => {
      if (!isMap(it)) {
        c.err(it, `matrix.${what} の各項目は「名前: 値」で書いてください`);
        return [];
      }
      const o: Record<string, Scalar> = {};
      for (const p of it.items) {
        const v = scalarValue(c, p.value as Node, `matrix.${what}`);
        if (key(p) && v !== undefined) o[key(p)!] = v;
      }
      return [o];
    });
  };
  for (const p of n.items) {
    const k = key(p);
    if (!k) continue;
    if (k === "include") m.include = combos(p.value as Node, "include");
    else if (k === "exclude") m.exclude = combos(p.value as Node, "exclude");
    else if (isSeq(p.value)) {
      const vals = (p.value.items as Node[]).map((x) => scalarValue(c, x, `matrix.${k}`)).filter((x): x is Scalar => x !== undefined);
      if (vals.length === 0) c.err(p.value as Node, `matrix.${k} に値がありません`);
      m.axes[k] = vals;
    } else c.err(p.value as Node, `matrix.${k} は値の並びで書いてください`);
  }
  try {
    if (expandMatrix(m).length === 0) c.err(n, "matrix の組み合わせがありません");
  } catch (e) {
    c.err(n, (e as Error).message);
  }
  return m;
}

function steps(c: Ctx, n: Node | undefined, jobId: string): Step[] {
  if (!isSeq(n) || n.items.length === 0) {
    c.err(n, `jobs.${jobId}.steps に手順がありません`);
    return [];
  }
  const out: Step[] = [];
  const ids = new Set<string>();
  (n.items as Node[]).forEach((it, i) => {
    const where = `jobs.${jobId}.steps[${i + 1}]`;
    if (!isMap(it)) return c.err(it, `${where} は設定の並びで書いてください`);
    checkKeys(c, it, ["id", "name", "run", "uses", "with", "distribute", "env", "if", "working-directory", "timeout", "continue-on-error"], where);
    const kinds = ["run", "uses", "distribute"].filter((k) => get(it, k) !== undefined);
    if (kinds.length !== 1) return c.err(it, `${where} には run・uses・distribute のどれか一つを書いてください`);
    const name = get(it, "name") ? str(c, get(it, "name"), "name") : undefined;
    const ifs = checkExpr(c, get(it, "if"), `${where}.if`);
    const env = strMap(c, get(it, "env"), `${where}.env`);
    const timeoutNode = get(it, "timeout");
    const timeout = timeoutNode ? minutes(c, timeoutNode, `${where}.timeout`) : undefined;
    const coe = get(it, "continue-on-error");
    const continueOnError = isScalar(coe) && coe.value === true;
    // id は後の手順の式で steps.<id>.outputs.<名前> として使う
    const idNode = get(it, "id");
    let id: string | undefined;
    if (idNode !== undefined) {
      id = str(c, idNode, `${where}.id`);
      if (id !== undefined && !ID.test(id)) {
        c.err(idNode, `${where}.id「${id}」は使えません（英字で始まる英数字・_・-）`);
        id = undefined;
      } else if (id !== undefined && ids.has(id)) {
        c.err(idNode, `${where}.id「${id}」は同じジョブの中で重なっています`);
        id = undefined;
      }
      if (id !== undefined) ids.add(id);
    }
    const common = { ...(name ? { name } : {}), ...(ifs ? { if: ifs } : {}) };
    if (kinds[0] === "run") {
      const run = str(c, get(it, "run"), `${where}.run`);
      if (run === undefined || !run.trim()) return c.err(get(it, "run"), `${where}.run が空です`);
      const wd = get(it, "working-directory") ? str(c, get(it, "working-directory"), "working-directory") : undefined;
      out.push({ kind: "run", run, ...(id ? { id } : {}), ...common, ...(Object.keys(env).length ? { env } : {}), ...(wd ? { workingDirectory: wd } : {}), ...(timeout ? { timeout } : {}), ...(continueOnError ? { continueOnError } : {}) });
    } else if (kinds[0] === "uses") {
      const uses = str(c, get(it, "uses"), `${where}.uses`);
      if (!uses) return;
      const base = uses.split("@")[0]!;
      if (!(BUILTIN_COMPONENTS as readonly string[]).includes(base)) {
        return c.err(get(it, "uses"), `組み込み部品「${uses}」はありません（使えるもの：${BUILTIN_COMPONENTS.join("・")}）`);
      }
      const w = strMap(c, get(it, "with"), `${where}.with`);
      out.push({ kind: "uses", uses, ...(id ? { id } : {}), ...common, ...(Object.keys(w).length ? { with: w } : {}), ...(Object.keys(env).length ? { env } : {}), ...(timeout ? { timeout } : {}), ...(continueOnError ? { continueOnError } : {}) });
    } else {
      const d = get(it, "distribute");
      if (!isMap(d)) return c.err(d, `${where}.distribute は {platform, file} で書いてください`);
      checkKeys(c, d, ["platform", "file", "install"], `${where}.distribute`);
      const platform = get(d, "platform") ? str(c, get(d, "platform"), "platform") : undefined;
      const file = get(d, "file") ? str(c, get(d, "file"), "file") : undefined;
      if (!platform || !["android", "ios", "macos", "linux"].includes(platform)) return c.err(get(d, "platform") ?? d, "distribute.platform は android・ios・macos・linux のどれかです");
      if (!file) return c.err(d, "distribute.file がありません");
      if (idNode !== undefined) c.err(idNode, `${where}.id は distribute には書けません`);
      // 導入の設定（例 package: com.example.app、bundle: Example.app、bundle_id、when_running: wait|next_launch|restart、health_seconds）
      const install = strMap(c, get(d, "install"), `${where}.distribute.install`);
      out.push({ kind: "distribute", platform, file, ...(Object.keys(install).length ? { install } : {}), ...common });
    }
  });
  return out;
}

function minutes(c: Ctx, n: Node, what: string): number | undefined {
  if (isScalar(n) && typeof n.value === "number" && Number.isInteger(n.value) && n.value >= 1 && n.value <= MAX_TIMEOUT_MINUTES) return n.value;
  c.err(n, `${what} は 1〜${MAX_TIMEOUT_MINUTES} の整数（分）で書いてください`);
  return undefined;
}

function job(c: Ctx, p: Pair): Job | null {
  const id = key(p);
  const keyNode = p.key as Node;
  if (!id || !ID.test(id)) {
    c.err(keyNode, `ジョブ名「${id ?? ""}」は使えません（英字で始まる英数字・_・-）`);
    return null;
  }
  const n = p.value as Node;
  if (!isMap(n)) {
    c.err(n ?? keyNode, `jobs.${id} は設定の並びで書いてください`);
    return null;
  }
  const where = `jobs.${id}`;
  checkKeys(c, n, ["name", "runs-on", "needs", "if", "env", "secrets", "timeout", "timeout-minutes", "concurrency", "matrix", "strategy", "steps", "artifacts", "cache", "rerun"], where);
  const runsOnNode = get(n, "runs-on");
  if (runsOnNode === undefined) c.err(keyNode, `${where}.runs-on（実行環境のラベル）がありません`);
  const runsOn = runsOnNode === undefined ? [] : strList(c, runsOnNode, "runs-on");
  const secretsNode = get(n, "secrets");
  const secrets = secretsNode === undefined ? [] : strList(c, secretsNode, "secrets");
  for (const s of secrets) if (!SECRET_NAME.test(s)) c.err(secretsNode, `秘密情報の名前「${s}」は使えません（英大文字・数字・_）`);
  const timeoutNode = get(n, "timeout") ?? get(n, "timeout-minutes");
  const timeout = timeoutNode ? (minutes(c, timeoutNode, `${where}.timeout`) ?? DEFAULT_TIMEOUT_MINUTES) : DEFAULT_TIMEOUT_MINUTES;
  // Actions の strategy.matrix も受け付ける
  const strategy = get(n, "strategy");
  const matrixNode = get(n, "matrix") ?? (isMap(strategy) ? get(strategy, "matrix") : undefined);
  const artifactsNode = get(n, "artifacts");
  const artifacts: Job["artifacts"] = [];
  if (artifactsNode !== undefined) {
    if (!isSeq(artifactsNode)) c.err(artifactsNode, `${where}.artifacts は {name, path} の並びで書いてください`);
    else
      for (const a of artifactsNode.items as Node[]) {
        if (!isMap(a) || !get(a, "name") || !get(a, "path")) {
          c.err(a, `${where}.artifacts の各項目には name と path が必要です`);
          continue;
        }
        artifacts.push({ name: str(c, get(a, "name"), "name") ?? "", path: str(c, get(a, "path"), "path") ?? "" });
      }
  }
  const cacheNode = get(n, "cache");
  let cache: Job["cache"];
  if (cacheNode !== undefined) {
    if (!isMap(cacheNode) || !get(cacheNode, "key") || !get(cacheNode, "paths")) c.err(cacheNode, `${where}.cache には key と paths が必要です`);
    else cache = { key: str(c, get(cacheNode, "key"), "cache.key") ?? "", paths: strList(c, get(cacheNode, "paths"), "cache.paths") };
  }
  const rerun = get(n, "rerun");
  const needsNode = getPair(n, "needs");
  return {
    id,
    ...(get(n, "name") ? { name: str(c, get(n, "name"), "name") } : {}),
    runsOn,
    needs: needsNode ? strList(c, needsNode.value as Node, "needs") : [],
    ...(get(n, "if") !== undefined ? { if: checkExpr(c, get(n, "if"), `${where}.if`) } : {}),
    env: strMap(c, get(n, "env"), `${where}.env`),
    secrets,
    timeout,
    ...(get(n, "concurrency") !== undefined ? { concurrency: concurrency(c, get(n, "concurrency")) } : {}),
    ...(matrixNode !== undefined ? { matrix: matrix(c, matrixNode) } : {}),
    steps: steps(c, get(n, "steps"), id),
    artifacts,
    ...(cache ? { cache } : {}),
    rerunnable: !(isScalar(rerun) && rerun.value === false),
    line: c.pos(keyNode).line,
  };
}

/** needs の参照先の有無と、循環を確かめる */
function checkGraph(c: Ctx, jobs: Job[], jobsNode: YAMLMap): void {
  const ids = new Set(jobs.map((j) => j.id));
  const nodeOf = (id: string) => (getPair(jobsNode, id)?.value as YAMLMap | undefined) ?? jobsNode;
  for (const j of jobs) {
    for (const d of j.needs) {
      if (!ids.has(d)) c.err(get(nodeOf(j.id), "needs") ?? nodeOf(j.id), `jobs.${j.id}.needs の「${d}」というジョブはありません`);
      if (d === j.id) c.err(get(nodeOf(j.id), "needs") ?? nodeOf(j.id), `jobs.${j.id} が自分自身を needs にしています`);
    }
  }
  const state = new Map<string, 0 | 1 | 2>();
  const byId = new Map(jobs.map((j) => [j.id, j]));
  const visit = (id: string, path: string[]): boolean => {
    if (state.get(id) === 2) return false;
    if (state.get(id) === 1) {
      const cycle = [...path.slice(path.indexOf(id)), id];
      c.err(get(nodeOf(id), "needs") ?? nodeOf(id), `needs が循環しています：${cycle.join(" → ")}`);
      return true;
    }
    state.set(id, 1);
    for (const d of byId.get(id)?.needs ?? []) if (byId.has(d) && d !== id && visit(d, [...path, id])) return true;
    state.set(id, 2);
    return false;
  };
  for (const j of jobs) if (visit(j.id, [])) break;
}

export function parseWorkflow(file: string, text: string): ParseResult {
  if (new TextEncoder().encode(text).length > MAX_FILE_BYTES) {
    return { ok: false, problems: [{ file, line: 1, column: 1, message: `定義ファイルが大きすぎます（${MAX_FILE_BYTES / 1024} KB まで）` }] };
  }
  const lc = new LineCounter();
  const doc = parseDocument(text, { lineCounter: lc, uniqueKeys: true, prettyErrors: false, strict: true });
  const c = new Ctx(file, lc);
  for (const e of [...doc.errors, ...doc.warnings]) {
    const p = lc.linePos(e.pos[0]);
    c.problems.push({ file, line: p.line, column: p.col, message: `YAML の書き方が正しくありません：${e.message.split("\n")[0]}` });
  }
  if (c.problems.length) return { ok: false, problems: c.problems };
  const root = doc.contents as Node | null;
  if (!isMap(root)) return { ok: false, problems: [{ file, line: 1, column: 1, message: "定義ファイルの最上位は「名前: 値」の並びにしてください" }] };
  checkKeys(c, root, ["name", "on", "env", "jobs"], "最上位");
  const on = triggers(c, get(root, "on"));
  const jobsNode = get(root, "jobs");
  const jobs: Job[] = [];
  if (!isMap(jobsNode) || jobsNode.items.length === 0) c.err(jobsNode ?? root, "jobs にジョブがありません");
  else {
    for (const p of jobsNode.items) {
      const j = job(c, p);
      if (j) jobs.push(j);
    }
    checkGraph(c, jobs, jobsNode);
  }
  const workflow: Workflow = {
    file,
    name: get(root, "name") ? (str(c, get(root, "name"), "name") ?? file) : file,
    on,
    env: strMap(c, get(root, "env"), "env"),
    jobs,
  };
  c.problems.sort((a, b) => a.line - b.line || a.column - b.column);
  return c.problems.length ? { ok: false, problems: c.problems } : { ok: true, workflow };
}

/** needs に従った実行の順（循環が無い前提） */
export function topoOrder(jobs: Job[]): Job[] {
  const done = new Set<string>();
  const out: Job[] = [];
  const byId = new Map(jobs.map((j) => [j.id, j]));
  const visit = (j: Job) => {
    if (done.has(j.id)) return;
    done.add(j.id);
    for (const d of j.needs) {
      const dj = byId.get(d);
      if (dj) visit(dj);
    }
    out.push(j);
  };
  jobs.forEach(visit);
  return out;
}
