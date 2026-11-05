import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { convertWorkflow, parseWorkflow } from "../src/workflow";
import { concurrencyGroup } from "../src/runs";

const ACTIONS = `name: build
on:
  pull_request:
    paths-ignore: ['**.md']
  push:
    branches: [main]
    paths-ignore: ['**.md', 'docs/**', '.github/workflows/build.yml']
  workflow_dispatch:
    inputs:
      level: { description: 強さ, default: low, type: choice, options: [low, high] }
  schedule:
    - cron: '0 3 * * *'
concurrency:
  group: build-\${{ github.ref }}
  cancel-in-progress: true
env:
  TOOL_VERSION: "1.2"
permissions:
  contents: read
jobs:
  test:
    name: 検査
    runs-on: ubuntu-latest
    timeout-minutes: 20
    defaults:
      run:
        working-directory: api
    strategy:
      fail-fast: false
      matrix:
        node: [20, 22]
    env:
      TOKEN: \${{ secrets.npm_token }}
    steps:
      - uses: actions/checkout@v4
        with: { fetch-depth: 0 }
      - uses: actions/setup-node@v4
        with:
          node-version: \${{ matrix.node }}
          cache: npm
      - id: check
        run: echo "ok=true" >> "$GITHUB_OUTPUT"
      - if: steps.check.outputs.ok == 'true'
        run: npm test -- --sha \${{ github.sha }} --dir \${{ github.workspace }}
      - uses: actions/upload-artifact@v4
        with: { name: report, path: api/report.txt, retention-days: 3 }
  mac:
    runs-on: macos-14
    if: github.event_name == 'workflow_dispatch'
    steps:
      - uses: actions/upload-artifact@v4
        with: { name: app, path: build/app.zip }
  release:
    needs: [test, mac]
    if: always() && github.ref == 'refs/heads/main' && needs.test.result == 'success'
    runs-on: ubuntu-latest
    permissions:
      contents: write
    steps:
      - uses: actions/download-artifact@v4
        with: { path: out }
      - env:
          GH_TOKEN: \${{ github.token }}
          REPO: \${{ github.repository }}
        run: |
          sed -i "s/a/b/" x.txt
          gh release upload latest out/report/report.txt --repo "$REPO"
      - uses: some/unknown-action@v1
      - run: echo \${{ toJSON(github.event) }}
`;

