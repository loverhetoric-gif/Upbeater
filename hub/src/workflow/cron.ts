/** 5 項目の cron（分 時 日 月 曜日、UTC）。直近の予定時刻を求め、抜けた回を一度だけ補うために使う */

export interface CronSpec {
  minute: Set<number>;
  hour: Set<number>;
  dom: Set<number>;
  month: Set<number>;
  dow: Set<number>;
  domAny: boolean;
  dowAny: boolean;
}

const RANGES: [number, number][] = [
  [0, 59],
  [0, 23],
  [1, 31],
  [1, 12],
  [0, 7],
];

function field(src: string, [lo, hi]: [number, number], name: string): Set<number> {
  const out = new Set<number>();
  for (const part of src.split(",")) {
    const m = /^(\*|\d+(?:-\d+)?)(?:\/(\d+))?$/.exec(part);
    if (!m) throw new Error(`${name} の書き方が正しくありません：${part}`);
    let a = lo;
    let b = hi;
    if (m[1] !== "*") {
      const [x, y] = m[1]!.split("-").map(Number);
      a = x!;
      b = y ?? (m[2] ? hi : x!);
    }
    const step = m[2] ? Number(m[2]) : 1;
    if (a < lo || b > hi || a > b || step < 1) throw new Error(`${name} の範囲は ${lo}〜${hi} です：${part}`);
    for (let v = a; v <= b; v += step) out.add(name === "曜日" && v === 7 ? 0 : v);
  }
  return out;
}

export function parseCron(expr: string): CronSpec {
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) throw new Error("cron は「分 時 日 月 曜日」の 5 項目で書いてください");
  const names = ["分", "時", "日", "月", "曜日"];
  const [mi, h, d, mo, w] = parts.map((p, i) => field(p, RANGES[i]!, names[i]!));
  return { minute: mi!, hour: h!, dom: d!, month: mo!, dow: w!, domAny: parts[2] === "*", dowAny: parts[4] === "*" };
}

function matches(s: CronSpec, t: Date): boolean {
  if (!s.minute.has(t.getUTCMinutes()) || !s.hour.has(t.getUTCHours()) || !s.month.has(t.getUTCMonth() + 1)) return false;
  const dom = s.dom.has(t.getUTCDate());
  const dow = s.dow.has(t.getUTCDay());
  // cron の慣例：日と曜日の両方が指定されたら、どちらかに合えばよい
  if (s.domAny && s.dowAny) return true;
  if (s.domAny) return dow;
  if (s.dowAny) return dom;
  return dom || dow;
}

/** now 以前で最も新しい予定時刻（分単位）。lookbackDays 以内に無ければ null */
export function latestDue(s: CronSpec, now: number, lookbackDays = 35): number | null {
  let t = Math.floor(now / 60_000) * 60_000;
  const limit = t - lookbackDays * 86_400_000;
  for (; t >= limit; t -= 60_000) {
    const d = new Date(t);
    if (!s.month.has(d.getUTCMonth() + 1)) {
      // 月が合わない間は日単位で飛ばす
      t = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) ;
      continue;
    }
    if (!s.hour.has(d.getUTCHours())) {
      t = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), d.getUTCHours());
      continue;
    }
    if (matches(s, d)) return t;
  }
  return null;
}
