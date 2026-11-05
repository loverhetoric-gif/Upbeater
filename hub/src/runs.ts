/**
 * 実行の管理：合図から run と job を作り、needs の順に待ち行列へ入れる。
 * concurrency の同じ group では古いジョブを取り消し、同時に動くのは常に 1 つ（公開系の直列化）。
 * 状態の遷移は RepoCoordinator（リポジトリごとの Durable Object）の中で直列に行う。
 */
import { enqueueCheck } from "./checks";
import type { Env, JobRow, JobSpec, RepoRow, RunRow } from "./env";
import { TERMINAL } from "./env";
import { operationStatement } from "./operations";
import { comboLabel, evaluateIf, expandMatrix, parseWorkflow, topoOrder, triggerMatches, type Event, type Problem, type Workflow } from "./workflow";

export interface EventInfo {
  kind: Event["kind"];
  ref: string | null;
  branch: string | null;
  tag?: string | null;
  sha: string;
  actor: string | null;
  isFork: boolean;
  changedFiles?: string[];
  /** 手動・定期実行で対象にする定義ファイル */
  workflowFile?: string;
  inputs?: Record<string, string>;
}

export function toMatchEvent(e: EventInfo): Event {
  switch (e.kind) {
    case "push":
      return e.tag ? { kind: "push", tag: e.tag } : { kind: "push", branch: e.branch ?? "", ...(e.changedFiles ? { changedFiles: e.changedFiles } : {}) };
    case "pull_request":
      return { kind: "pull_request", baseBranch: e.branch ?? "" };
    case "delete":
      return { kind: "delete", branch: e.branch ?? "" };
    default:
      return { kind: e.kind };
  }
}

export interface CreatedRun {
  run_id: string;
  number: number;
  workflow: string;
  conclusion?: string;
}

async function nextNumber(env: Env, repo: RepoRow): Promise<number> {
  const r = await env.DB.prepare("UPDATE repos SET next_run_number = next_run_number + 1 WHERE id = ? RETURNING next_run_number - 1 AS n")
    .bind(repo.id)
    .first<{ n: number }>();
  return r!.n;
}

function problemsSummary(problems: Problem[]): string {
  return problems.map((p) => `${p.file}:${p.line}:${p.column} ${p.message}`).join("\n");
}

/** 定義ファイルの一覧と合図から run を作る */
export async function createRuns(env: Env, repo: RepoRow, e: EventInfo, files: { path: string; text: string }[], now = Date.now()): Promise<CreatedRun[]> {
  const created: CreatedRun[] = [];
  for (const f of files) {
    if (e.workflowFile && f.path !== e.workflowFile) continue;
    const parsed = parseWorkflow(f.path, f.text);
    if (!parsed.ok) {
      // 誤りは実行前に報告し、GitHub にも失敗として表示する（手動・定期では対象のファイルだけ）
      const id = crypto.randomUUID();
      const number = await nextNumber(env, repo);
      await env.DB.batch([
        env.DB.prepare(
          `INSERT INTO runs (id, owner_id, repo_id, number, workflow_file, workflow_name, event, ref, branch, sha, actor, is_fork, status, conclusion, problems, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'completed', 'definition_error', ?, ?, ?)`,
        ).bind(id, repo.owner_id, repo.id, number, f.path, f.path, e.kind, e.ref, e.branch, e.sha, e.actor, e.isFork ? 1 : 0, JSON.stringify(parsed.problems), now, now),
        operationStatement(env, { owner_id: repo.owner_id, repo_id: repo.id, run_id: id, kind: "run", stage: "definition", status: "failed", reason: problemsSummary(parsed.problems).slice(0, 1500), needs_human: true }, now),
      ]);
      await enqueueCheck(env, repo, id, {
        name: `Upbeater / ${f.path}`,
        head_sha: e.sha,
        external_id: id,
        status: "completed",
        conclusion: "failure",
        completed_at: new Date(now).toISOString(),
        output: {
          title: "定義ファイルの誤り",
          summary: problemsSummary(parsed.problems),
          annotations: parsed.problems.slice(0, 50).map((p) => ({ path: p.file, start_line: p.line, end_line: p.line, annotation_level: "failure" as const, message: p.message })),
        },
      });
      created.push({ run_id: id, number, workflow: f.path, conclusion: "definition_error" });
      continue;
    }
    const w = parsed.workflow;
    if (!triggerMatches(w.on, toMatchEvent(e))) continue;
    created.push(await createRun(env, repo, w, e, now));
  }
  return created;
}