describe("移行ツール（Actions → Upbeater）", () => {
  const r = convertWorkflow(".github/workflows/build.yml", ACTIONS, { labels: { linux: "macos" } });
  const w = parse(r.text);
  const errors = r.notes.filter((n) => n.level === "error").map((n) => `${n.line} ${n.message}`);
  const warnings = r.notes.filter((n) => n.level === "warning").map((n) => `${n.line} ${n.message}`);

  it("書き出した定義は Hub がそのまま読める", () => {
    expect(r.file).toBe(".upbeater/build.yml");
    expect(r.problems).toEqual([]);
    const p = parseWorkflow(r.file, r.text);
    expect(p.ok).toBe(true);
  });

  it("合図を変換する（workflow_dispatch → manual、paths-ignore → ! の型、cron）", () => {
    expect(w.on.push).toEqual({ branches: ["main"], paths: ["**", "!**.md", "!docs/**", "!.upbeater/build.yml"] });
    expect(w.on.manual).toEqual({ inputs: { level: { description: "強さ", default: "low" } } });
    expect(w.on.schedule).toEqual(["0 3 * * *"]);
    expect(w.on.pull_request).toEqual({});
    expect(warnings.some((m) => m.includes("pull_request の paths"))).toBe(true);
  });

  it("ジョブ：runs-on のラベル・working-directory・concurrency・matrix・timeout・secrets", () => {
    const t = w.jobs.test;
    expect(t["runs-on"]).toBe("macos"); // ubuntu-latest → linux → --label で macos
    expect(w.jobs.mac["runs-on"]).toBe("macos");
    expect(t.timeout).toBe(20);
    expect(t.matrix).toEqual({ node: [20, 22] });
    expect(t.concurrency).toEqual({ group: "build-${{ ref }}-test", "cancel-in-progress": true });
    expect(t.secrets).toEqual(["NPM_TOKEN"]);
    expect(t.env.TOKEN).toBe("${{ secrets.NPM_TOKEN }}");
    expect(t.steps[0]).toEqual({ uses: "checkout", with: { "fetch-depth": 0 } });
    expect(t.steps[1]).toEqual({ uses: "setup-node", with: { "node-version": "${{ matrix.node }}" } });
    expect(t.steps[2]).toEqual({ id: "check", run: 'echo "ok=true" >> "$GITHUB_OUTPUT"', "working-directory": "api" });
    expect(t.steps[3].run).toBe("npm test -- --sha ${{ sha }} --dir ${GITHUB_WORKSPACE}");
    expect(t.steps[4]).toEqual({ uses: "upload-artifact", with: { name: "report", path: "api/report.txt" } });
  });

  it("式の github.* を Upbeater の名前に直す", () => {
    expect(w.jobs.mac.if).toBe("event == 'manual'");
    expect(w.jobs.release.if).toBe("always() && ref == 'refs/heads/main' && needs.test.result == 'success'");
    const s = w.jobs.release.steps[2];
    expect(s.env).toEqual({ GH_TOKEN: "${{ secrets.GITHUB_TOKEN }}", REPO: "${{ repo }}" });
    expect(w.jobs.release.secrets).toEqual(["GITHUB_TOKEN"]);
    expect(w.jobs.release.rerun).toBe(false);
  });

  it("name の無い download-artifact は、依存先の成果物ごとに分ける（無くても続ける）", () => {
    expect(w.jobs.release.steps.slice(0, 2)).toEqual([
      { uses: "download-artifact", with: { name: "report", path: "out/report" }, "continue-on-error": true },
      { uses: "download-artifact", with: { name: "app", path: "out/app" }, "continue-on-error": true },
    ]);
  });

  it("変換できない部品・式は行番号つきで報告し、その手順は失敗させる（黙って抜け落ちない）", () => {
    expect(errors).toEqual([
      expect.stringMatching(/^68 部品「some\/unknown-action@v1」/),
      expect.stringMatching(/^69 式の関数 toJSON\(\)/),
      expect.stringMatching(/^69 式の「github\.event」/),
    ]);
    const fail = w.jobs.release.steps[3];
    expect(fail.run).toMatch(/移行ツール：部品「some\/unknown-action@v1」は変換できません/);
    expect(fail.run).toMatch(/exit 1$/);
  });

  it("注意：Linux 用の台本を macOS で動かす時の書き方の違い・permissions・cache", () => {
    expect(warnings).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/sed -i/),
        expect.stringMatching(/permissions は使いません。GitHub に書き込む手順には/),
        expect.stringMatching(/setup-node の cache は使いません/),
        expect.stringMatching(/retention-days/),
        expect.stringMatching(/ジョブごとに分けて/),
      ]),
    );
  });

  it("YAML の誤りは、変換せずに報告する", () => {
    const bad = convertWorkflow(".github/workflows/x.yaml", "on: [push\njobs: {}\n");
    expect(bad.file).toBe(".upbeater/x.yml");
    expect(bad.text).toBe("");
    expect(bad.notes[0]).toMatchObject({ level: "error", line: expect.any(Number) });
  });

  it("使えない合図・再利用のワークフロー・Windows は「変換できません」", () => {
    const x = convertWorkflow(
      ".github/workflows/x.yml",
      `on: [push, release]
jobs:
  a: { uses: org/repo/.github/workflows/w.yml@main }
  b:
    runs-on: windows-latest
    steps: [{ run: dir, shell: pwsh }]
`,
    );
    const msgs = x.notes.filter((n) => n.level === "error").map((n) => n.message);
    expect(msgs).toEqual(
      expect.arrayContaining([expect.stringMatching(/合図「release」/), expect.stringMatching(/再利用のワークフロー/), expect.stringMatching(/Windows/), expect.stringMatching(/shell「pwsh」/)]),
    );
    expect(parse(x.text).jobs.a.steps[0].run).toMatch(/exit 1/);
  });
});

describe("定義：手順の id と concurrency の group", () => {
  it("手順の id を受け付け、重なりと形の誤りを知らせる", () => {
    const ok = parseWorkflow("a.yml", "on: push\njobs:\n  b:\n    runs-on: linux\n    steps:\n      - { id: x, run: echo }\n      - { uses: checkout, id: y }\n");
    expect(ok.ok && ok.workflow.jobs[0]!.steps.map((s) => ("id" in s ? s.id : undefined))).toEqual(["x", "y"]);
    const bad = parseWorkflow("a.yml", "on: push\njobs:\n  b:\n    runs-on: linux\n    steps:\n      - { id: x, run: echo }\n      - { id: x, run: echo }\n      - { id: 1x, run: echo }\n");
    expect(bad.ok ? [] : bad.problems.map((p) => `${p.line} ${p.message}`)).toEqual([expect.stringMatching(/^7 .*重なっています/), expect.stringMatching(/^8 .*使えません/)]);
  });

  it("group の ${{ ref }}・${{ branch }}・${{ event }}・${{ matrix.x }} を実行の値にする", () => {
    expect(concurrencyGroup("build-${{ ref }}-${{ branch }}-${{ event }}-${{ matrix.os }}", { kind: "push", ref: "refs/heads/main", branch: "main" }, { os: "linux" })).toBe(
      "build-refs/heads/main-main-push-linux",
    );
    expect(concurrencyGroup("x-${{ unknown }}", { kind: "push", ref: null, branch: null })).toBe("x-${{ unknown }}");
  });
});
