/**
 * 版の管理。
 * 到着順を信用せず、毎回 GitHub に対象ブランチの現在のコミットを照会して判断する。
 * 版はコミット SHA と Hub が発行する単調増加の通番で表す。
 */
import type { AppRow, Env } from "./env";
import { parseRepo, type GitHubClient } from "./github";
import { operationStatement, recordOperation } from "./operations";

export type SyncResult =
  | { status: "created"; seq: number; commit_sha: string; cancelled: number }
  | { status: "unchanged"; seq: number; commit_sha: string }
  | { status: "branch_missing" }
  | { status: "app_missing" };

export async function getApp(env: Env, appId: string): Promise<AppRow | null> {
  return env.DB.prepare("SELECT * FROM apps WHERE id = ?").bind(appId).first<AppRow>();
}

export function targetOs(app: AppRow): string[] {
  try {
    const v = JSON.parse(app.target_os) as unknown;
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

/** 1 回の照合。呼び出し側（AppCoordinator）がアプリ単位で直列化する前提 */
export async function syncApp(env: Env, gh: GitHubClient, appId: string, source: string, now = Date.now()): Promise<SyncResult> {
  const app = await getApp(env, appId);
  if (!app) return { status: "app_missing" };

  const head = await gh.getBranchHead(parseRepo(app.repo_full_name), app.branch);
  await env.DB.prepare("UPDATE apps SET last_checked_at = ? WHERE id = ?").bind(now, app.id).run();

  if (head === null) {
    await recordOperation(env, {
      owner_id: app.owner_id,
      app_id: app.id,
      kind: "sync",
      stage: "branch_head",
      status: "failed",
      reason: "対象ブランチが見つかりません（削除・権限不足の可能性）",
      needs_human: true,
      detail: { branch: app.branch, source },
    });
    return { status: "branch_missing" };
  }

  // 最新の通番と同じコミットなら何もしない。過去の通番と同じコミット（強制プッシュで戻った）なら新しい通番を発行する
  if (app.last_seq > 0 && app.current_sha === head) {
    return { status: "unchanged", seq: app.last_seq, commit_sha: head };
  }

  const seq = app.last_seq + 1;
  const stmts: D1PreparedStatement[] = [
    // 通番の楽観的排他（直列化が崩れても二重発行しない）
    env.DB.prepare("UPDATE apps SET last_seq = ?, current_sha = ?, updated_at = ? WHERE id = ? AND last_seq = ?").bind(
      seq,
      head,
      now,
      app.id,
      app.last_seq,
    ),
    env.DB.prepare(
      "INSERT INTO app_versions (owner_id, app_id, seq, commit_sha, source, created_at) VALUES (?, ?, ?, ?, ?, ?)",
    ).bind(app.owner_id, app.id, seq, head, source, now),
    // 古い版の未完了の配布物は取り消す（連続した更新は最新だけを扱う）
    env.DB.prepare("UPDATE releases SET status = 'cancelled', updated_at = ? WHERE app_id = ? AND seq < ? AND status = 'pending'").bind(
      now,
      app.id,
      seq,
    ),
  ];
  // 古い版のビルド指示は取り消す（待ち行列にはアプリごとに最新だけを残す。実行中のものは Builder が次の連絡で中断する）
  stmts.push(
    env.DB.prepare(
      "UPDATE build_jobs SET status = 'cancelled', reason = '新しい版に置き換わりました', updated_at = ? WHERE app_id = ? AND seq < ? AND status IN ('queued', 'claimed')",
    ).bind(now, app.id, seq),
  );
  for (const os of targetOs(app)) {
    const releaseId = crypto.randomUUID();
    stmts.push(
      env.DB.prepare(
        `INSERT INTO releases (id, owner_id, app_id, seq, commit_sha, os, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?)`,
      ).bind(releaseId, app.owner_id, app.id, seq, head, os, now, now),
    );
    // build・direct は Builder が成果物を作る（release は GitHub Releases の成果物を使うため指示を出さない）
    if (app.kind !== "release") {
      stmts.push(
        env.DB.prepare(
          `INSERT INTO build_jobs (id, owner_id, app_id, release_id, seq, commit_sha, os, status, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, 'queued', ?, ?)`,
        ).bind(crypto.randomUUID(), app.owner_id, app.id, releaseId, seq, head, os, now, now),
      );
    }
  }
  stmts.push(
    operationStatement(
      env,
      {
        owner_id: app.owner_id,
        app_id: app.id,
        kind: "sync",
        stage: "version_created",
        status: "ok",
        detail: { seq, commit_sha: head, previous_sha: app.current_sha, source },
      },
      now,
    ),
  );
  // D1 の batch は一つのトランザクションとして実行される。通番の更新に失敗したら全体を取り消す
  const results = await env.DB.batch(stmts);
  if ((results[0]?.meta.changes ?? 0) !== 1) {
    throw new Error("通番の更新が競合しました");
  }
  return { status: "created", seq, commit_sha: head, cancelled: results[2]?.meta.changes ?? 0 };
}
