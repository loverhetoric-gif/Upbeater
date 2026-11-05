/**
 * MCP の道具（ツール）。すべて呼び出した利用者（owner_id）のデータだけを扱う
 */
import { requestAppSync } from "./coordinator";
import { randomCode, sha256Hex } from "./crypto";
import { APP_KINDS, SUPPORTED_OS, type AppRow, type Env } from "./env";
import { createGitHubClient, GitHubError, type GitHubClient } from "./github";
import { checkBranchName, checkRepoName, commitFilesOp, createBranchOp, mergePrOp, openPrOp, OpError, shipChangeOp, type FileChange, type OpContext, type OpResult } from "./gitops";
import { operationStatement, recordOperation } from "./operations";
import { createBuilder } from "./routes/builder";

// ───────── 入力の検証（JSON Schema の部分集合） ─────────

export type Schema =
  | { type: "string"; description?: string; enum?: readonly string[]; maxLength?: number }
  | { type: "integer"; description?: string; minimum?: number }
  | { type: "boolean"; description?: string }
  | { type: "array"; description?: string; items: Schema; maxItems?: number }
  | { type: "object"; description?: string; properties: Record<string, Schema>; required?: readonly string[]; additionalProperties?: false };

export class InvalidParams extends Error {}

export function validate(schema: Schema, v: unknown, path = "引数"): unknown {
  switch (schema.type) {
    case "string":
      if (typeof v !== "string") throw new InvalidParams(`${path} は文字列です`);
      if (schema.maxLength !== undefined && v.length > schema.maxLength) throw new InvalidParams(`${path} が長すぎます`);
      if (schema.enum && !schema.enum.includes(v)) throw new InvalidParams(`${path} は ${schema.enum.join(" / ")} のいずれかです`);
      return v;
    case "integer":
      if (typeof v !== "number" || !Number.isSafeInteger(v)) throw new InvalidParams(`${path} は整数です`);
      if (schema.minimum !== undefined && v < schema.minimum) throw new InvalidParams(`${path} は ${schema.minimum} 以上です`);
      return v;
    case "boolean":
      if (typeof v !== "boolean") throw new InvalidParams(`${path} は true / false です`);
      return v;
    case "array":
      if (!Array.isArray(v)) throw new InvalidParams(`${path} は配列です`);
      if (schema.maxItems !== undefined && v.length > schema.maxItems) throw new InvalidParams(`${path} が多すぎます`);
      return v.map((x, i) => validate(schema.items, x, `${path}[${i}]`));
    case "object": {
      if (v === undefined) v = {};
      if (v === null || typeof v !== "object" || Array.isArray(v)) throw new InvalidParams(`${path} はオブジェクトです`);
      const o = v as Record<string, unknown>;
      for (const r of schema.required ?? []) if (o[r] === undefined || o[r] === null) throw new InvalidParams(`${path}.${r} が必要です`);
      const out: Record<string, unknown> = {};
      for (const [k, val] of Object.entries(o)) {
        const s = schema.properties[k];
        if (!s) throw new InvalidParams(`${path}.${k} は使えない項目です`);
        if (val !== undefined && val !== null) out[k] = validate(s, val, `${path}.${k}`);
      }
      return out;
    }
  }
}

// ───────── 道具の定義 ─────────

export type ToolResult = { ok: boolean; [k: string]: unknown } | OpResult;

export interface ToolContext {
  env: Env;
  owner_id: string;
  gh?: GitHubClient;
}

interface Tool {
  name: string;
  title: string;
  description: string;
  inputSchema: Extract<Schema, { type: "object" }>;
  annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean; idempotentHint?: boolean; openWorldHint?: boolean };
  run(ctx: ToolContext, args: Record<string, unknown>): Promise<ToolResult>;
}

