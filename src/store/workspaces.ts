import { randomUUID, randomBytes } from "node:crypto";
import { db } from "./db.js";
import { now } from "./util.js";
import { mergeConnectorConfigWithSentinel } from "../redact.js";
import type { NewWorkspace, Workspace } from "../types.js";

export const workspaces = {
  list(includeArchived = false): Workspace[] {
    return db
      .prepare(
        `SELECT * FROM workspaces ${includeArchived ? "" : "WHERE archived = 0"} ORDER BY name ASC`
      )
      .all() as Workspace[];
  },
  get(id: string): Workspace | undefined {
    return db.prepare("SELECT * FROM workspaces WHERE id = ?").get(id) as Workspace | undefined;
  },
  getBySlug(slug: string): Workspace | undefined {
    return db.prepare("SELECT * FROM workspaces WHERE slug = ?").get(slug) as Workspace | undefined;
  },
  // Per-workspace API token (PER-24) — the trust boundary for cross-tenant authz over the loopback API.
  getByToken(token: string): Workspace | undefined {
    return db.prepare("SELECT * FROM workspaces WHERE token = ?").get(token) as Workspace | undefined;
  },
  create(w: NewWorkspace): Workspace {
    const id = randomUUID();
    const ts = now();
    db.prepare(
      `INSERT INTO workspaces (id,slug,name,kind,config_dir,account_label,secrets_file,default_dir,git_name,git_email,daily_budget_usd,max_concurrent,stall_minutes,ask_remind_hours,ask_policy,capabilities,
        default_backend,default_model,sandbox_mode,sandbox_allow,backends,ticket_connector,connector_config,slack_config,egress_config,ideas_config,review_backend,review_model,verify_mode,fallback_backend,fallback_model,route_config,auto_grade,auto_skill,skill_distill,auto_plan,auto_build,auto_review,merge_gate,live_steer,plan_panel,review_panel,review_min_difficulty,archived,token,created_at,updated_at)
       VALUES (@id,@slug,@name,@kind,@config_dir,@account_label,@secrets_file,@default_dir,@git_name,@git_email,@daily_budget_usd,@max_concurrent,@stall_minutes,@ask_remind_hours,@ask_policy,@capabilities,
        @default_backend,@default_model,@sandbox_mode,@sandbox_allow,@backends,@ticket_connector,@connector_config,@slack_config,@egress_config,@ideas_config,@review_backend,@review_model,@verify_mode,@fallback_backend,@fallback_model,@route_config,@auto_grade,@auto_skill,@skill_distill,@auto_plan,@auto_build,@auto_review,@merge_gate,@live_steer,@plan_panel,@review_panel,@review_min_difficulty,@archived,@token,@created_at,@updated_at)`
    ).run({
      id,
      token: randomBytes(24).toString("hex"),
      slug: w.slug,
      name: w.name,
      kind: w.kind ?? "client",
      config_dir: w.config_dir,
      account_label: w.account_label ?? null,
      secrets_file: w.secrets_file ?? null,
      default_dir: w.default_dir ?? null,
      git_name: w.git_name ?? null,
      git_email: w.git_email ?? null,
      daily_budget_usd: w.daily_budget_usd ?? null,
      max_concurrent: w.max_concurrent ?? null,
      stall_minutes: w.stall_minutes ?? null,
      ask_remind_hours: w.ask_remind_hours ?? null,
      ask_policy: w.ask_policy ?? null,
      capabilities: w.capabilities ?? null,
      default_backend: w.default_backend ?? "claude-code",
      default_model: w.default_model ?? null,
      sandbox_mode: w.sandbox_mode ?? "guard",
      sandbox_allow: w.sandbox_allow ? JSON.stringify(w.sandbox_allow) : null,
      backends: w.backends && w.backends.length ? JSON.stringify(w.backends) : null,
      ticket_connector: w.ticket_connector ?? "native",
      connector_config: w.connector_config ? JSON.stringify(w.connector_config) : null,
      slack_config: w.slack_config ? JSON.stringify(w.slack_config) : null,
      egress_config: w.egress_config ? JSON.stringify(w.egress_config) : null,
      ideas_config: w.ideas_config ? JSON.stringify(w.ideas_config) : null,
      review_backend: w.review_backend ?? null,
      review_model: w.review_model ?? null,
      verify_mode: w.verify_mode ?? null,
      fallback_backend: w.fallback_backend ?? null,
      fallback_model: w.fallback_model ?? null,
      route_config: w.route_config ? (typeof w.route_config === "string" ? w.route_config : JSON.stringify(w.route_config)) : null,
      auto_grade: w.auto_grade === undefined ? 1 : w.auto_grade ? 1 : 0,
      auto_skill: w.auto_skill ? 1 : 0,
      skill_distill: w.skill_distill ? 1 : 0,
      auto_plan: w.auto_plan ? 1 : 0,
      auto_build: w.auto_build ? 1 : 0,
      auto_review: w.auto_review ? 1 : 0,
      merge_gate: w.merge_gate ? 1 : 0,
      live_steer: w.live_steer ? 1 : 0,
      plan_panel: w.plan_panel ? 1 : 0,
      review_panel: w.review_panel ? 1 : 0,
      review_min_difficulty: w.review_min_difficulty ?? null,
      archived: w.archived ? 1 : 0,
      created_at: ts,
      updated_at: ts,
    });
    return this.get(id)!;
  },
  update(id: string, patch: Partial<NewWorkspace>): Workspace | undefined {
    const cur = this.get(id);
    if (!cur) return undefined;
    const next = {
      ...cur,
      ...patch,
      connector_config:
        patch.connector_config !== undefined
          ? patch.connector_config
            ? mergeConnectorConfigWithSentinel(cur.connector_config, patch.connector_config)
            : null
          : cur.connector_config,
      slack_config:
        patch.slack_config !== undefined
          ? patch.slack_config
            ? JSON.stringify(patch.slack_config)
            : null
          : cur.slack_config,
      egress_config:
        patch.egress_config !== undefined
          ? patch.egress_config
            ? JSON.stringify(patch.egress_config)
            : null
          : cur.egress_config,
      ideas_config:
        patch.ideas_config !== undefined
          ? patch.ideas_config
            ? typeof patch.ideas_config === "string"
              ? patch.ideas_config
              : JSON.stringify(patch.ideas_config)
            : null
          : cur.ideas_config,
      route_config:
        patch.route_config !== undefined
          ? patch.route_config
            ? typeof patch.route_config === "string"
              ? patch.route_config
              : JSON.stringify(patch.route_config)
            : null
          : cur.route_config,
      sandbox_allow:
        patch.sandbox_allow !== undefined
          ? patch.sandbox_allow && patch.sandbox_allow.length
            ? JSON.stringify(patch.sandbox_allow)
            : null
          : cur.sandbox_allow,
      backends:
        patch.backends !== undefined
          ? patch.backends && patch.backends.length
            ? JSON.stringify(patch.backends)
            : null
          : cur.backends,
      auto_grade: patch.auto_grade !== undefined ? (patch.auto_grade ? 1 : 0) : cur.auto_grade,
      archived: patch.archived !== undefined ? (patch.archived ? 1 : 0) : cur.archived,
      auto_skill: patch.auto_skill !== undefined ? (patch.auto_skill ? 1 : 0) : cur.auto_skill,
      skill_distill: patch.skill_distill !== undefined ? (patch.skill_distill ? 1 : 0) : cur.skill_distill,
      auto_plan: patch.auto_plan !== undefined ? (patch.auto_plan ? 1 : 0) : cur.auto_plan,
      auto_build: patch.auto_build !== undefined ? (patch.auto_build ? 1 : 0) : cur.auto_build,
      auto_review: patch.auto_review !== undefined ? (patch.auto_review ? 1 : 0) : cur.auto_review,
      merge_gate: patch.merge_gate !== undefined ? (patch.merge_gate ? 1 : 0) : cur.merge_gate,
      live_steer: patch.live_steer !== undefined ? (patch.live_steer ? 1 : 0) : cur.live_steer,
      plan_panel: patch.plan_panel !== undefined ? (patch.plan_panel ? 1 : 0) : cur.plan_panel,
      review_panel: patch.review_panel !== undefined ? (patch.review_panel ? 1 : 0) : cur.review_panel,
      updated_at: now(),
    };
    db.prepare(
      `UPDATE workspaces SET slug=@slug,name=@name,kind=@kind,config_dir=@config_dir,
        account_label=@account_label,secrets_file=@secrets_file,default_dir=@default_dir,git_name=@git_name,git_email=@git_email,daily_budget_usd=@daily_budget_usd,max_concurrent=@max_concurrent,stall_minutes=@stall_minutes,ask_remind_hours=@ask_remind_hours,ask_policy=@ask_policy,capabilities=@capabilities,default_backend=@default_backend,
        default_model=@default_model,sandbox_mode=@sandbox_mode,sandbox_allow=@sandbox_allow,backends=@backends,ticket_connector=@ticket_connector,
        connector_config=@connector_config,slack_config=@slack_config,egress_config=@egress_config,ideas_config=@ideas_config,review_backend=@review_backend,review_model=@review_model,verify_mode=@verify_mode,fallback_backend=@fallback_backend,fallback_model=@fallback_model,route_config=@route_config,auto_grade=@auto_grade,auto_skill=@auto_skill,skill_distill=@skill_distill,auto_plan=@auto_plan,auto_build=@auto_build,auto_review=@auto_review,merge_gate=@merge_gate,live_steer=@live_steer,plan_panel=@plan_panel,review_panel=@review_panel,review_min_difficulty=@review_min_difficulty,archived=@archived,updated_at=@updated_at WHERE id=@id`
    ).run(next as any);
    return this.get(id);
  },
  remove(id: string): void {
    db.prepare("DELETE FROM workspaces WHERE id = ?").run(id);
  },
  // Filesystem deny-list for a job scoped to `workspaceId`: every OTHER workspace's repo roots
  // + their secrets files. Re-granted cwd/add_dirs still win (sandbox.ts layering).
  isolationDenyDirs(workspaceId: string): string[] {
    const otherRoots = db
      .prepare(
        `SELECT r.path AS p FROM repos r WHERE r.workspace_id != ?`
      )
      .all(workspaceId) as Array<{ p: string }>;
    const otherSecrets = db
      .prepare(
        `SELECT secrets_file AS p FROM workspaces WHERE id != ? AND secrets_file IS NOT NULL`
      )
      .all(workspaceId) as Array<{ p: string }>;
    return [...otherRoots, ...otherSecrets].map((r) => r.p);
  },
};
