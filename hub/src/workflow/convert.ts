/**
 * 移行ツール：GitHub Actions の定義（.github/workflows/*.yml）を Upbeater の定義（.upbeater/*.yml）に変換する。
 * Workers に依存しない（利用者の PC の migrate.mjs と、開発順序4の MCP の migrate_workflows で使う）。
 *
 * 報告は 2 段階：
 *   error   … そのままでは同じ動きにならない。定義では、その手順を失敗させる run に置き換える（黙って抜け落ちない）
 *   warning … 動きは変わらないか、差が小さい
 */
import { Document, isMap, isScalar, isSeq, LineCounter, parseDocument, type Node, type Pair, type YAMLMap } from "yaml";
import { parseWorkflow } from "./parse";
import type { Problem } from "./types";

export interface ConvertNote {
  file: string;
  line: number;
  level: "error" | "warning";
  message: string;
}

export interface ConvertResult {
  /** 元のファイル（.github/workflows/x.yml） */
  source: string;
  /** 書き出す先（.upbeater/x.yml） */
  file: string;
  text: string;
  notes: ConvertNote[];
  /** 書き出した定義の検証の誤り（空なら Hub がそのまま読める） */
  problems: Problem[];
}

export interface ConvertOptions {
  /** runs-on のラベルの置き換え（標準の置き換えの後に当てる。例 { linux: "macos" }） */
  labels?: Record<string, string>;
}

type J = Record<string, unknown>;

/** Actions の部品 → 組み込み部品と、引き継ぐ with の名前（それ以外の with は注意として報告） */
const COMPONENTS: Record<string, { to: string; keep: string[]; warn?: Record<string, string> }> = {
  "actions/checkout": { to: "checkout", keep: ["fetch-depth", "path"] },
  "actions/setup-node": { to: "setup-node", keep: ["node-version"], warn: { cache: "setup-node の cache は使いません（毎回取得します）", "cache-dependency-path": "" } },
  "actions/setup-java": { to: "setup-java", keep: ["java-version"], warn: { distribution: "setup-java の distribution は確かめません（Runner の端末に入っている Java を使います）", cache: "setup-java の cache は使いません" } },
  "actions/setup-go": { to: "setup-go", keep: ["go-version"], warn: { cache: "setup-go の cache は使いません" } },
  "actions/setup-python": { to: "setup-python", keep: ["python-version"], warn: { cache: "setup-python の cache は使いません" } },
  "subosito/flutter-action": { to: "setup-flutter", keep: ["flutter-version"], warn: { channel: "", cache: "flutter-action の cache は使いません" } },
  "actions/cache": { to: "cache", keep: ["key", "path"], warn: { "restore-keys": "cache の restore-keys は使いません（key が一致した時だけ戻します）" } },
  "actions/upload-artifact": { to: "upload-artifact", keep: ["name", "path"], warn: { "retention-days": "成果物の保存期間（retention-days）は Hub の設定に従います", "if-no-files-found": "" } },
  "actions/download-artifact": { to: "download-artifact", keep: ["name", "path"] },
};

const EVENT_NAMES: Record<string, string> = { workflow_dispatch: "manual", push: "push", pull_request: "pull_request", schedule: "schedule", delete: "delete" };
const FUNCS = new Set(["success", "failure", "always", "cancelled", "contains", "startsWith", "endsWith"]);

type ExprPlace = "job-if" | "step-if" | "run" | "value";

class Converter {
  notes: ConvertNote[] = [];
  private readonly lc = new LineCounter();
  private doc!: ReturnType<typeof parseDocument>;
  /** 部品の行（同じ行への同じ報告を重ねない） */
  private seen = new Set<string>();

  constructor(
    readonly source: string,
    readonly text: string,
    readonly opts: ConvertOptions,
  ) {}

  line(n: Node | null | undefined): number {
    return this.lc.linePos(n?.range?.[0] ?? 0).line;
  }
  note(n: Node | null | undefined, level: ConvertNote["level"], message: string): void {
    const line = this.line(n);
    const k = `${line}\u0000${level}\u0000${message}`;
    if (this.seen.has(k)) return;
    this.seen.add(k);
    this.notes.push({ file: this.source, line, level, message });
  }