const str = (description: string, maxLength = 200): Schema => ({ type: "string", description, maxLength });
const int = (description: string, minimum = 0): Schema => ({ type: "integer", description, minimum });
const requestId: Schema = { type: "string", description: "依頼 ID（任意）。同じ ID で再実行すると、完了済みなら結果を返し、失敗していればその段階から続ける", maxLength: 100 };
const fileSchema: Schema = {
  type: "array",
  description: "書き込む・削除するファイル",
  maxItems: 100,
  items: {
    type: "object",
    properties: {
      path: str("リポジトリ内のパス", 400),
      content: { type: "string", description: "内容（delete のときは省略）" },
      encoding: { type: "string", enum: ["utf-8", "base64"], description: "content の符号化（既定は utf-8）" },
      delete: { type: "boolean", description: "true ならこのファイルを削除する" },
    },
    required: ["path"],
  },
};
const stepSchema: Schema = {
  type: "object",
  description: "この OS のビルド手順",
  properties: {
    requires: { type: "array", items: { type: "string", maxLength: 100 }, maxItems: 30, description: "必要な道具（開始前に有無を点検する。例：flutter, java）" },
    build: { type: "array", items: { type: "string", maxLength: 2000 }, maxItems: 30, description: "順に実行するコマンド（リポジトリの直下で実行）" },
    artifact: { type: "string", maxLength: 400, description: "成果物のパス（リポジトリ内の相対パス。フォルダなら tar.gz にまとめる。既定は「.」＝リポジトリの内容）" },
    timeout_minutes: { type: "integer", minimum: 1, description: "上限の時間（分、既定 60、最大 180）" },
    install: {
      type: "object",
      description: "端末での導入の設定（署名付きで端末に届く）",
      properties: {
        package: { type: "string", maxLength: 200, description: "Android のパッケージ名（成果物と一致しなければ導入しない）" },
        bundle: { type: "string", maxLength: 200, description: "macOS の .app の名前（例：Example.app。/Applications に置く）" },
        bundle_id: { type: "string", maxLength: 200, description: "macOS のバンドル ID（成果物と一致しなければ導入しない）" },
        when_running: { type: "string", enum: ["wait", "next_launch", "restart"], description: "対象アプリが使用中のとき：終了を待つ／次回起動時に適用／即時に再起動" },
        health_seconds: { type: "integer", minimum: 0, description: "入れ替え後に起動を確かめる時間（秒、既定 15。0 なら確かめない）" },
      },
    },
  },
};
const stepsSchema: Schema = {
  type: "object",
  description: "OS ごとのビルド手順（build・direct のとき Builder が使う）",
  properties: { android: stepSchema, ios: stepSchema, macos: stepSchema, linux: stepSchema },
};
const mergeMethod: Schema = { type: "string", enum: ["squash", "merge", "rebase"], description: "マージの方法（既定は squash）" };

async function ownedApp(ctx: ToolContext, appId: string): Promise<AppRow> {
  const app = await ctx.env.DB.prepare("SELECT * FROM apps WHERE id = ? AND owner_id = ?").bind(appId, ctx.owner_id).first<AppRow>();
  if (!app) throw new OpError("app_not_found", `アプリ「${appId}」が見つかりません`);
  return app;
}

function gh(ctx: ToolContext): GitHubClient {
  return ctx.gh ?? createGitHubClient(ctx.env);
}

function opCtx(ctx: ToolContext): OpContext {
  return { env: ctx.env, gh: gh(ctx), owner_id: ctx.owner_id };
}

async function readyReleases(env: Env, appId: string) {
  const r = await env.DB.prepare(
    `SELECT os, MAX(seq) AS seq FROM releases WHERE app_id = ? AND status = 'ready' GROUP BY os`,
  )
    .bind(appId)
    .all<{ os: string; seq: number }>();
  return Object.fromEntries(r.results.map((x) => [x.os, x.seq]));
}

