/** 合図（push など）が定義ファイルの on に合うか */
import type { Triggers } from "./types";

/** glob（* は / を含まない任意、** は / を含む任意） */
export function globToRegExp(glob: string): RegExp {
  let re = "";
  for (let i = 0; i < glob.length; i++) {
    const ch = glob[i]!;
    if (ch === "*") {
      if (glob[i + 1] === "*") {
        re += ".*";
        i++;
      } else re += "[^/]*";
    } else if (ch === "?") re += "[^/]";
    else re += ch.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${re}$`);
}

function anyMatch(patterns: string[] | undefined, value: string): boolean {
  if (!patterns || patterns.length === 0) return true;
  let ok = false;
  // 先頭が ! の型は除外（後に書いたものが優先）
  for (const p of patterns) {
    if (p.startsWith("!")) {
      if (globToRegExp(p.slice(1)).test(value)) ok = false;
    } else if (globToRegExp(p).test(value)) ok = true;
  }
  return ok;
}

export type Event =
  | { kind: "push"; branch?: string; tag?: string; changedFiles?: string[] }
  | { kind: "pull_request"; baseBranch: string }
  | { kind: "delete"; branch: string }
  | { kind: "schedule" }
  | { kind: "manual" };

export function triggerMatches(on: Triggers, e: Event): boolean {
  switch (e.kind) {
    case "push": {
      const t = on.push;
      if (!t) return false;
      if (e.tag !== undefined) return t.tags !== undefined && anyMatch(t.tags, e.tag);
      // tags だけを指定した push はブランチでは動かない（Actions と同じ）
      if (t.tags && !t.branches) return false;
      if (!anyMatch(t.branches, e.branch ?? "")) return false;
      if (t.paths && e.changedFiles) return e.changedFiles.some((f) => anyMatch(t.paths, f));
      return true;
    }
    case "pull_request":
      return on.pull_request !== undefined && anyMatch(on.pull_request.branches, e.baseBranch);
    case "delete":
      return on.delete !== undefined && anyMatch(on.delete.branches, e.branch);
    case "schedule":
      return (on.schedule?.length ?? 0) > 0;
    case "manual":
      return on.manual !== undefined;
  }
}
