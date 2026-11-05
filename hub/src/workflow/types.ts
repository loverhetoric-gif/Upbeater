/**
 * 定義ファイル（.upbeater/*.yml）の型。
 * この部品（src/workflow/）は Workers に依存しない。Actions の書式からの変換にも使う。
 */

export interface Problem {
  file: string;
  line: number;
  column: number;
  message: string;
}

export interface PushTrigger {
  branches?: string[];
  tags?: string[];
  paths?: string[];
}
export interface PullRequestTrigger {
  branches?: string[];
}
export interface ManualTrigger {
  inputs?: Record<string, { description?: string; default?: string; required?: boolean }>;
}

export interface Triggers {
  push?: PushTrigger;
  pull_request?: PullRequestTrigger;
  delete?: { branches?: string[] };
  schedule?: string[];
  manual?: ManualTrigger;
}

export interface Concurrency {
  group: string;
  /** 同じ group の古いジョブを取り消すか（既定 true）。false なら順番待ち */
  cancelInProgress: boolean;
}

export type Step =
  | { kind: "run"; id?: string; name?: string; run: string; env?: Record<string, string>; if?: string; workingDirectory?: string; timeout?: number; continueOnError?: boolean }
  | { kind: "uses"; id?: string; name?: string; uses: string; with?: Record<string, string>; env?: Record<string, string>; if?: string; timeout?: number; continueOnError?: boolean }
  | { kind: "distribute"; name?: string; platform: string; file: string; if?: string };

export interface Matrix {
  axes: Record<string, (string | number | boolean)[]>;
  include: Record<string, string | number | boolean>[];
  exclude: Record<string, string | number | boolean>[];
}

export interface Job {
  id: string;
  name?: string;
  runsOn: string[];
  needs: string[];
  if?: string;
  env: Record<string, string>;
  secrets: string[];
  timeout: number;
  concurrency?: Concurrency;
  matrix?: Matrix;
  steps: Step[];
  artifacts: { name: string; path: string }[];
  cache?: { key: string; paths: string[] };
  /** 心拍の途絶などで自動の再実行をしてよいか（公開など二重に行うと困る手順は false にする） */
  rerunnable: boolean;
  /** 定義ファイル内の行（エラー表示用） */
  line: number;
}

export interface Workflow {
  file: string;
  name: string;
  on: Triggers;
  env: Record<string, string>;
  jobs: Job[];
}

export type ParseResult = { ok: true; workflow: Workflow } | { ok: false; problems: Problem[] };

/** 組み込み部品（Actions のよく使われる部品に相当）。runner がこの名前で実装する */
export const BUILTIN_COMPONENTS = ["checkout", "setup-node", "setup-java", "setup-go", "setup-python", "setup-flutter", "cache", "upload-artifact", "download-artifact"] as const;

export const DEFAULT_TIMEOUT_MINUTES = 60;
export const MAX_TIMEOUT_MINUTES = 24 * 60;
export const MAX_MATRIX = 256;