export const TOOLS: Tool[] = [
  {
    name: "list_apps",
    title: "アプリの一覧",
    description: "登録したアプリの一覧。最新の版（通番とコミット）、OS ごとの配布可能な版、巻き戻しの固定、端末の台数を返す",
    inputSchema: { type: "object", properties: {} },
    annotations: { readOnlyHint: true },
    async run(ctx) {
      const apps = await ctx.env.DB.prepare(
        `SELECT a.*, (SELECT COUNT(*) FROM installs i WHERE i.app_id = a.id) AS device_count FROM apps a WHERE a.owner_id = ? ORDER BY a.name`,
      )
        .bind(ctx.owner_id)
        .all<AppRow & { device_count: number }>();
      const items = [];
      for (const a of apps.results) {
        items.push({
          id: a.id,
          name: a.name,
          repo: a.repo_full_name,
          branch: a.branch,
          kind: a.kind,
          target_os: JSON.parse(a.target_os),
          latest_seq: a.last_seq,
          latest_commit: a.current_sha,
          pinned_seq: a.pinned_seq,
          ready_seq_by_os: await readyReleases(ctx.env, a.id),
          last_checked_at: a.last_checked_at,
          device_count: a.device_count,
        });
      }
      return { ok: true, apps: items };
    },
  },
  {
    name: "get_app",
    title: "アプリの詳細",
    description: "アプリの詳細。最近の版、OS ごとの配布物の状態、端末ごとの版と状態、最近の操作の記録",
    inputSchema: { type: "object", properties: { app_id: str("アプリの ID") }, required: ["app_id"] },
    annotations: { readOnlyHint: true },
    async run(ctx, a) {
      const app = await ownedApp(ctx, a.app_id as string);
      const db = ctx.env.DB;
      const [versions, releases, installs, ops] = await Promise.all([
        db.prepare("SELECT seq, commit_sha, source, created_at FROM app_versions WHERE app_id = ? ORDER BY seq DESC LIMIT 10").bind(app.id).all(),
        db.prepare("SELECT id, seq, os, status, sha256, size, updated_at FROM releases WHERE app_id = ? ORDER BY seq DESC, os LIMIT 30").bind(app.id).all(),
        db
          .prepare(
            `SELECT d.id AS device_id, d.name, d.os, i.seq, i.commit_sha, i.status, i.message, i.updated_at, d.last_seen_at
             FROM installs i JOIN devices d ON d.id = i.device_id WHERE i.app_id = ? ORDER BY d.name`,
          )
          .bind(app.id)
          .all(),
        db.prepare("SELECT kind, stage, status, reason, needs_human, created_at FROM operations WHERE app_id = ? ORDER BY id DESC LIMIT 15").bind(app.id).all(),
      ]);
      return {
        ok: true,
        app: { id: app.id, name: app.name, repo: app.repo_full_name, branch: app.branch, kind: app.kind, target_os: JSON.parse(app.target_os), latest_seq: app.last_seq, latest_commit: app.current_sha, pinned_seq: app.pinned_seq },
        versions: versions.results,
        releases: releases.results,
        devices: installs.results,
        recent_operations: ops.results,
      };
    },
  },
  {
    name: "register_app",
    title: "アプリの登録",
    description: "GitHub のリポジトリを配信対象として登録する。リポジトリは GitHub 操作の許可リストにも加わる。GitHub App がそのリポジトリにインストールされている必要がある",
    inputSchema: {
      type: "object",
      properties: {
        name: str("表示名", 100),
        repo: str("owner/name"),
        branch: str("対象ブランチ（既定はリポジトリの既定ブランチ）"),
        kind: { type: "string", enum: APP_KINDS, description: "direct：そのまま配る／build：Builder がビルド／release：GitHub Releases の成果物" },
        target_os: { type: "array", items: { type: "string", enum: SUPPORTED_OS }, maxItems: 4, description: "対象 OS" },
        install_steps: stepsSchema,
      },
      required: ["name", "repo", "kind", "target_os"],
    },
    annotations: { idempotentHint: false },
    async run(ctx, a) {
      const repo = checkRepoName(a.repo as string);
      const fullName = `${repo.owner}/${repo.name}`;
      const os = [...new Set(a.target_os as string[])];
      if (os.length === 0) throw new OpError("invalid_input", "target_os を 1 つ以上指定してください");
      // リポジトリに届くか（GitHub App のインストール）を先に確かめる
      const def = await gh(ctx).getDefaultBranch(repo);
      const branch = checkBranchName((a.branch as string | undefined) ?? def);
      const exists = await ctx.env.DB.prepare("SELECT id FROM apps WHERE owner_id = ? AND (name = ? OR (repo_full_name = ? AND branch = ?))")
        .bind(ctx.owner_id, a.name, fullName, branch)
        .first<{ id: string }>();
      if (exists) return { ok: true, app_id: exists.id, already_registered: true };
      const id = crypto.randomUUID();
      const now = Date.now();
      await ctx.env.DB.batch([
        ctx.env.DB.prepare(
          `INSERT INTO apps (id, owner_id, name, repo_full_name, branch, kind, target_os, install_steps, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).bind(id, ctx.owner_id, a.name, fullName, branch, a.kind, JSON.stringify(os), JSON.stringify(a.install_steps ?? {}), now, now),
        ctx.env.DB.prepare("INSERT OR IGNORE INTO repo_allowlist (owner_id, repo_full_name, created_at) VALUES (?, ?, ?)").bind(ctx.owner_id, fullName, now),
        operationStatement(ctx.env, { owner_id: ctx.owner_id, app_id: id, kind: "app", stage: "register", status: "ok", detail: { repo: fullName, branch } }, now),
      ]);
      const sync = await requestAppSync(ctx.env, id, "register");
      return { ok: true, app_id: id, repo: fullName, branch, first_sync: sync.status };
    },
  },
  {
    name: "push_update",
    title: "配信",
    description:
      "アプリの最新版を配信する（GitHub を照合して新しい版を取り込み、巻き戻しの固定を解除する）。seq を指定すると、その版を配信する（最新より古ければ巻き戻しになる）。端末は次の照合で取得する",
    inputSchema: { type: "object", properties: { app_id: str("アプリの ID"), seq: int("配信する版の通番（省略時は最新）", 1) }, required: ["app_id"] },
    async run(ctx, a) {
      const app = await ownedApp(ctx, a.app_id as string);
      const sync = await requestAppSync(ctx.env, app.id, "manual");
      const fresh = await ownedApp(ctx, app.id);
      const seq = a.seq as number | undefined;
      if (seq !== undefined && seq < fresh.last_seq) return rollbackTo(ctx, fresh, seq, "push_update");
      await ctx.env.DB.prepare("UPDATE apps SET pinned_seq = NULL, updated_at = ? WHERE id = ?").bind(Date.now(), app.id).run();
      await recordOperation(ctx.env, { owner_id: ctx.owner_id, app_id: app.id, kind: "deploy", stage: "push_update", status: "ok", detail: { seq: fresh.last_seq } });
      return {
        ok: true,
        app_id: app.id,
        sync: sync.status,
        latest_seq: fresh.last_seq,
        latest_commit: fresh.current_sha,
        ready_seq_by_os: await readyReleases(ctx.env, app.id),
        note: "配布物が揃った OS の端末から順に、次の照合で最新版を取得します",
      };
    },
  },
  {
    name: "rollback",
    title: "前の版へ戻す",
    description: "指定した版に固定する。端末には署名付きの巻き戻し指示を配る。解除は push_update",
    inputSchema: { type: "object", properties: { app_id: str("アプリの ID"), seq: int("戻す先の通番", 1) }, required: ["app_id", "seq"] },
    annotations: { destructiveHint: true, idempotentHint: true },
    async run(ctx, a) {
      return rollbackTo(ctx, await ownedApp(ctx, a.app_id as string), a.seq as number, "rollback");
    },
  },
  {
    name: "list_devices",
    title: "端末の一覧",
    description: "登録した端末の一覧（OS・最終接続）",
    inputSchema: { type: "object", properties: {} },
    annotations: { readOnlyHint: true },
    async run(ctx) {
      const r = await ctx.env.DB.prepare("SELECT id, name, os, created_at, last_seen_at FROM devices WHERE owner_id = ? ORDER BY name")
        .bind(ctx.owner_id)
        .all();
      return { ok: true, devices: r.results };
    },
  },
  {
    name: "create_registration_code",
    title: "端末の登録コード",
    description: "端末を登録するための一回限りのコードを発行する（既定 15 分で失効）",
    inputSchema: { type: "object", properties: { ttl_minutes: int("有効な時間（分、5〜1440）", 5) } },
    async run(ctx, a) {
      const ttl = Math.min((a.ttl_minutes as number | undefined) ?? 15, 1440);
      const code = randomCode(10);
      const now = Date.now();
      await ctx.env.DB.prepare("INSERT INTO registration_codes (code_hash, owner_id, expires_at, created_at) VALUES (?, ?, ?, ?)")
        .bind(await sha256Hex("reg." + code), ctx.owner_id, now + ttl * 60_000, now)
        .run();
      return { ok: true, code: `${code.slice(0, 5)}-${code.slice(5)}`, expires_at: now + ttl * 60_000 };
    },
  },
  {
    name: "get_install_status",
    title: "配信の結果",
    description: "端末ごとの導入状況。いま動いている版・最後の報告・最後の照合・未適用の版を返す",
    inputSchema: { type: "object", properties: { app_id: str("アプリの ID（省略時はすべて）"), device_id: str("端末の ID（省略時はすべて）") } },
    annotations: { readOnlyHint: true },
    async run(ctx, a) {
      const where = ["d.owner_id = ?"];
      const binds: unknown[] = [ctx.owner_id];
      if (a.app_id) (where.push("ap.id = ?"), binds.push(a.app_id));
      if (a.device_id) (where.push("d.id = ?"), binds.push(a.device_id));
      const r = await ctx.env.DB.prepare(
        `SELECT ap.id AS app_id, ap.name AS app_name, d.id AS device_id, d.name AS device_name, d.os, d.last_seen_at,
                i.seq AS installed_seq, i.status, i.message, i.updated_at,
                (SELECT MAX(seq) FROM releases r WHERE r.app_id = ap.id AND r.os = d.os AND r.status = 'ready') AS ready_seq,
                ap.pinned_seq
         FROM devices d JOIN apps ap ON ap.owner_id = d.owner_id
         LEFT JOIN installs i ON i.device_id = d.id AND i.app_id = ap.id
         WHERE ${where.join(" AND ")} AND ap.target_os LIKE '%"' || d.os || '"%'
         ORDER BY ap.name, d.name`,
      )
        .bind(...binds)
        .all<{ installed_seq: number | null; ready_seq: number | null; pinned_seq: number | null }>();
      return {
        ok: true,
        items: r.results.map((x) => {
          const target = x.pinned_seq ?? x.ready_seq;
          return { ...x, target_seq: target, pending_update: target !== null && target !== (x.installed_seq ?? 0) };
        }),
      };
    },
  },
  {
    name: "list_operations",
    title: "操作の記録",
    description: "同期・配信・GitHub 操作の記録（段階・結果・理由）。needs_human_only で人の判断が要るものだけを返す",
    inputSchema: {
      type: "object",
      properties: { app_id: str("アプリの ID"), needs_human_only: { type: "boolean", description: "人の判断が要るものだけ" }, limit: int("件数（既定 30、最大 100）", 1) },
    },
    annotations: { readOnlyHint: true },
    async run(ctx, a) {
      const where = ["owner_id = ?"];
      const binds: unknown[] = [ctx.owner_id];
      if (a.app_id) (where.push("app_id = ?"), binds.push(a.app_id));
      if (a.needs_human_only) where.push("needs_human = 1");
      const limit = Math.min((a.limit as number | undefined) ?? 30, 100);
      const r = await ctx.env.DB.prepare(
        `SELECT id, app_id, device_id, kind, stage, status, reason, retryable, needs_human, detail, created_at FROM operations WHERE ${where.join(" AND ")} ORDER BY id DESC LIMIT ${limit}`,
      )
        .bind(...binds)
        .all();
      return { ok: true, operations: r.results };
    },
  },
  {
    name: "create_branch",
    title: "ブランチの作成",
    description: "作業ブランチを作る（既にあればそのまま使う）。既定ブランチは作業ブランチにできない",
    inputSchema: { type: "object", properties: { repo: str("owner/name"), branch: str("作るブランチ"), from: str("元のブランチ（既定はリポジトリの既定ブランチ）"), request_id: requestId }, required: ["repo", "branch"] },
    async run(ctx, a) {
      return createBranchOp(opCtx(ctx), a as Parameters<typeof createBranchOp>[1]);
    },
  },
  {
    name: "commit_files",
    title: "コミット",
    description: "作業ブランチにファイルの追加・変更・削除を 1 つのコミットとして書き込む。既定ブランチ（main）への直接書き込みは禁止",
    inputSchema: {
      type: "object",
      properties: { repo: str("owner/name"), branch: str("書き込むブランチ"), message: str("コミットメッセージ", 2000), files: fileSchema, request_id: requestId },
      required: ["repo", "branch", "message", "files"],
    },
    async run(ctx, a) {
      return commitFilesOp(opCtx(ctx), a as { repo: string; branch: string; message: string; files: FileChange[]; request_id?: string });
    },
  },
  {
    name: "open_pr",
    title: "PR の作成",
    description: "PR を作る（同じブランチの PR が既にあればそれを返す）",
    inputSchema: {
      type: "object",
      properties: { repo: str("owner/name"), head: str("作業ブランチ"), base: str("取り込み先（既定はリポジトリの既定ブランチ）"), title: str("題名", 256), body: str("説明", 60000), request_id: requestId },
      required: ["repo", "head", "title"],
    },
    async run(ctx, a) {
      return openPrOp(opCtx(ctx), a as Parameters<typeof openPrOp>[1]);
    },
  },
  {
    name: "merge_pr",
    title: "PR のマージ",
    description: "マージ前に衝突を確認し、衝突していれば main を取り込んで再試行する。解消できなければ PR を残し、衝突しうるファイルを返す。ブランチ保護・必須の検査で止まる場合は満たせない条件を返す",
    inputSchema: { type: "object", properties: { repo: str("owner/name"), number: int("PR の番号", 1), method: mergeMethod, request_id: requestId }, required: ["repo", "number"] },
    annotations: { destructiveHint: true },
    async run(ctx, a) {
      return mergePrOp(opCtx(ctx), a as Parameters<typeof mergePrOp>[1]);
    },
  },
  {
    name: "ship_change",
    title: "変更を一続きで反映",
    description:
      "ブランチ作成 → コミット → PR → マージを一続きで行う。失敗した場合は段階・理由・再試行の可否を返し、同じ request_id で呼び直すと失敗した段階から続ける。マージ後は自動で配信が始まる",
    inputSchema: {
      type: "object",
      properties: {
        repo: str("owner/name"),
        branch: str("作業ブランチ"),
        title: str("PR の題名", 256),
        message: str("コミットメッセージ（既定は題名）", 2000),
        body: str("PR の説明", 60000),
        base: str("取り込み先（既定はリポジトリの既定ブランチ）"),
        files: fileSchema,
        merge: { type: "boolean", description: "false なら PR の作成までで止める（既定は true）" },
        method: mergeMethod,
        request_id: requestId,
      },
      required: ["repo", "branch", "title", "files"],
    },
    annotations: { destructiveHint: true },
    async run(ctx, a) {
      return shipChangeOp(opCtx(ctx), a as Parameters<typeof shipChangeOp>[1]);
    },
  },
  {
    name: "set_build_steps",
    title: "ビルド手順の設定",
    description: "アプリの OS ごとのビルド手順（必要な道具・コマンド・成果物のパス）を設定する。次の版から使われる",
    inputSchema: { type: "object", properties: { app_id: str("アプリの ID"), install_steps: stepsSchema }, required: ["app_id", "install_steps"] },
    annotations: { idempotentHint: true },
    async run(ctx, a) {
      const app = await ownedApp(ctx, a.app_id as string);
      await ctx.env.DB.prepare("UPDATE apps SET install_steps = ?, updated_at = ? WHERE id = ?").bind(JSON.stringify(a.install_steps), Date.now(), app.id).run();
      return { ok: true, app_id: app.id, install_steps: a.install_steps };
    },
  },
  {
    name: "create_builder",
    title: "Builder の登録",
    description: "Builder（ビルド機）を登録し、接続用のトークンを発行する。トークンはこの応答でしか表示されないため、Builder の設定ファイルに保存する",
    inputSchema: { type: "object", properties: { name: str("Builder の名前（例：自宅の Mac）", 100) }, required: ["name"] },
    async run(ctx, a) {
      const b = await createBuilder(ctx.env, ctx.owner_id, a.name as string);
      return { ok: true, ...b, note: "トークンは Builder の ~/.upbeater/builder.token に保存してください（他の人に見せない）" };
    },
  },
  {
    name: "list_builders",
    title: "Builder の一覧",
    description: "登録した Builder と最終接続・ビルドできる OS",
    inputSchema: { type: "object", properties: {} },
    annotations: { readOnlyHint: true },
    async run(ctx) {
      const r = await ctx.env.DB.prepare("SELECT id, name, os, created_at, last_seen_at, revoked_at FROM builders WHERE owner_id = ? ORDER BY name").bind(ctx.owner_id).all<{ os: string }>();
      return { ok: true, builders: r.results.map((b) => ({ ...b, os: JSON.parse(b.os) })) };
    },
  },
  {
    name: "list_builds",
    title: "ビルドの記録",
    description: "ビルド指示の状況（待ち・実行中・成功・失敗・取り消し）。失敗は段階・理由・末尾ログを返す",
    inputSchema: {
      type: "object",
      properties: {
        app_id: str("アプリの ID"),
        status: { type: "string", enum: ["queued", "claimed", "succeeded", "failed", "cancelled"], description: "状態で絞り込む" },
        include_log: { type: "boolean", description: "末尾ログを含める（既定は失敗のときだけ含める）" },
        limit: int("件数（既定 20、最大 100）", 1),
      },
    },
    annotations: { readOnlyHint: true },
    async run(ctx, a) {
      const where = ["j.owner_id = ?"];
      const binds: unknown[] = [ctx.owner_id];
      if (a.app_id) (where.push("j.app_id = ?"), binds.push(a.app_id));
      if (a.status) (where.push("j.status = ?"), binds.push(a.status));
      const limit = Math.min((a.limit as number | undefined) ?? 20, 100);
      const r = await ctx.env.DB.prepare(
        `SELECT j.id, j.app_id, ap.name AS app_name, j.seq, j.commit_sha, j.os, j.status, j.attempt, j.stage, j.reason, j.log_tail, b.name AS builder, j.created_at, j.updated_at
         FROM build_jobs j JOIN apps ap ON ap.id = j.app_id LEFT JOIN builders b ON b.id = j.builder_id
         WHERE ${where.join(" AND ")} ORDER BY j.created_at DESC, j.id LIMIT ${limit}`,
      )
        .bind(...binds)
        .all<{ status: string; log_tail: string | null }>();
      return {
        ok: true,
        builds: r.results.map((j) => (a.include_log || j.status === "failed" ? j : { ...j, log_tail: undefined })),
      };
    },
  },
  {
    name: "get_request",
    title: "GitHub 操作の状況",
    description: "依頼 ID の GitHub 操作の状況（実行中・成功・失敗、最後の段階、結果または失敗の理由）",
    inputSchema: { type: "object", properties: { request_id: str("依頼 ID", 100) }, required: ["request_id"] },
    annotations: { readOnlyHint: true },
    async run(ctx, a) {
      const r = await ctx.env.DB.prepare("SELECT request_id, tool, status, stage, result, error, created_at, updated_at FROM github_requests WHERE owner_id = ? AND request_id = ?")
        .bind(ctx.owner_id, a.request_id)
        .first<{ result: string | null; error: string | null }>();
      if (!r) return { ok: false, code: "not_found", reason: "その依頼 ID は見つかりません" };
      return { ok: true, ...r, result: r.result ? JSON.parse(r.result) : null, error: r.error ? JSON.parse(r.error) : null };
    },
  },
];

async function rollbackTo(ctx: ToolContext, app: AppRow, seq: number, stage: string) {
  if (seq > app.last_seq) throw new OpError("invalid_input", `通番 ${seq} の版はまだありません（最新は ${app.last_seq}）`);
  const ready = await ctx.env.DB.prepare("SELECT os FROM releases WHERE app_id = ? AND seq = ? AND status = 'ready'").bind(app.id, seq).all<{ os: string }>();
  if (ready.results.length === 0) throw new OpError("release_not_ready", `通番 ${seq} には配布できる成果物がありません`);
  const pin = seq === app.last_seq ? null : seq;
  await ctx.env.DB.batch([
    ctx.env.DB.prepare("UPDATE apps SET pinned_seq = ?, updated_at = ? WHERE id = ?").bind(pin, Date.now(), app.id),
    operationStatement(ctx.env, { owner_id: ctx.owner_id, app_id: app.id, kind: "deploy", stage, status: "ok", detail: { pinned_seq: pin, target_seq: seq } }),
  ]);
  return { ok: true, app_id: app.id, target_seq: seq, pinned: pin !== null, os: ready.results.map((r) => r.os), note: "端末は次の照合で、署名付きの巻き戻し指示を受け取ります" };
}

/** 道具を実行する。失敗は例外にせず、段階・理由・再試行の可否として返す */
export async function callTool(ctx: ToolContext, name: string, rawArgs: unknown): Promise<ToolResult> {
  const tool = TOOLS.find((t) => t.name === name);
  if (!tool) throw new InvalidParams(`道具「${name}」はありません`);
  const args = validate(tool.inputSchema, rawArgs) as Record<string, unknown>;
  try {
    return await tool.run(ctx, args);
  } catch (e) {
    if (e instanceof OpError) return { ok: false, stage: name, code: e.code, reason: e.message, retryable: e.opts.retryable ?? false, needs_human: e.opts.needsHuman ?? false, ...(e.opts.details ? { details: e.opts.details } : {}) };
    if (e instanceof GitHubError) return { ok: false, stage: name, code: "github_error", reason: e.message, retryable: e.retryable, needs_human: e.needsHuman };
    console.error("道具の実行に失敗", name);
    return { ok: false, stage: name, code: "internal_error", reason: "一時的な内部エラー", retryable: true, needs_human: false };
  }
}
