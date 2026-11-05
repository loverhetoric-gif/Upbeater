/**
 * if の式。使える要素：
 *   文字列 '…'、数値、true・false・null、識別子（event・branch・ref・sha・repo・actor・matrix.x・inputs.x・needs.<job>.result）
 *   == != && || ! ( )、関数 success() failure() always() cancelled() contains(a, b) startsWith(a, b) endsWith(a, b)
 * ${{ … }} で囲ってもよい（Actions の書式との互換）。
 */

export type Value = string | number | boolean | null;

export interface ExprContext {
  vars: Record<string, Value>;
  /** 依存先の結果の集計 */
  status: { anyFailed: boolean; anyCancelled: boolean };
}

type Tok = { t: "str" | "num" | "id" | "op" | "lp" | "rp" | "comma"; v: string; pos: number };

export class ExprError extends Error {
  constructor(
    message: string,
    public readonly pos: number,
  ) {
    super(message);
  }
}

function unwrap(src: string): { text: string; offset: number } {
  const m = /^\s*\$\{\{([\s\S]*)\}\}\s*$/.exec(src);
  return m ? { text: m[1]!, offset: src.indexOf("${{") + 3 } : { text: src, offset: 0 };
}

function tokenize(src: string): Tok[] {
  const out: Tok[] = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i]!;
    if (/\s/.test(c)) {
      i++;
      continue;
    }
    if (c === "'") {
      let j = i + 1;
      let s = "";
      for (;;) {
        if (j >= src.length) throw new ExprError("文字列が閉じていません", i);
        if (src[j] === "'") {
          if (src[j + 1] === "'") {
            s += "'";
            j += 2;
            continue;
          }
          break;
        }
        s += src[j++];
      }
      out.push({ t: "str", v: s, pos: i });
      i = j + 1;
      continue;
    }
    const two = src.slice(i, i + 2);
    if (["==", "!=", "&&", "||"].includes(two)) {
      out.push({ t: "op", v: two, pos: i });
      i += 2;
      continue;
    }
    if (c === "!") {
      out.push({ t: "op", v: "!", pos: i++ });
      continue;
    }
    if (c === "(" || c === ")" || c === ",") {
      out.push({ t: c === "(" ? "lp" : c === ")" ? "rp" : "comma", v: c, pos: i++ });
      continue;
    }
    const num = /^-?\d+(\.\d+)?/.exec(src.slice(i));
    if (num) {
      out.push({ t: "num", v: num[0], pos: i });
      i += num[0].length;
      continue;
    }
    const id = /^[A-Za-z_][A-Za-z0-9_-]*(\.[A-Za-z0-9_-]+)*/.exec(src.slice(i));
    if (id) {
      out.push({ t: "id", v: id[0], pos: i });
      i += id[0].length;
      continue;
    }
    throw new ExprError(`使えない文字です：${c}`, i);
  }
  return out;
}

type Node =
  | { k: "lit"; v: Value }
  | { k: "var"; name: string; pos: number }
  | { k: "not"; e: Node }
  | { k: "bin"; op: string; a: Node; b: Node }
  | { k: "call"; name: string; args: Node[]; pos: number };

const FUNCS: Record<string, number> = { success: 0, failure: 0, always: 0, cancelled: 0, contains: 2, startsWith: 2, endsWith: 2 };

