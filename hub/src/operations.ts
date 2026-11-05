/** operations への記録。記録の失敗で本来の処理を止めない */
import type { Env } from "./env";

export interface OperationInput {
  owner_id: string;
  repo_id?: string | null;
  run_id?: string | null;
  job_id?: string | null;
  kind: string;
  stage: string;
  status: "ok" | "retry" | "failed";
  reason?: string | null;
  retryable?: boolean;
  needs_human?: boolean;
  detail?: unknown;
}

export function operationStatement(env: Env, op: OperationInput, now = Date.now()): D1PreparedStatement {
  return env.DB.prepare(
    `INSERT INTO operations (owner_id, repo_id, run_id, job_id, kind, stage, status, reason, retryable, needs_human, detail, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).bind(
    op.owner_id,
    op.repo_id ?? null,
    op.run_id ?? null,
    op.job_id ?? null,
    op.kind,
    op.stage,
    op.status,
    op.reason ?? null,
    op.retryable ? 1 : 0,
    op.needs_human ? 1 : 0,
    op.detail === undefined ? null : JSON.stringify(op.detail),
    now,
  );
}

export async function recordOperation(env: Env, op: OperationInput): Promise<void> {
  try {
    await operationStatement(env, op).run();
  } catch {
    console.error("operations への記録に失敗", op.kind, op.stage);
  }
}
