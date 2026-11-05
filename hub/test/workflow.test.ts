import { describe, expect, it } from "vitest";
import { comboLabel, evaluateIf, expandMatrix, latestDue, parseCron, parseWorkflow, topoOrder, triggerMatches } from "../src/workflow";

const ok = (text: string) => {
  const r = parseWorkflow(".upbeater/ci.yml", text);
  if (!r.ok) throw new Error(JSON.stringify(r.problems));
  return r.workflow;
};
const problems = (text: string) => {
  const r = parseWorkflow(".upbeater/ci.yml", text);
  if (r.ok) throw new Error("誤りが検出されませんでした");
  return r.problems;
};

const SAMPLE = `name: 公開
on:
  push: { branches: [main] }
  pull_request: {}
  schedule: ["0 3 * * *"]
  manual: {}
jobs:
  test:
    runs-on: linux
    matrix:
      node: [20, 22]
    steps:
      - uses: checkout
      - run: npm ci && npm test
  deploy:
    needs: test
    if: event == 'push'
    runs-on: linux
    secrets: [CLOUDFLARE_API_TOKEN]
    concurrency: deploy
    rerun: false
    steps:
      - run: npx wrangler deploy
  distribute:
    needs: test
    if: event == 'push'
    runs-on: macos
    steps:
      - run: flutter build apk --release
      - distribute: { platform: android, file: build/app/outputs/flutter-apk/app-release.apk }
`;

describe("定義ファイルの解析", () => {
  it("設計書の例をそのまま解析できる", () => {
    const w = ok(SAMPLE);
    expect(w.name).toBe("公開");
    expect(Object.keys(w.on).sort()).toEqual(["manual", "pull_request", "push", "schedule"]);
    expect(w.jobs.map((j) => j.id)).toEqual(["test", "deploy", "distribute"]);
    const deploy = w.jobs[1]!;
    expect(deploy).toMatchObject({ needs: ["test"], runsOn: ["linux"], secrets: ["CLOUDFLARE_API_TOKEN"], concurrency: { group: "deploy", cancelInProgress: true }, rerunnable: false, timeout: 60 });
    expect(w.jobs[2]!.steps[1]).toEqual({ kind: "distribute", platform: "android", file: "build/app/outputs/flutter-apk/app-release.apk" });
    expect(topoOrder(w.jobs).map((j) => j.id)[0]).toBe("test");
  });

  it("誤りはすべて、ファイル名・行・列つきで返す", () => {
    const p = problems(`on:
  push: {}
  nightly: {}
jobs:
  build:
    steps:
      - run: make
  test:
    runs-on: linux
    needs: [build, lint]
    timeout: 0
    steps:
      - run: make test
        uses: checkout
  bad name!:
    runs-on: linux
    steps: []
`);
    const lines = p.map((x) => `${x.file}:${x.line} ${x.message}`);
    expect(lines).toEqual([
      expect.stringMatching(/^\.upbeater\/ci\.yml:3 on に「nightly」は使えません/),
      expect.stringMatching(/^\.upbeater\/ci\.yml:5 jobs\.build\.runs-on/),
      expect.stringMatching(/^\.upbeater\/ci\.yml:10 jobs\.test\.needs の「lint」というジョブはありません/),
      expect.stringMatching(/^\.upbeater\/ci\.yml:11 jobs\.test\.timeout は 1〜1440/),
      expect.stringMatching(/^\.upbeater\/ci\.yml:13 jobs\.test\.steps\[1\] には run・uses・distribute のどれか一つ/),
      expect.stringMatching(/^\.upbeater\/ci\.yml:15 ジョブ名「bad name!」は使えません/),
    ]);
    expect(p.every((x) => x.column >= 1)).toBe(true);
  });

  it("YAML の構文の誤り・重複したキーも行番号つきで返す", () => {
    expect(problems("on: push\njobs:\n  a:\n    runs-on: linux\n    runs-on: macos\n    steps: [{run: x}]\n")[0]).toMatchObject({ line: 5 });
    expect(problems("on: push\njobs:\n  a: [\n")[0]!.message).toContain("YAML");
  });

  it("if の式・cron・組み込み部品・秘密情報の名前の誤りを、その位置で知らせる", () => {
    const p = problems(`on:
  schedule: ["61 * * * *"]
jobs:
  a:
    runs-on: linux
    if: "event == 'push' &&"
    secrets: [lower_case]
    steps:
      - uses: actions/checkout@v4
`);
    expect(p.map((x) => x.line)).toEqual([2, 6, 7, 9]);
    expect(p[0]!.message).toContain("分 の範囲は 0〜59");
    expect(p[1]!.message).toContain("式が正しくありません");
    expect(p[3]!.message).toContain("組み込み部品「actions/checkout@v4」はありません");
  });

  it("needs の循環を見つける", () => {
    const p = problems("on: push\njobs:\n  a: {runs-on: linux, needs: c, steps: [{run: x}]}\n  b: {runs-on: linux, needs: a, steps: [{run: x}]}\n  c: {runs-on: linux, needs: b, steps: [{run: x}]}\n");
    expect(p[0]!.message).toMatch(/needs が循環しています：a → c → b → a/);
  });

  it("Actions の書き方（strategy.matrix・timeout-minutes・schedule の cron）も受け付ける", () => {
    const w = ok(`on:
  schedule:
    - cron: "30 2 * * 1"
jobs:
  t:
    runs-on: [linux, large]
    timeout-minutes: 15
    strategy:
      matrix:
        os: [a, b]
    steps: [{run: x}]
`);
    expect(w.on.schedule).toEqual(["30 2 * * 1"]);
    expect(w.jobs[0]).toMatchObject({ timeout: 15, runsOn: ["linux", "large"] });
  });
});