async function createRun(env: Env, repo: RepoRow, w: Workflow, e: EventInfo, now: number): Promise<CreatedRun> {
  const id = crypto.randomUUID();
  const number = await nextNumber(env, repo);
  const stmts: D1PreparedStatement[] = [
    env.DB.prepare(
      `INSERT INTO runs (id, owner_id, repo_id, number, workflow_file, workflow_name, event, ref, branch, sha, actor, is_fork, status, inputs, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'queued', ?, ?, ?)`,
    ).bind(id, repo.owner_id, repo.id, number, w.file, w.name, e.kind, e.ref, e.branch, e.sha, e.actor, e.isFork ? 1 : 0, e.inputs ? JSON.stringify(e.inputs) : null, now, now),
  ];
  let order = 0;
  for (const j of topoOrder(w.jobs)) {
    const combos = j.matrix ? expandMatrix(j.matrix) : [null];
    for (const combo of combos) {
      const spec: JobSpec = { steps: j.steps, env: { ...w.env, ...j.env }, secrets: j.secrets, timeout: j.timeout, artifacts: j.artifacts, ...(j.cache ? { cache: j.cache } : {}) };
      // concurrency の group に matrix の値を使えるように置き換える（${{ matrix.x }}）
      const group = j.concurrency ? j.concurrency.group.replace(/\$\{\{\s*matrix\.([A-Za-z0-9_-]+)\s*\}\}/g, (_, k: string) => String(combo?.[k] ?? "")) : null;
      stmts.push(
        env.DB.prepare(
          `INSERT INTO jobs (id, owner_id, run_id, repo_id, job_key, name, matrix, needs, if_expr, runs_on, spec, concurrency_group, cancel_in_progress, rerunnable, status, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'waiting', ?, ?)`,
        ).bind(
          crypto.randomUUID(),
          repo.owner_id,
          id,
          repo.id,
          j.id,
          combo ? `${j.name ?? j.id} (${comboLabel(combo)})` : (j.name ?? j.id),
          combo ? JSON.stringify(combo) : null,
          JSON.stringify(j.needs),
          j.if ?? null,
          JSON.stringify(j.runsOn),
          JSON.stringify(spec),
          group,
          j.concurrency?.cancelInProgress === false ? 0 : 1,
          j.rerunnable ? 1 : 0,
          now + order++, // 作った順を保つ
          now,
        ),
      );
    }
  }
  stmts.push(operationStatement(env, { owner_id: repo.owner_id, repo_id: repo.id, run_id: id, kind: "run", stage: "created", status: "ok", detail: { workflow: w.file, event: e.kind, sha: e.sha, number } }, now));
  await env.DB.batch(stmts);
  await advanceRun(env, repo, id, now);
  return { run_id: id, number, workflow: w.file };
}

async function runJobs(env: Env, runId: string): Promise<JobRow[]> {
  return (await env.DB.prepare("SELECT * FROM jobs WHERE run_id = ? ORDER BY created_at, id").bind(runId).all<JobRow>()).results;
}

const isTerminal = (s: string) => (TERMINAL as readonly string[]).includes(s);

async function setStatus(env: Env, job: JobRow, status: JobRow["status"], reason: string | null, now: number): Promise<void> {
  await env.DB.prepare("UPDATE jobs SET status = ?, reason = ?, updated_at = ?, finished_at = CASE WHEN ? IN ('succeeded','failed','cancelled','skipped') THEN ? ELSE finished_at END WHERE id = ?")
    .bind(status, reason, now, status, now, job.id)
    .run();
  job.status = status;
  job.reason = reason;
}

/**
 * 待ちのジョブを進める：needs がすべて終わったものの if を評価し、concurrency の門を通す。
 * 何度呼んでも同じ結果になる（冪等）。
 */
export async function advanceRun(env: Env, repo: RepoRow, runId: string, now = Date.now()): Promise<void> {
  const run = await env.DB.prepare("SELECT * FROM runs WHERE id = ?").bind(runId).first<RunRow>();
  if (!run || run.status === "completed") return;
  const jobs = await runJobs(env, runId);
  let changed = true;
  while (changed) {
    changed = false;
    for (const j of jobs) {
      if (j.status !== "waiting") continue;
      const needs = JSON.parse(j.needs) as string[];
      const deps = jobs.filter((d) => needs.includes(d.job_key));
      if (deps.some((d) => !isTerminal(d.status))) continue;
      const vars: Record<string, string | number | boolean | null> = {
        event: run.event,
        branch: run.branch,
        ref: run.ref,
        sha: run.sha,
        repo: repo.full_name,
        actor: run.actor,
      };
      for (const [k, v] of Object.entries(j.matrix ? (JSON.parse(j.matrix) as Record<string, string>) : {})) vars[`matrix.${k}`] = v;
      for (const [k, v] of Object.entries(run.inputs ? (JSON.parse(run.inputs) as Record<string, string>) : {})) vars[`inputs.${k}`] = v;
      for (const d of deps) vars[`needs.${d.job_key}.result`] = d.status === "succeeded" ? "success" : d.status === "skipped" ? "skipped" : d.status === "cancelled" ? "cancelled" : "failure";
      const status = {
        anyFailed: deps.some((d) => d.status === "failed" || (d.status === "skipped" && d.reason === "依存先の失敗")),
        anyCancelled: deps.some((d) => d.status === "cancelled"),
      };
      let run_ = false;
      try {
        run_ = evaluateIf(j.if_expr ?? undefined, { vars, status });
      } catch {
        run_ = false;
      }
      if (!run_) {
        await setStatus(env, j, "skipped", status.anyFailed || status.anyCancelled ? "依存先の失敗" : "条件（if）に合いません", now);
        await reportJob(env, repo, run, j, now);
        changed = true;
        continue;
      }
      await gate(env, repo, run, j, now);
      changed = true;
    }
  }
  await finishRunIfDone(env, repo, run, jobs, now);
}

