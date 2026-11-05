/** matrix の展開（直積 → exclude → include） */
import { MAX_MATRIX, type Matrix } from "./types";

export type Combo = Record<string, string | number | boolean>;

export function expandMatrix(m: Matrix): Combo[] {
  let combos: Combo[] = [{}];
  for (const [k, values] of Object.entries(m.axes)) {
    const next: Combo[] = [];
    for (const c of combos) for (const v of values) next.push({ ...c, [k]: v });
    combos = next;
    if (combos.length > MAX_MATRIX) throw new Error(`matrix の組み合わせが多すぎます（${MAX_MATRIX} まで）`);
  }
  if (Object.keys(m.axes).length === 0) combos = [];
  const hit = (c: Combo, pat: Combo) => Object.entries(pat).every(([k, v]) => c[k] === v);
  combos = combos.filter((c) => !m.exclude.some((e) => hit(c, e)));
  for (const inc of m.include) {
    // 既存の組み合わせを広げるか、新しい組み合わせとして加える（Actions と同じ考え方）
    const axisKeys = Object.keys(m.axes);
    const matched = combos.filter((c) => axisKeys.filter((k) => k in inc).every((k) => c[k] === inc[k]) && axisKeys.some((k) => k in inc));
    if (matched.length) for (const c of matched) Object.assign(c, inc);
    else combos.push({ ...inc });
  }
  if (combos.length > MAX_MATRIX) throw new Error(`matrix の組み合わせが多すぎます（${MAX_MATRIX} まで）`);
  return combos;
}

export function comboLabel(c: Combo): string {
  return Object.entries(c)
    .map(([k, v]) => `${k}=${v}`)
    .join(", ");
}