  run(): J | null {
    this.doc = parseDocument(this.text, { lineCounter: this.lc, prettyErrors: false });
    if (this.doc.errors.length) {
      for (const e of this.doc.errors) this.notes.push({ file: this.source, line: this.lc.linePos(e.pos[0]).line, level: "error", message: `YAML の書き方が正しくありません：${e.message.split("\n")[0]}` });
      return null;
    }
    const root = this.doc.contents as Node | null;
    if (!isMap(root)) {
      this.notes.push({ file: this.source, line: 1, level: "error", message: "ワークフローの最上位が「名前: 値」の並びではありません" });
      return null;
    }
    const out: J = {};
    const name = val(root, "name");
    if (name !== undefined) out.name = String(name);
    out.on = this.triggers(get(root, "on") ?? undefined, root);
    const wfEnv = this.envMap(get(root, "env"), "value");
    if (Object.keys(wfEnv).length) out.env = wfEnv;
    const wfSecrets = collectSecrets(get(root, "env"));
    const wfConcurrency = get(root, "concurrency");
    const wfDefaults = workingDir(get(root, "defaults"));
    for (const p of root.items) {
      const k = keyOf(p);
      if (k === "run-name") this.note(p.key as Node, "warning", "run-name（実行の表示名）は使いません");
      else if (k === "permissions") this.note(p.key as Node, "warning", permissionsNote(p.value as Node));
      else if (k === "defaults") this.defaultsNotes(p.value as Node);
      else if (!["name", "on", "env", "concurrency", "jobs"].includes(k ?? "")) this.note(p.key as Node, "error", `最上位の「${k}」は Upbeater にありません`);
    }
    const jobsNode = get(root, "jobs");
    if (!isMap(jobsNode)) {
      this.note(root, "error", "jobs がありません");
      return out;
    }
    const uploads = new Map<string, string[]>();
    for (const p of jobsNode.items) {
      const id = keyOf(p);
      if (id && isMap(p.value)) uploads.set(id, uploadNames(p.value));
    }
    const needsOf = new Map<string, string[]>();
    for (const p of jobsNode.items) {
      const id = keyOf(p);
      if (id && isMap(p.value)) needsOf.set(id, list(get(p.value, "needs")));
    }
    const jobs: J = {};
    for (const p of jobsNode.items) {
      const id = keyOf(p);
      if (!id || !isMap(p.value)) {
        this.note(p.key as Node, "error", `ジョブ「${id ?? ""}」の書き方が正しくありません`);
        continue;
      }
      jobs[id] = this.job(id, p.value, { wfSecrets, wfConcurrency, wfDefaults, uploads, needsOf });
    }
    out.jobs = jobs;
    return out;
  }

  private defaultsNotes(n: Node): void {
    if (!isMap(n)) return;
    const r = get(n, "run");
    if (isMap(r)) {
      const sh = val(r, "shell");
      if (sh !== undefined && !String(sh).startsWith("bash") && String(sh) !== "sh") this.note(get(r, "shell"), "error", `defaults.run.shell「${sh}」は使えません（Upbeater の run は bash です）`);
    }
  }