/** concurrency の門：古いものを取り消し、group で同時に動くのは 1 つだけにする */
async function gate(env: Env, repo: RepoRow, run: RunRow, j: JobRow, now: number): Promise<void> {
  if (!j.concurrency_group) {
    await setStatus(env, j, "queued", null, now);
    await reportJob(env, repo, run, j, now);
    return;
  }
  if (j.cancel_in_progress) {
    // 同じ group の古いジョブ（まだ始まっていないもの）は取り消す。実行中のものには中断を指示する
    const older = await env.DB.prepare(
      `SELECT * FROM jobs WHERE repo_id = ? AND concurrency_group = ? AND id != ? AND created_at < ? AND status IN ('waiting', 'blocked', 'queued', 'claimed')`,
    )
      .bind(repo.id, j.concurrency_group, j.id, j.created_at)
      .all<JobRow>();
    for (const o of older.results) {
      if (o.status === "claimed") {
        await env.DB.prepare("UPDATE jobs SET cancel_requested = 1, updated_at = ? WHERE id = ? AND status = 'claimed'").bind(now, o.id).run();
      } else {
        await setStatus(env, o, "cancelled", "新しい更新に置き換わりました", now);
        const orun = await env.DB.prepare("SELECT * FROM runs WHERE id = ?").bind(o.run_id).first<RunRow>();
        if (orun) {
          await reportJob(env, repo, orun, o, now);
          if (o.run_id !== run.id) await advanceRun(env, repo, o.run_id, now);
        }
      }
    }
  }
  const busy = await env.DB.prepare(
    `SELECT COUNT(*) AS n FROM jobs WHERE repo_id = ? AND concurrency_group = ? AND id != ? AND (status IN ('queued', 'claimed') OR (status = 'blocked' AND created_at < ?))`,
  )
    .bind(repo.id, j.concurrency_group, j.id, j.created_at)
    .first<{ n: number }>();
  await setStatus(env, j, (busy?.n ?? 0) > 0 ? "blocked" : "queued", (busy?.n ?? 0) > 0 ? "同じ concurrency の実行を待っています" : null, now);
  await reportJob(env, repo, run, j, now);
}

/** group の先頭で待っているジョブを動かす（前のジョブが終わった時に呼ぶ） */
export async function releaseGroup(env: Env, repo: RepoRow, group: string, now = Date.now()): Promise<void> {
  const active = await env.DB.prepare("SELECT COUNT(*) AS n FROM jobs WHERE repo_id = ? AND concurrency_group = ? AND status IN ('queued', 'claimed')")
    .bind(repo.id, group)
    .first<{ n: number }>();
  if ((active?.n ?? 0) > 0) return;
  const next = await env.DB.prepare("SELECT * FROM jobs WHERE repo_id = ? AND concurrency_group = ? AND status = 'blocked' ORDER BY created_at, id LIMIT 1")
    .bind(repo.id, group)
    .first<JobRow>();
  if (!next) return;
  await setStatus(env, next, "queued", null, now);
  const run = await env.DB.prepare("SELECT * FROM runs WHERE id = ?").bind(next.run_id).first<RunRow>();
  if (run) await reportJob(env, repo, run, next, now);
}