describe("matrix・式・合図・cron", () => {
  it("matrix を展開する（exclude・include を含む）", () => {
    const c = expandMatrix({ axes: { os: ["linux", "macos"], node: [20, 22] }, exclude: [{ os: "macos", node: 20 }], include: [{ os: "linux", node: 22, experimental: true }, { os: "windows", node: 22 }] });
    expect(c.map(comboLabel)).toEqual(["os=linux, node=20", "os=linux, node=22, experimental=true", "os=macos, node=22", "os=windows, node=22"]);
  });

  it("if は依存先の結果と合図の内容で評価する", () => {
    const ctx = (vars: Record<string, string>, failed = false) => ({ vars, status: { anyFailed: failed, anyCancelled: false } });
    expect(evaluateIf("event == 'push' && branch == 'main'", ctx({ event: "push", branch: "main" }))).toBe(true);
    expect(evaluateIf("${{ event == 'push' }}", ctx({ event: "pull_request" }))).toBe(false);
    expect(evaluateIf(undefined, ctx({}, true))).toBe(false);
    expect(evaluateIf("event == 'push'", ctx({ event: "push" }, true))).toBe(false); // success() && 式
    expect(evaluateIf("failure()", ctx({}, true))).toBe(true);
    expect(evaluateIf("always() && startsWith(branch, 'release/')", ctx({ branch: "release/1" }, true))).toBe(true);
  });

  it("合図が on に合うか（ブランチ・タグ・パス・除外）", () => {
    const on = ok("on:\n  push:\n    branches: ['main', 'release/**', '!release/old']\n    paths: ['src/**']\njobs:\n  a: {runs-on: linux, steps: [{run: x}]}\n").on;
    expect(triggerMatches(on, { kind: "push", branch: "main", changedFiles: ["src/a.ts"] })).toBe(true);
    expect(triggerMatches(on, { kind: "push", branch: "main", changedFiles: ["docs/a.md"] })).toBe(false);
    expect(triggerMatches(on, { kind: "push", branch: "release/1/x" })).toBe(true);
    expect(triggerMatches(on, { kind: "push", branch: "release/old" })).toBe(false);
    expect(triggerMatches(on, { kind: "push", tag: "v1" })).toBe(false);
    expect(triggerMatches(on, { kind: "pull_request", baseBranch: "main" })).toBe(false);
  });

  it("cron の直近の予定時刻を求める", () => {
    const s = parseCron("0 3 * * *");
    const now = Date.UTC(2026, 10, 5, 7, 12);
    expect(latestDue(s, now)).toBe(Date.UTC(2026, 10, 5, 3, 0));
    expect(latestDue(parseCron("*/15 * * * *"), now)).toBe(Date.UTC(2026, 10, 5, 7, 0));
    expect(latestDue(parseCron("0 0 1 1 *"), now, 30)).toBeNull();
    expect(latestDue(parseCron("0 9 * * 1"), Date.UTC(2026, 10, 5, 7, 0))).toBe(Date.UTC(2026, 10, 2, 9, 0)); // 月曜
  });
});