  private triggers(n: Node | undefined, root: YAMLMap): J {
    const on: J = {};
    if (n === undefined) {
      this.note(root, "error", "on（いつ実行するか）がありません");
      return on;
    }
    const add = (name: string, node: Node, v: Node | null | undefined) => {
      const m = isMap(v) ? v : null;
      switch (name) {
        case "push": {
          const t: J = {};
          if (m) {
            const b = this.globs(m, "branches", "branches-ignore");
            if (b) t.branches = b;
            const tg = this.globs(m, "tags", "tags-ignore");
            if (tg) t.tags = tg;
            const ps = this.globs(m, "paths", "paths-ignore");
            // 定義そのものの変更で動かす指定は、移した先（.upbeater/）を指すようにする
            if (ps) t.paths = ps.map((x) => x.replace(/^(!?)\.github\/workflows\/([^/*]+?)\.ya?ml$/, "$1.upbeater/$2.yml"));
            this.otherKeys(m, ["branches", "branches-ignore", "tags", "tags-ignore", "paths", "paths-ignore"], "on.push");
          }
          on.push = t;
          break;
        }
        case "pull_request":
        case "pull_request_target": {
          if (name === "pull_request_target") this.note(node, "warning", "pull_request_target は pull_request として扱います（フォークからの PR には秘密情報を渡しません）");
          const t: J = {};
          if (m) {
            const b = this.globs(m, "branches", "branches-ignore");
            if (b) t.branches = b;
            if (get(m, "paths") || get(m, "paths-ignore")) this.note(get(m, "paths") ?? get(m, "paths-ignore"), "warning", "pull_request の paths・paths-ignore は使いません（PR ではいつも動きます）");
            if (get(m, "types")) this.note(get(m, "types"), "warning", "pull_request の types は使いません（PR を開いた時と更新した時に動きます）");
            this.otherKeys(m, ["branches", "branches-ignore", "paths", "paths-ignore", "types"], `on.${name}`);
          }
          on.pull_request = t;
          break;
        }
        case "workflow_dispatch": {
          const t: J = {};
          const im = m ? get(m, "inputs") : undefined;
          if (isMap(im)) {
            const inputs: J = {};
            for (const ip of im.items) {
              const k = keyOf(ip);
              if (!k) continue;
              const d = isMap(ip.value) ? ip.value : null;
              const o: J = {};
              for (const f of ["description", "default", "required"] as const) {
                const x = d ? val(d, f) : undefined;
                if (x !== undefined) o[f] = f === "required" ? x === true : String(x);
              }
              if (d && (get(d, "type") || get(d, "options"))) {
                const ty = val(d, "type");
                if (ty !== undefined && ty !== "string") this.note(get(d, "type") ?? d, "warning", `inputs.${k} の type（${ty}）は文字列として渡します`);
              }
              inputs[k] = o;
            }
            t.inputs = inputs;
          }
          on.manual = t;
          break;
        }
        case "schedule": {
          const crons: string[] = [];
          if (isSeq(v)) for (const it of v.items as Node[]) {
            const c = isMap(it) ? val(it, "cron") : isScalar(it) ? it.value : undefined;
            if (c !== undefined) crons.push(String(c));
          }
          on.schedule = crons;
          break;
        }
        case "delete": {
          on.delete = {};
          this.note(node, "warning", "delete はブランチの削除だけを合図にします（タグの削除では動きません）");
          break;
        }
        default:
          this.note(node, "error", `合図「${name}」は Upbeater にありません（使えるもの：push・pull_request・workflow_dispatch・schedule・delete）`);
      }
    };
    if (isScalar(n)) add(String(n.value), n, null);
    else if (isSeq(n)) for (const it of n.items as Node[]) add(isScalar(it) ? String(it.value) : "", it, null);
    else if (isMap(n)) for (const p of n.items) add(keyOf(p) ?? "", p.key as Node, p.value as Node);
    return on;
  }

  /** branches と branches-ignore を Upbeater の型（! で除外）にまとめる */
  private globs(m: YAMLMap, inc: string, exc: string): string[] | undefined {
    const a = get(m, inc);
    const b = get(m, exc);
    if (a === undefined && b === undefined) return undefined;
    if (b === undefined) return list(a);
    return [...(a === undefined ? ["**"] : list(a)), ...list(b).map((x) => `!${x}`)];
  }

  private otherKeys(m: YAMLMap, known: string[], where: string): void {
    for (const p of m.items) {
      const k = keyOf(p);
      if (k && !known.includes(k)) this.note(p.key as Node, "error", `${where} の「${k}」は Upbeater にありません`);
    }
  }

  private job(
    id: string,
    n: YAMLMap,
    ctx: { wfSecrets: Set<string>; wfConcurrency: Node | undefined; wfDefaults: string | undefined; uploads: Map<string, string[]>; needsOf: Map<string, string[]> },
  ): J {
    const out: J = {};
    const name = val(n, "name");
    if (name !== undefined) out.name = String(name);
    if (get(n, "uses")) {
      this.note(get(n, "uses"), "error", "再利用のワークフロー（jobs.<id>.uses）は使えません。呼び出し先のジョブを、この定義に書き写してください");
      out["runs-on"] = "linux";
      out.steps = [this.failStep(`jobs.${id}.uses（再利用のワークフロー）は変換できません`)];
      return out;
    }
    out["runs-on"] = this.runsOn(get(n, "runs-on"), id);
    const needs = list(get(n, "needs"));
    if (needs.length) out.needs = needs.length === 1 ? needs[0] : needs;
    const ifNode = get(n, "if");
    if (ifNode !== undefined) out.if = this.expr(String(val(n, "if")), ifNode, "job-if");
    const env = this.envMap(get(n, "env"), "value");
    if (Object.keys(env).length) out.env = env;
    const timeout = val(n, "timeout-minutes");
    if (timeout !== undefined) {
      if (typeof timeout === "number") out.timeout = timeout;
      else this.note(get(n, "timeout-minutes"), "error", "timeout-minutes は数で書いてください（式は使えません）");
    }
    // concurrency：ジョブのものを優先。ワークフロー全体のものはジョブ名を足して各ジョブへ
    const jc = get(n, "concurrency");
    if (jc !== undefined) out.concurrency = this.concurrency(jc, null);
    else if (ctx.wfConcurrency !== undefined) out.concurrency = this.concurrency(ctx.wfConcurrency, id);
    const strategy = get(n, "strategy");
    if (isMap(strategy)) {
      const mx = get(strategy, "matrix");
      if (isMap(mx)) {
        const m = mx.toJSON() as J;
        if (/\$\{\{/.test(JSON.stringify(m))) this.note(mx, "error", "matrix の値に式は使えません");
        out.matrix = m;
      } else if (mx != null) this.note(mx, "error", "matrix を式で作ることはできません");
      for (const p of strategy.items) {
        const k = keyOf(p);
        if (k === "fail-fast" || k === "max-parallel") this.note(p.key as Node, "warning", `strategy.${k} は使いません`);
        else if (k !== "matrix") this.note(p.key as Node, "error", `strategy.${k} は Upbeater にありません`);
      }
    }
    const wd = workingDir(get(n, "defaults")) ?? ctx.wfDefaults;
    if (get(n, "defaults")) this.defaultsNotes(get(n, "defaults")!);
    for (const p of n.items) {
      const k = keyOf(p) ?? "";
      if (["name", "runs-on", "needs", "if", "env", "timeout-minutes", "concurrency", "strategy", "steps", "defaults"].includes(k)) continue;
      if (k === "permissions") this.note(p.key as Node, "warning", permissionsNote(p.value as Node));
      else if (k === "environment") this.note(p.key as Node, "warning", "environment（承認・環境ごとの秘密情報）は使いません。秘密情報はリポジトリ専用として Hub に登録してください");
      else if (k === "outputs") this.note(p.key as Node, "error", "ジョブの outputs（needs.<id>.outputs）は Upbeater にありません。成果物（upload-artifact）で渡してください");
      else if (k === "continue-on-error") this.note(p.key as Node, "error", "ジョブの continue-on-error は Upbeater にありません（手順の continue-on-error は使えます）");
      else if (k === "services" || k === "container") this.note(p.key as Node, "error", `${k}（コンテナ）は Upbeater にありません。Runner の端末に必要なものを入れてください`);
      else this.note(p.key as Node, "error", `jobs.${id} の「${k}」は Upbeater にありません`);
    }
    const stepsNode = get(n, "steps");
    const fromLinux = list(get(n, "runs-on")).some((l) => /^ubuntu-/.test(l));
    const runsOnMac = ([] as string[]).concat(out["runs-on"] as string | string[]).includes("macos");
    if (fromLinux && runsOnMac && isSeq(stepsNode)) this.linuxOnMac(stepsNode, id);
    const steps: J[] = [];
    if (isSeq(stepsNode)) {
      for (const it of stepsNode.items as Node[]) {
        if (!isMap(it)) continue;
        steps.push(...this.step(it, id, wd, ctx));
      }
    }
    if (steps.length === 0) steps.push(this.failStep(`jobs.${id} に手順がありません`));
    out.steps = steps;
    // 秘密情報：ジョブ・手順・ワークフロー全体の env で参照しているものを、ジョブの secrets にする
    const secrets = new Set([...ctx.wfSecrets, ...collectSecrets(n)]);
    if (secrets.size) out.secrets = [...secrets].sort();
    // 公開など二重に行うと困る手順を含むなら、心拍の途絶で自動の再実行をしない
    if (secrets.size && /deploy|publish|release|公開|リリース/i.test(`${id} ${name ?? ""}`)) {
      out.rerun = false;
      this.note(get(n, "steps") ?? n, "warning", `jobs.${id} は公開の手順と見て、Runner が途中で落ちても自動で再実行しない（rerun: false）にしました`);
    }
    return order(out, ["name", "runs-on", "needs", "if", "timeout", "concurrency", "matrix", "secrets", "rerun", "env", "steps"]);
  }

  /** Linux 用の台本を macOS で動かす時に、書き方が違うコマンドを知らせる */
  private linuxOnMac(stepsNode: Node, id: string): void {
    const rules: [RegExp, string][] = [
      [/\bsed\s+(-[A-Za-z]*\s+)*-i\s+(?!['"]?\.)/, "sed -i（macOS では -i の後に拡張子が要ります。どちらでも動く書き方：sed -i.bak … && rm ….bak）"],
      [/\bdate\b[^\n|;]*\s-d\s/, "date -d（macOS にはありません。日本時間なら TZ=Asia/Tokyo date '+%Y-%m-%d %H:%M' がどちらでも動きます）"],
      [/\bgrep\s+(-[A-Za-z]*\s+)*-P\b/, "grep -P（macOS にはありません）"],
      [/\breadlink\s+-f\b/, "readlink -f（古い macOS にはありません）"],
      [/\b(apt-get|apt)\s+install\b/, "apt-get（macOS にはありません）"],
      [/\bbase64\s+(-w|--wrap)/, "base64 -w（macOS にはありません）"],
    ];
    for (const st of (isSeq(stepsNode) ? stepsNode.items : []) as Node[]) {
      if (!isMap(st)) continue;
      const run = val(st, "run");
      if (typeof run !== "string") continue;
      for (const [re, what] of rules) if (re.test(run)) this.note(get(st, "run"), "warning", `jobs.${id} は Linux 用ですが macOS で動かします。${what}`);
    }
  }

  private runsOn(n: Node | undefined, id: string): string | string[] {
    const raw = n === undefined ? [] : isMap(n) ? list(get(n, "labels")) : list(n);
    if (raw.length === 0) {
      this.note(n, "error", `jobs.${id}.runs-on がありません（linux にしました）`);
      return "linux";
    }
    const mapped: string[] = [];
    for (const l of raw) {
      let to: string | null;
      if (/\$\{\{/.test(l)) {
        this.note(n, "error", `runs-on に式（${l}）は使えません`);
        to = "linux";
      } else if (/^ubuntu-/.test(l)) to = "linux";
      else if (/^macos-/.test(l)) to = "macos";
      else if (/^windows-/.test(l)) {
        this.note(n, "error", "Windows の Runner はありません");
        to = "windows";
      } else if (l === "self-hosted") to = null;
      else to = l;
      if (to !== null) {
        const o = this.opts.labels?.[to];
        if (o) {
          to = o;
        }
        if (!mapped.includes(to)) mapped.push(to);
      }
    }
    if (mapped.length === 0) mapped.push("linux");
    return mapped.length === 1 ? mapped[0]! : mapped;
  }

  private concurrency(n: Node, jobId: string | null): J | string {
    let group: string;
    let cancel: boolean | undefined;
    if (isMap(n)) {
      group = String(val(n, "group") ?? "");
      const c = val(n, "cancel-in-progress");
      if (c !== undefined && typeof c !== "boolean") this.note(get(n, "cancel-in-progress"), "error", "cancel-in-progress は true か false で書いてください（式は使えません）");
      cancel = typeof c === "boolean" ? c : false;
    } else {
      group = String((n as { value?: unknown }).value ?? "");
      cancel = false;
    }
    group = this.groupExpr(group, n);
    if (jobId) {
      group = `${group}-${jobId}`;
      this.note(n, "warning", "ワークフロー全体の concurrency は、ジョブごとに分けて設定しました（新しい実行が来たら、古い実行の同じジョブを止めます）");
    }
    // Actions の既定は cancel-in-progress: false（順番待ち）。Upbeater の既定は true なので、必ず書く
    return { group, "cancel-in-progress": cancel };
  }

  private groupExpr(group: string, n: Node): string {
    return group.replace(/\$\{\{([\s\S]*?)\}\}/g, (m, inner: string) => {
      const x = inner.trim();
      const map: Record<string, string> = { "github.ref": "ref", "github.head_ref || github.ref": "ref", "github.ref_name": "branch", "github.event_name": "event", "github.workflow": "" };
      if (x in map) return map[x] ? `\${{ ${map[x]} }}` : "";
      if (/^matrix\.[A-Za-z0-9_-]+$/.test(x)) return `\${{ ${x} }}`;
      if (/^(github\.event\.pull_request\.number|github\.head_ref)/.test(x)) return "${{ ref }}";
      this.note(n, "error", `concurrency の group の式（${m}）は使えません（使えるもの：github.ref・github.ref_name・github.event_name・matrix.x）`);
      return "";
    });
  }

  private step(n: YAMLMap, jobId: string, defaultWd: string | undefined, ctx: { uploads: Map<string, string[]>; needsOf: Map<string, string[]> }): J[] {
    const out: J = {};
    const id = val(n, "id");
    if (id !== undefined) out.id = String(id);
    const name = val(n, "name");
    if (name !== undefined) out.name = String(name);
    const ifNode = get(n, "if");
    if (ifNode !== undefined) out.if = this.expr(String(val(n, "if")), ifNode, "step-if");
    const env = this.envMap(get(n, "env"), "value");
    if (Object.keys(env).length) out.env = env;
    const t = val(n, "timeout-minutes");
    if (typeof t === "number") out.timeout = t;
    else if (t !== undefined) this.note(get(n, "timeout-minutes"), "error", "timeout-minutes は数で書いてください");
    const coe = val(n, "continue-on-error");
    if (coe === true) out["continue-on-error"] = true;
    else if (coe !== undefined && coe !== false) this.note(get(n, "continue-on-error"), "error", "continue-on-error は true か false で書いてください（式は使えません）");
    for (const p of n.items) {
      const k = keyOf(p) ?? "";
      if (["id", "name", "if", "env", "timeout-minutes", "continue-on-error", "run", "uses", "with", "working-directory", "shell"].includes(k)) continue;
      this.note(p.key as Node, "error", `手順の「${k}」は Upbeater にありません`);
    }
    const runNode = get(n, "run");
    if (runNode !== undefined) {
      out.run = this.template(String(val(n, "run")), runNode, "run");
      const wd = val(n, "working-directory") ?? defaultWd;
      if (wd !== undefined) out["working-directory"] = this.template(String(wd), get(n, "working-directory") ?? runNode, "value");
      const sh = val(n, "shell");
      if (sh !== undefined && !/^(bash|sh)\b/.test(String(sh))) {
        this.note(get(n, "shell"), "error", `shell「${sh}」は使えません（Upbeater の run は bash です）`);
        return [this.failStep(`shell「${sh}」の手順は変換できません`, out)];
      }
      return [order(out, STEP_ORDER)];
    }
    const usesNode = get(n, "uses");
    if (usesNode === undefined) {
      this.note(n, "error", "run も uses も無い手順です");
      return [this.failStep("run も uses も無い手順です", out)];
    }
    const uses = String(val(n, "uses"));
    const base = uses.split("@")[0]!.toLowerCase();
    const comp = COMPONENTS[base];
    if (!comp) {
      this.note(usesNode, "error", `部品「${uses}」は Upbeater にありません。同じことをする run の手順に書き換えてください`);
      return [this.failStep(`部品「${uses}」は変換できません`, out)];
    }
    const withNode = get(n, "with");
    const w: J = {};
    if (isMap(withNode)) {
      for (const p of withNode.items) {
        const k = keyOf(p) ?? "";
        const v = (p.value as Node | null) && isScalar(p.value) ? (p.value as { value: unknown }).value : (p.value as Node)?.toJSON?.();
        if (comp.keep.includes(k)) w[k] = typeof v === "string" ? this.template(v, p.value as Node, "value") : v;
        else if (comp.warn && k in comp.warn) {
          if (comp.warn[k]) this.note(p.key as Node, "warning", comp.warn[k]!);
        } else this.note(p.key as Node, "warning", `${base} の with.${k} は使いません`);
      }
    }
    out.uses = comp.to;
    if (Object.keys(w).length) out.with = w;
    if (comp.to === "download-artifact" && w.name === undefined) {
      // name を省くと、Actions は同じ実行の成果物をすべて <path>/<成果物の名前>/ に取り出す
      const names = [...new Set(ancestors(jobId, ctx.needsOf).flatMap((j) => ctx.uploads.get(j) ?? []))];
      if (names.length === 0 || names.some((x) => /\$\{\{/.test(x))) {
        this.note(usesNode, "error", "download-artifact の name を省いた手順は、取り出す成果物の名前が分からないため変換できません。name を書いてください");
        return [this.failStep("download-artifact の name が分かりません", out)];
      }
      this.note(usesNode, "warning", `download-artifact の name を省いた手順は、成果物ごと（${names.join("・")}）に分けて取り出します`);
      const dir = typeof w.path === "string" ? w.path.replace(/\/+$/, "") : "";
      // Actions は無い成果物を飛ばすので、こちらも無い時は続ける（依存先が if で飛ばされた時など）
      return names.map((nm, i) =>
        order(stripUndefined({ ...out, ...(i > 0 ? { id: undefined, name: undefined } : {}), with: { name: nm, path: dir ? `${dir}/${nm}` : nm }, "continue-on-error": true }), STEP_ORDER),
      );
    }
    return [order(out, STEP_ORDER)];
  }

  private failStep(message: string, base: J = {}): J {
    const o: J = {};
    if (base.name) o.name = base.name;
    if (base.if) o.if = base.if;
    o.run = `echo "移行ツール：${message.replace(/["$`\\]/g, "")}。.upbeater の定義を直してください" >&2\nexit 1`;
    return o;
  }

  private envMap(n: Node | undefined, place: ExprPlace): Record<string, string> {
    const out: Record<string, string> = {};
    if (!isMap(n)) {
      if (n !== undefined && !(isScalar(n) && n.value == null)) this.note(n, "error", "env を式で作ることはできません");
      return out;
    }
    for (const p of n.items) {
      const k = keyOf(p);
      if (!k) continue;
      const v = isScalar(p.value) ? p.value.value : undefined;
      out[k] = this.template(v == null ? "" : String(v), p.value as Node, place);
    }
    return out;
  }

  /** ${{ }} を含む文字列を変換する */
  private template(s: string, n: Node | null | undefined, place: ExprPlace): string {
    return s.replace(/\$\{\{([\s\S]*?)\}\}/g, (m, inner: string) => {
      const x = inner.trim();
      // シェルの中では、Runner が用意する環境変数で書ける
      if (place === "run") {
        if (x === "github.workspace") return "${GITHUB_WORKSPACE}";
        if (x === "runner.temp") return "${RUNNER_TEMP}";
        if (x === "github.run_number") return "${GITHUB_RUN_NUMBER}";
      }
      return `\${{ ${this.expr(x, n, place)} }}`;
    });
  }

  /** 式の中の github.* を Upbeater の名前に直し、使えないものを報告する */
  private expr(src: string, n: Node | null | undefined, place: ExprPlace): string {
    const unwrapped = /^\s*\$\{\{([\s\S]*)\}\}\s*$/.exec(src);
    let text = unwrapped ? unwrapped[1]!.trim() : src.trim();
    const mentionsEvent = /\bgithub\.event_name\b/.test(text);
    const parts = text.split(/('(?:[^']|'')*')/);
    for (let i = 0; i < parts.length; i++) {
      if (i % 2 === 1) {
        // 文字列：event と比べている時は、Actions の合図の名前を Upbeater の名前にする
        const lit = parts[i]!.slice(1, -1);
        if (mentionsEvent && lit in EVENT_NAMES) parts[i] = `'${EVENT_NAMES[lit]}'`;
        continue;
      }
      let p = parts[i]!;
      p = p
        .replace(/\bgithub\.event_name\b/g, "event")
        .replace(/\bgithub\.event\.inputs\.([A-Za-z0-9_-]+)/g, "inputs.$1")
        .replace(/\bgithub\.ref_name\b/g, "branch")
        .replace(/\bgithub\.ref\b(?![\w.])/g, "ref")
        .replace(/\bgithub\.sha\b/g, "sha")
        .replace(/\bgithub\.repository\b(?![\w.])/g, "repo")
        .replace(/\bgithub\.actor\b/g, "actor")
        .replace(/\bgithub\.token\b/g, "secrets.GITHUB_TOKEN");
      if (/\bsecrets\.GITHUB_TOKEN\b/i.test(p)) {
        p = p.replace(/\bsecrets\.github_token\b/gi, "secrets.GITHUB_TOKEN");
        this.note(n, "warning", "GitHub が自動で発行するトークン（github.token）は Upbeater にありません。必要な権限のトークンを、秘密情報 GITHUB_TOKEN として Hub に登録してください");
      }
      p = p.replace(/\bsecrets\.([A-Za-z_][A-Za-z0-9_]*)/g, (_, s: string) => `secrets.${s.toUpperCase()}`);
      for (const m of p.matchAll(/[A-Za-z_][A-Za-z0-9_-]*(?:\.[A-Za-z0-9_*-]+)*/g)) {
        const id = m[0];
        const after = p.slice(m.index! + id.length).trimStart();
        if (after.startsWith("(")) {
          if (!FUNCS.has(id)) this.note(n, "error", `式の関数 ${id}() は Upbeater にありません（使えるもの：${[...FUNCS].join("・")}）`);
          continue;
        }
        if (["true", "false", "null"].includes(id) || /^[0-9]/.test(id)) continue;
        if (!this.knownName(id, place)) this.note(n, "error", `式の「${id}」は${place === "job-if" || place === "step-if" ? " if で" : ""}使えません`);
      }
      parts[i] = p;
    }
    text = parts.join("");
    return text;
  }

  private knownName(id: string, place: ExprPlace): boolean {
    if (["event", "branch", "ref", "sha", "repo", "actor"].includes(id)) return true;
    if (/^(matrix|inputs)\.[A-Za-z0-9_-]+$/.test(id)) return true;
    if (/^needs\.[A-Za-z0-9_-]+\.result$/.test(id)) return place === "job-if";
    if (/^steps\.[A-Za-z0-9_-]+\.(outputs\.[A-Za-z0-9_-]+|outcome|conclusion)$/.test(id)) return place !== "job-if";
    if (/^(secrets|env)\.[A-Za-z_][A-Za-z0-9_]*$/.test(id)) return place === "run" || place === "value";
    return false;
  }
}

function keyOf(p: Pair): string | null {
  return isScalar(p.key) ? String(p.key.value) : null;
}
/** 値が空（null）のキーは null を返す（キーの有無と区別する） */
function get(m: YAMLMap, k: string): Node | undefined {
  const p = m.items.find((i) => keyOf(i) === k);
  return (p?.value as Node | undefined) ?? (p ? (null as unknown as Node) : undefined);
}
function val(m: YAMLMap, k: string): unknown {
  const n = get(m, k);
  return isScalar(n) ? n.value : n == null ? undefined : (n as Node).toJSON();
}
function list(n: Node | null | undefined): string[] {
  if (n == null) return [];
  if (isScalar(n)) return n.value == null ? [] : [String(n.value)];
  if (isSeq(n)) return (n.items as Node[]).filter(isScalar).map((x) => String((x as { value: unknown }).value));
  return [];
}
function workingDir(n: Node | undefined): string | undefined {
  if (!isMap(n)) return undefined;
  const r = get(n, "run");
  if (!isMap(r)) return undefined;
  const w = val(r, "working-directory");
  return w === undefined ? undefined : String(w);
}
function permissionsNote(n: Node): string {
  const s = JSON.stringify(n?.toJSON?.() ?? null);
  return /write/.test(s)
    ? "permissions は使いません。GitHub に書き込む手順には、必要な権限のトークンを秘密情報 GITHUB_TOKEN として Hub に登録してください"
    : "permissions は使いません";
}
function collectSecrets(n: Node | null | undefined): Set<string> {
  const out = new Set<string>();
  if (n == null) return out;
  const walk = (x: unknown) => {
    if (typeof x === "string") {
      for (const m of x.matchAll(/\$\{\{[\s\S]*?\}\}/g)) {
        for (const s of m[0].matchAll(/\bsecrets\.([A-Za-z_][A-Za-z0-9_]*)/g)) out.add(s[1]!.toUpperCase());
        if (/\bgithub\.token\b/.test(m[0])) out.add("GITHUB_TOKEN");
      }
    } else if (Array.isArray(x)) x.forEach(walk);
    else if (x && typeof x === "object") Object.values(x).forEach(walk);
  };
  walk((n as Node).toJSON?.() ?? n);
  return out;
}
function uploadNames(job: YAMLMap): string[] {
  const steps = get(job, "steps");
  if (!isSeq(steps)) return [];
  const out: string[] = [];
  for (const s of steps.items as Node[]) {
    if (!isMap(s)) continue;
    const u = String(val(s, "uses") ?? "").split("@")[0]!.toLowerCase();
    if (u !== "actions/upload-artifact") continue;
    const w = get(s, "with");
    out.push(isMap(w) && val(w, "name") !== undefined ? String(val(w, "name")) : "artifact");
  }
  return out;
}
/** needs をたどった、先に終わるジョブの一覧 */
function ancestors(id: string, needsOf: Map<string, string[]>): string[] {
  const seen = new Set<string>();
  const visit = (j: string) => {
    for (const d of needsOf.get(j) ?? []) {
      if (seen.has(d)) continue;
      seen.add(d);
      visit(d);
    }
  };
  visit(id);
  return [...seen];
}
const STEP_ORDER = ["name", "id", "if", "uses", "with", "run", "working-directory", "env", "timeout", "continue-on-error"];
/** 読みやすい順に並べる */
function order(o: J, keys: string[]): J {
  const out: J = {};
  for (const k of keys) if (k in o) out[k] = o[k];
  for (const k of Object.keys(o)) if (!(k in out)) out[k] = o[k];
  return out;
}
function stripUndefined(o: J): J {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined));
}

/** ファイル名を .github/workflows/x.yml → .upbeater/x.yml にする */
export function targetPath(source: string): string {
  const base = source.split("/").pop()!.replace(/\.yaml$/, ".yml");
  return `.upbeater/${base}`;
}

export function convertWorkflow(source: string, text: string, opts: ConvertOptions = {}): ConvertResult {
  const c = new Converter(source, text, opts);
  const obj = c.run();
  const file = targetPath(source);
  if (!obj) return { source, file, text: "", notes: c.notes, problems: [] };
  const doc = new Document(obj);
  doc.commentBefore = ` ${source} から移行ツールで変換しました（node hub/scripts/migrate.mjs）`;
  const out = doc.toString({ lineWidth: 0 });
  const parsed = parseWorkflow(file, out);
  c.notes.sort((a, b) => a.line - b.line || (a.level === b.level ? 0 : a.level === "error" ? -1 : 1));
  return { source, file, text: out, notes: c.notes, problems: parsed.ok ? [] : parsed.problems };
}