async function finishRunIfDone(env: Env, repo: RepoRow, run: RunRow, jobs: JobRow[], now: number): Promise<void> {
  const fresh = await runJobs(env, run.id);
  void jobs;
  const all = fresh.length > 0 && fresh.every((j) => isTerminal(j.status));
  if (all) {
    const conclusion = fresh.some((j) => j.status === "failed") ? "failure" : fresh.some((j) => j.status === "cancelled") ? "cancelled" : "success";
    await env.DB.batch([
      env.DB.prepare("UPDATE runs SET status = 'completed', conclusion = ?, updated_at = ? WHERE id = ? AND status != 'completed'").bind(conclusion, now, run.id),
      operationStatement(env, { owner_id: run.owner_id, repo_id: repo.id, run_id: run.id, kind: "run", stage: "completed", status: conclusion === "failure" ? "failed" : "ok", detail: { conclusion } }, now),
    ]);
    return;
  }
  const running = fresh.some((j) => j.status === "claimed");
  await env.DB.prepare("UPDATE runs SET status = ?, updated_at = ? WHERE id = ? AND status != 'completed'").bind(running ? "running" : "queued", now, run.id).run();
}

/** ジョブの状態を GitHub に表示する（待ち行列に積むだけ。失敗しても実行は止めない） */
export async function reportJob(env: Env, repo: RepoRow, run: RunRow, j: JobRow, now = Date.now()): Promise<void> {
  const status = j.status === "claimed" ? "in_progress" : isTerminal(j.status) ? "completed" : "queued";
  const conclusion =
    j.status === "succeeded" ? "success" : j.status === "failed" ? "failure" : j.status === "cancelled" ? "cancelled" : j.status === "skipped" ? "skipped" : undefined;
  await enqueueCheck(env, repo, j.id, {
    name: `${run.workflow_name} / ${j.name}`,
    head_sha: run.sha,
    external_id: j.id,
    status,
    ...(conclusion ? { conclusion, completed_at: new Date(now).toISOString() } : {}),
    output: { title: j.reason ?? (conclusion ?? status), summary: `実行 #${run.number}（${run.event}）・試行 ${j.attempt}` },
  });
}

/** ジョブが終わった後の処理：依存先を進め、concurrency の次を動かす */
export async function afterJobFinished(env: Env, repo: RepoRow, jobId: string, now = Date.now()): Promise<void> {
  const j = await env.DB.prepare("SELECT * FROM jobs WHERE id = ?").bind(jobId).first<JobRow>();
  if (!j) return;
  const run = await env.DB.prepare("SELECT * FROM runs WHERE id = ?").bind(j.run_id).first<RunRow>();
  if (run) await reportJob(env, repo, run, j, now);
  await advanceRun(env, repo, j.run_id, now);
  if (j.concurrency_group) {
    await releaseGroup(env, repo, j.concurrency_group, now);
  }
}

/** 実行の取り消し（手動） */
export async function cancelRun(env: Env, repo: RepoRow, runId: string, now = Date.now()): Promise<void> {
  const jobs = await runJobs(env, runId);
  const run = await env.DB.prepare("SELECT * FROM runs WHERE id = ?").bind(runId).first<RunRow>();
  if (!run) return;
  for (const j of jobs) {
    if (j.status === "claimed") await env.DB.prepare("UPDATE jobs SET cancel_requested = 1, updated_at = ? WHERE id = ?").bind(now, j.id).run();
    else if (!isTerminal(j.status)) {
      await setStatus(env, j, "cancelled", "手動で取り消しました", now);
      await reportJob(env, repo, run, j, now);
      if (j.concurrency_group) await releaseGroup(env, repo, j.concurrency_group, now);
    }
  }
  await advanceRun(env, repo, runId, now);
}

/** 失敗・取り消しのジョブを再実行する（成功したものはそのまま） */
export async function rerunFailed(env: Env, repo: RepoRow, runId: string, now = Date.now()): Promise<number> {
  const jobs = await runJobs(env, runId);
  const keys = new Set(jobs.filter((j) => j.status === "failed" || j.status === "cancelled").map((j) => j.job_key));
  // 失敗の影響で飛ばされた後続も戻す
  let grew = true;
  while (grew) {
    grew = false;
    for (const j of jobs) {
      if (keys.has(j.job_key) || j.status !== "skipped") continue;
      if ((JSON.parse(j.needs) as string[]).some((n) => keys.has(n))) {
        keys.add(j.job_key);
        grew = true;
      }
    }
  }
  const targets = jobs.filter((j) => keys.has(j.job_key));
  for (const j of targets) {
    await env.DB.prepare(
      "UPDATE jobs SET status = 'waiting', reason = NULL, runner_id = NULL, job_token_hash = NULL, cancel_requested = 0, claimed_at = NULL, heartbeat_at = NULL, finished_at = NULL, updated_at = ? WHERE id = ?",
    )
      .bind(now, j.id)
      .run();
  }
  if (targets.length) {
    await env.DB.prepare("UPDATE runs SET status = 'queued', conclusion = NULL, updated_at = ? WHERE id = ?").bind(now, runId).run();
    await advanceRun(env, repo, runId, now);
  }
  return targets.length;
}