function parseTokens(toks: Tok[]): Node {
  let p = 0;
  const peek = () => toks[p];
  const expect = (t: Tok["t"], what: string) => {
    const k = toks[p];
    if (!k || k.t !== t) throw new ExprError(`${what} が必要です`, k?.pos ?? -1);
    p++;
    return k;
  };
  const primary = (): Node => {
    const k = peek();
    if (!k) throw new ExprError("式が途中で終わっています", -1);
    if (k.t === "op" && k.v === "!") {
      p++;
      return { k: "not", e: primary() };
    }
    if (k.t === "lp") {
      p++;
      const e = or();
      expect("rp", ")");
      return e;
    }
    if (k.t === "str") return p++, { k: "lit", v: k.v };
    if (k.t === "num") return p++, { k: "lit", v: Number(k.v) };
    if (k.t === "id") {
      p++;
      if (k.v === "true" || k.v === "false") return { k: "lit", v: k.v === "true" };
      if (k.v === "null") return { k: "lit", v: null };
      if (peek()?.t === "lp") {
        if (!(k.v in FUNCS)) throw new ExprError(`使えない関数です：${k.v}`, k.pos);
        p++;
        const args: Node[] = [];
        if (peek()?.t !== "rp") {
          args.push(or());
          while (peek()?.t === "comma") {
            p++;
            args.push(or());
          }
        }
        expect("rp", ")");
        if (args.length !== FUNCS[k.v]) throw new ExprError(`${k.v} の引数は ${FUNCS[k.v]} 個です`, k.pos);
        return { k: "call", name: k.v, args, pos: k.pos };
      }
      return { k: "var", name: k.v, pos: k.pos };
    }
    throw new ExprError(`思わぬ記号です：${k.v}`, k.pos);
  };
  const cmp = (): Node => {
    let a = primary();
    while (peek()?.t === "op" && (peek()!.v === "==" || peek()!.v === "!=")) {
      const op = toks[p++]!.v;
      a = { k: "bin", op, a, b: primary() };
    }
    return a;
  };
  const and = (): Node => {
    let a = cmp();
    while (peek()?.t === "op" && peek()!.v === "&&") {
      p++;
      a = { k: "bin", op: "&&", a, b: cmp() };
    }
    return a;
  };
  const or = (): Node => {
    let a = and();
    while (peek()?.t === "op" && peek()!.v === "||") {
      p++;
      a = { k: "bin", op: "||", a, b: and() };
    }
    return a;
  };
  const e = or();
  if (p < toks.length) throw new ExprError(`思わぬ記号です：${toks[p]!.v}`, toks[p]!.pos);
  return e;
}

export interface CompiledExpr {
  node: Node;
  /** 状態の関数（success など）を含むか。含まなければ、依存先の失敗時は success() を前提にする */
  usesStatus: boolean;
}

/** 構文を確かめる。誤りは ExprError（pos は元の文字列での位置） */
export function compileExpr(src: string): CompiledExpr {
  const { text, offset } = unwrap(src);
  try {
    const node = parseTokens(tokenize(text));
    const usesStatus = /\b(success|failure|always|cancelled)\s*\(/.test(text);
    return { node, usesStatus };
  } catch (e) {
    if (e instanceof ExprError) throw new ExprError(e.message, e.pos < 0 ? offset + text.length : offset + e.pos);
    throw e;
  }
}

const truthy = (v: Value) => v !== null && v !== false && v !== "" && v !== 0;

function ev(n: Node, ctx: ExprContext): Value {
  switch (n.k) {
    case "lit":
      return n.v;
    case "var":
      return ctx.vars[n.name] ?? null;
    case "not":
      return !truthy(ev(n.e, ctx));
    case "bin": {
      if (n.op === "&&") return truthy(ev(n.a, ctx)) && truthy(ev(n.b, ctx));
      if (n.op === "||") return truthy(ev(n.a, ctx)) || truthy(ev(n.b, ctx));
      const a = ev(n.a, ctx);
      const b = ev(n.b, ctx);
      const eq = typeof a === "string" && typeof b === "string" ? a.toLowerCase() === b.toLowerCase() : a === b;
      return n.op === "==" ? eq : !eq;
    }
    case "call": {
      const s = ctx.status;
      if (n.name === "success") return !s.anyFailed && !s.anyCancelled;
      if (n.name === "failure") return s.anyFailed;
      if (n.name === "always") return true;
      if (n.name === "cancelled") return s.anyCancelled;
      const [a, b] = n.args.map((x) => String(ev(x, ctx) ?? "").toLowerCase());
      if (n.name === "contains") return a!.includes(b!);
      if (n.name === "startsWith") return a!.startsWith(b!);
      return a!.endsWith(b!);
    }
  }
}

/** 実行してよいか。式が無ければ success() と同じ */
export function evaluateIf(src: string | undefined, ctx: ExprContext): boolean {
  if (!src) return !ctx.status.anyFailed && !ctx.status.anyCancelled;
  const c = compileExpr(src);
  // 状態の関数を使わない式は、Actions と同じく success() && 式 とみなす
  if (!c.usesStatus && (ctx.status.anyFailed || ctx.status.anyCancelled)) return false;
  return truthy(ev(c.node, ctx));
}
