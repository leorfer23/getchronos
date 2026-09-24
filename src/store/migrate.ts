import type Database from "better-sqlite3";
import { randomBytes } from "node:crypto";
import { CONFIG } from "../config.js";

// Real migrations, tracked via SQLite's `PRAGMA user_version`. Each entry runs at most once, in
// order, inside its own transaction (DDL is transactional in SQLite — a mid-migration crash rolls
// back cleanly rather than leaving the schema half-applied). Never edit a migration once shipped —
// append a new one instead, same as any other migration tool (goose/golang-migrate/etc.).
export interface Migration {
  version: number;
  name: string;
  up: (db: Database.Database) => void;
  // Opt out of the standard db.transaction() wrap. Needed when `up` must toggle
  // PRAGMA foreign_keys — that pragma is a no-op while a transaction is pending, so a
  // migration that rebuilds a table other tables reference via FK (DROP TABLE cascades
  // ON DELETE actions to those children when foreign_keys=ON) must flip it off *before*
  // opening its own transaction, and back on after committing.
  manualTx?: boolean;
}

export const MIGRATIONS: Migration[] = [
  {
    version: 1,
    name: "baseline schema",
    up: (db) => {
      db.exec(`
CREATE TABLE IF NOT EXISTS jobs (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT,
  goal TEXT NOT NULL,
  append_system TEXT,
  profile TEXT NOT NULL DEFAULT 'claude',
  cwd TEXT NOT NULL,
  add_dirs TEXT,
  model TEXT,
  allowed_tools TEXT,
  disallowed_tools TEXT,
  trigger_type TEXT NOT NULL DEFAULT 'manual',
  cron_expr TEXT,
  timezone TEXT NOT NULL DEFAULT 'UTC',
  max_budget_usd REAL,
  timeout_sec INTEGER NOT NULL DEFAULT 3600,
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS runs (
  id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  status TEXT NOT NULL,
  trigger_src TEXT,
  session_id TEXT,
  pid INTEGER,
  started_at TEXT,
  ended_at TEXT,
  exit_code INTEGER,
  num_turns INTEGER,
  cost_usd REAL,
  tokens_in INTEGER,
  tokens_out INTEGER,
  is_error INTEGER,
  summary TEXT,
  error TEXT
);

CREATE TABLE IF NOT EXISTS run_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  ts TEXT NOT NULL,
  type TEXT,
  payload TEXT
);

CREATE TABLE IF NOT EXISTS triggers (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  source TEXT NOT NULL DEFAULT 'http',
  token TEXT,
  config TEXT,
  filter TEXT,
  job_id TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  inject TEXT NOT NULL DEFAULT 'none',
  last_fired_at TEXT,
  fire_count INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS workspaces (
  id TEXT PRIMARY KEY,
  slug TEXT UNIQUE NOT NULL,
  name TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'client',
  config_dir TEXT NOT NULL,
  account_label TEXT,
  secrets_file TEXT,
  default_backend TEXT NOT NULL DEFAULT 'claude-code',
  default_model TEXT,
  sandbox_mode TEXT NOT NULL DEFAULT 'guard',
  ticket_connector TEXT NOT NULL DEFAULT 'native',
  connector_config TEXT,
  archived INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS repos (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  parent_id TEXT,
  name TEXT NOT NULL,
  path TEXT NOT NULL,
  git_remote TEXT,
  default_branch TEXT NOT NULL DEFAULT 'main',
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_runs_job ON runs(job_id);
CREATE INDEX IF NOT EXISTS idx_events_run ON run_events(run_id);
CREATE INDEX IF NOT EXISTS idx_triggers_job ON triggers(job_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_triggers_token ON triggers(token) WHERE token IS NOT NULL;
CREATE TABLE IF NOT EXISTS tickets (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  repo_id TEXT REFERENCES repos(id),
  key TEXT NOT NULL,
  slug TEXT NOT NULL,
  title TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'backlog',
  priority TEXT NOT NULL DEFAULT 'P2',
  backend TEXT,
  model TEXT,
  assignee TEXT NOT NULL DEFAULT 'agent',
  file_path TEXT NOT NULL,
  external_system TEXT,
  external_id TEXT,
  external_url TEXT,
  tags TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_repos_ws ON repos(workspace_id);
CREATE INDEX IF NOT EXISTS idx_tickets_ws ON tickets(workspace_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_tickets_key ON tickets(workspace_id, key);

CREATE TABLE IF NOT EXISTS reviews (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  ticket_id TEXT REFERENCES tickets(id),
  state TEXT NOT NULL DEFAULT 'pending',
  diff_ref TEXT,
  notes TEXT,
  created_at TEXT NOT NULL,
  reviewed_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_reviews_state ON reviews(state);

CREATE TABLE IF NOT EXISTS calendars (
  id TEXT PRIMARY KEY,
  workspace_id TEXT REFERENCES workspaces(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  ics_url TEXT NOT NULL,
  color TEXT,
  enabled INTEGER NOT NULL DEFAULT 1,
  last_sync TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS cal_events (
  id TEXT PRIMARY KEY,
  calendar_id TEXT NOT NULL REFERENCES calendars(id) ON DELETE CASCADE,
  uid TEXT,
  title TEXT NOT NULL,
  start TEXT NOT NULL,
  end TEXT,
  all_day INTEGER NOT NULL DEFAULT 0,
  location TEXT
);

CREATE INDEX IF NOT EXISTS idx_calevents_cal ON cal_events(calendar_id);
CREATE INDEX IF NOT EXISTS idx_calevents_start ON cal_events(start);

CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  ticket_id TEXT REFERENCES tickets(id),
  workspace_id TEXT REFERENCES workspaces(id) ON DELETE CASCADE,
  repo_id TEXT REFERENCES repos(id),
  title TEXT,
  backend TEXT NOT NULL DEFAULT 'claude-code',
  model TEXT,
  role TEXT NOT NULL DEFAULT 'human',
  cwd TEXT NOT NULL,
  pid INTEGER,
  status TEXT NOT NULL DEFAULT 'live',
  created_at TEXT NOT NULL,
  ended_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_sessions_ticket ON sessions(ticket_id);
CREATE INDEX IF NOT EXISTS idx_sessions_status ON sessions(status);

CREATE TABLE IF NOT EXISTS notes (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  slug TEXT NOT NULL,
  file_path TEXT NOT NULL,
  body TEXT NOT NULL DEFAULT '',
  pinned INTEGER NOT NULL DEFAULT 0,
  context INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_notes_ws ON notes(workspace_id);

CREATE TABLE IF NOT EXISTS skills (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  slug TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  category TEXT,
  tags TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  version INTEGER NOT NULL DEFAULT 1,
  usage_count INTEGER NOT NULL DEFAULT 0,
  last_used_at TEXT,
  file_path TEXT NOT NULL,
  source TEXT NOT NULL DEFAULT 'agent',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_skills_ws ON skills(workspace_id, status);
CREATE UNIQUE INDEX IF NOT EXISTS idx_skills_slug ON skills(workspace_id, slug);

CREATE VIRTUAL TABLE IF NOT EXISTS search_fts USING fts5(
  title, body,
  kind UNINDEXED, ref_id UNINDEXED, workspace UNINDEXED, ts UNINDEXED,
  tokenize = 'porter unicode61'
);

CREATE TABLE IF NOT EXISTS egress_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts TEXT NOT NULL,
  workspace_id TEXT,
  host TEXT NOT NULL,
  port INTEGER NOT NULL,
  action TEXT NOT NULL,
  ref TEXT
);
CREATE INDEX IF NOT EXISTS idx_egress_ws ON egress_log(workspace_id, id);

-- Durable decision/activity trail: one row per bus event (see activity.ts). Ephemeral bus events
-- (Telegram/websocket) don't persist otherwise; this is the queryable audit log for a 24/7 system.
CREATE TABLE IF NOT EXISTS activity (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts TEXT NOT NULL,
  topic TEXT NOT NULL,
  actor TEXT,
  workspace_id TEXT,
  entity TEXT,
  detail TEXT
);
CREATE INDEX IF NOT EXISTS idx_activity_ws ON activity(workspace_id, id);
CREATE INDEX IF NOT EXISTS idx_activity_topic ON activity(topic, id);

-- One row per connector sync (clickup/jira), success or error — a history of ingestion runs.
CREATE TABLE IF NOT EXISTS connector_syncs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts TEXT NOT NULL,
  workspace_id TEXT,
  connector TEXT,
  pulled INTEGER,
  created INTEGER,
  updated INTEGER,
  pushed INTEGER,
  error TEXT
);
CREATE INDEX IF NOT EXISTS idx_connsync_ws ON connector_syncs(workspace_id, id);

-- Shared manager chat thread (web + Telegram + heartbeat). One row per exchange (operator msg +
-- agent reply). The dashboard renders this as a long-lived WhatsApp-style thread; the agent's OWN
-- model context still lives in claude's --resume session (kv) per channel, so we never resend this
-- history to the model. source = web | telegram | heartbeat. Idle-gap dividers use created_at.
CREATE TABLE IF NOT EXISTS chat_messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  you TEXT NOT NULL,
  reply TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  source TEXT NOT NULL DEFAULT 'web'
);

-- Tiny generic key/value store (e.g. telegram per-chat state) so daemon restarts don't lose in-memory state.
CREATE TABLE IF NOT EXISTS kv (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- Directed ticket relationships. Store ONE direction; inverse is computed on read.
-- type: blocks | parent | relates | duplicates. relates is symmetric.
CREATE TABLE IF NOT EXISTS ticket_links (
  id TEXT PRIMARY KEY,
  from_id TEXT NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
  to_id TEXT NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
  type TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE(from_id, to_id, type)
);
CREATE INDEX IF NOT EXISTS idx_ticket_links_from ON ticket_links(from_id);
CREATE INDEX IF NOT EXISTS idx_ticket_links_to ON ticket_links(to_id);
`);
    },
  },
  { version: 2, name: "jobs.retry_max", up: (db) => db.exec("ALTER TABLE jobs ADD COLUMN retry_max INTEGER NOT NULL DEFAULT 0") },
  { version: 3, name: "jobs.retry_backoff_sec", up: (db) => db.exec("ALTER TABLE jobs ADD COLUMN retry_backoff_sec INTEGER NOT NULL DEFAULT 60") },
  { version: 4, name: "jobs.verify", up: (db) => db.exec("ALTER TABLE jobs ADD COLUMN verify INTEGER NOT NULL DEFAULT 0") },
  { version: 5, name: "jobs.sandbox", up: (db) => db.exec(`ALTER TABLE jobs ADD COLUMN sandbox TEXT NOT NULL DEFAULT '${CONFIG.sandbox.defaultMode}'`) },
  { version: 6, name: "jobs.on_success", up: (db) => db.exec("ALTER TABLE jobs ADD COLUMN on_success TEXT") },
  { version: 7, name: "jobs.on_failure", up: (db) => db.exec("ALTER TABLE jobs ADD COLUMN on_failure TEXT") },
  { version: 8, name: "runs.attempt", up: (db) => db.exec("ALTER TABLE runs ADD COLUMN attempt INTEGER NOT NULL DEFAULT 1") },
  { version: 9, name: "runs.verify_verdict", up: (db) => db.exec("ALTER TABLE runs ADD COLUMN verify_verdict TEXT") },
  { version: 10, name: "runs.resets_at", up: (db) => db.exec("ALTER TABLE runs ADD COLUMN resets_at TEXT") },
  { version: 11, name: "runs.context", up: (db) => db.exec("ALTER TABLE runs ADD COLUMN context TEXT") },
  { version: 12, name: "jobs.workspace_id", up: (db) => db.exec("ALTER TABLE jobs ADD COLUMN workspace_id TEXT") },
  { version: 13, name: "jobs.backend", up: (db) => db.exec("ALTER TABLE jobs ADD COLUMN backend TEXT NOT NULL DEFAULT 'claude-code'") },
  { version: 14, name: "jobs.ticket_id", up: (db) => db.exec("ALTER TABLE jobs ADD COLUMN ticket_id TEXT") },
  // v15 was "ALTER TABLE repos ADD COLUMN parent_id" — repos.parent_id already ships in the v1
  // baseline (a historical no-op kept for the record; do not reuse this version number).
  { version: 15, name: "repos.parent_id (no-op, column already in baseline)", up: () => {} },
  { version: 16, name: "calendars.source", up: (db) => db.exec("ALTER TABLE calendars ADD COLUMN source TEXT NOT NULL DEFAULT 'ics'") },
  { version: 17, name: "calendars.account", up: (db) => db.exec("ALTER TABLE calendars ADD COLUMN account TEXT") },
  { version: 18, name: "calendars.config_dir", up: (db) => db.exec("ALTER TABLE calendars ADD COLUMN config_dir TEXT") },
  { version: 19, name: "sessions.summary", up: (db) => db.exec("ALTER TABLE sessions ADD COLUMN summary TEXT") },
  { version: 20, name: "sessions.tags", up: (db) => db.exec("ALTER TABLE sessions ADD COLUMN tags TEXT") },
  { version: 21, name: "sessions.first_prompt", up: (db) => db.exec("ALTER TABLE sessions ADD COLUMN first_prompt TEXT") },
  // v22 was "ALTER TABLE notes ADD COLUMN context" — notes.context already ships in the v1 baseline.
  { version: 22, name: "notes.context (no-op, column already in baseline)", up: () => {} },
  { version: 23, name: "workspaces.auto_plan", up: (db) => db.exec("ALTER TABLE workspaces ADD COLUMN auto_plan INTEGER NOT NULL DEFAULT 0") },
  { version: 24, name: "workspaces.auto_build", up: (db) => db.exec("ALTER TABLE workspaces ADD COLUMN auto_build INTEGER NOT NULL DEFAULT 0") },
  { version: 25, name: "workspaces.auto_review", up: (db) => db.exec("ALTER TABLE workspaces ADD COLUMN auto_review INTEGER NOT NULL DEFAULT 0") },
  { version: 26, name: "workspaces.slack_config", up: (db) => db.exec("ALTER TABLE workspaces ADD COLUMN slack_config TEXT") },
  { version: 27, name: "workspaces.egress_config", up: (db) => db.exec("ALTER TABLE workspaces ADD COLUMN egress_config TEXT") },
  { version: 28, name: "workspaces.review_backend", up: (db) => db.exec("ALTER TABLE workspaces ADD COLUMN review_backend TEXT") },
  { version: 29, name: "workspaces.review_model", up: (db) => db.exec("ALTER TABLE workspaces ADD COLUMN review_model TEXT") },
  { version: 30, name: "workspaces.fallback_backend", up: (db) => db.exec("ALTER TABLE workspaces ADD COLUMN fallback_backend TEXT") },
  { version: 31, name: "workspaces.fallback_model", up: (db) => db.exec("ALTER TABLE workspaces ADD COLUMN fallback_model TEXT") },
  { version: 32, name: "workspaces.auto_skill", up: (db) => db.exec("ALTER TABLE workspaces ADD COLUMN auto_skill INTEGER NOT NULL DEFAULT 0") },
  { version: 33, name: "workspaces.skill_distill", up: (db) => db.exec("ALTER TABLE workspaces ADD COLUMN skill_distill INTEGER NOT NULL DEFAULT 0") },
  { version: 34, name: "workspaces.git_name", up: (db) => db.exec("ALTER TABLE workspaces ADD COLUMN git_name TEXT") },
  { version: 35, name: "workspaces.git_email", up: (db) => db.exec("ALTER TABLE workspaces ADD COLUMN git_email TEXT") },
  { version: 36, name: "workspaces.daily_budget_usd", up: (db) => db.exec("ALTER TABLE workspaces ADD COLUMN daily_budget_usd REAL") },
  { version: 37, name: "workspaces.max_concurrent", up: (db) => db.exec("ALTER TABLE workspaces ADD COLUMN max_concurrent INTEGER") },
  { version: 38, name: "jobs.notify", up: (db) => db.exec("ALTER TABLE jobs ADD COLUMN notify TEXT") },
  { version: 39, name: "reviews.actor", up: (db) => db.exec("ALTER TABLE reviews ADD COLUMN actor TEXT") },
  { version: 40, name: "repos.delivery", up: (db) => db.exec("ALTER TABLE repos ADD COLUMN delivery TEXT NOT NULL DEFAULT 'commit'") },
  { version: 41, name: "repos.done_criteria", up: (db) => db.exec("ALTER TABLE repos ADD COLUMN done_criteria TEXT") },
  { version: 42, name: "repos.verify_cmd", up: (db) => db.exec("ALTER TABLE repos ADD COLUMN verify_cmd TEXT") },
  { version: 43, name: "repos.require_human", up: (db) => db.exec("ALTER TABLE repos ADD COLUMN require_human INTEGER NOT NULL DEFAULT 1") },
  {
    version: 44,
    name: "ticket_attachments table",
    // Ticket screenshots / evidence files (index; bytes under ~/chronos/attachments/).
    up: (db) =>
      db.exec(`CREATE TABLE IF NOT EXISTS ticket_attachments (
        id TEXT PRIMARY KEY,
        ticket_id TEXT NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
        workspace_id TEXT NOT NULL,
        filename TEXT NOT NULL,
        stored_name TEXT NOT NULL,
        mime TEXT NOT NULL,
        size INTEGER NOT NULL,
        caption TEXT,
        source TEXT NOT NULL DEFAULT 'upload',
        created_at TEXT NOT NULL
      )`),
  },
  { version: 45, name: "idx_attach_ticket", up: (db) => db.exec("CREATE INDEX IF NOT EXISTS idx_attach_ticket ON ticket_attachments(ticket_id)") },
  { version: 46, name: "tickets.complexity", up: (db) => db.exec("ALTER TABLE tickets ADD COLUMN complexity TEXT") },
  { version: 47, name: "tickets.pr_url", up: (db) => db.exec("ALTER TABLE tickets ADD COLUMN pr_url TEXT") },
  { version: 48, name: "tickets.pr_state", up: (db) => db.exec("ALTER TABLE tickets ADD COLUMN pr_state TEXT") },
  { version: 49, name: "tickets.ci_state", up: (db) => db.exec("ALTER TABLE tickets ADD COLUMN ci_state TEXT") },
  { version: 50, name: "tickets.ci_checks", up: (db) => db.exec("ALTER TABLE tickets ADD COLUMN ci_checks TEXT") },
  {
    version: 51,
    name: "tickets.summary",
    // AI-generated one-sentence description, shown at the top of the ticket + terminal subtitles.
    up: (db) => db.exec("ALTER TABLE tickets ADD COLUMN summary TEXT"),
  },
  {
    version: 52,
    name: "notes.scope",
    // scope='global' notes are the operator profile — they cross client walls BY DESIGN (see notes.ts).
    up: (db) => db.exec("ALTER TABLE notes ADD COLUMN scope TEXT NOT NULL DEFAULT 'workspace'"),
  },
  // v53 was "ALTER TABLE chat_messages ADD COLUMN source" — already ships in the v1 baseline.
  { version: 53, name: "chat_messages.source (no-op, column already in baseline)", up: () => {} },
  {
    version: 54,
    name: "repos.post_merge_cmd",
    // Per-repo command run in repo root after a ticket's PR merges to main (e.g. "npm run build").
    up: (db) => db.exec("ALTER TABLE repos ADD COLUMN post_merge_cmd TEXT"),
  },
  {
    version: 55,
    name: "ideas table",
    // Idea Pool — staging cards before promote→ticket / kill. Soft lifecycle only.
    up: (db) =>
      db.exec(`CREATE TABLE IF NOT EXISTS ideas (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL,
        repo_id TEXT,
        title TEXT NOT NULL,
        pitch TEXT NOT NULL,
        kind TEXT NOT NULL,
        source TEXT NOT NULL,
        source_ref TEXT,
        status TEXT NOT NULL DEFAULT 'proposed',
        model TEXT,
        promoted_ticket_id TEXT,
        created_at TEXT NOT NULL,
        decided_at TEXT
      )`),
  },
  { version: 56, name: "idx_ideas_ws_status", up: (db) => db.exec("CREATE INDEX IF NOT EXISTS idx_ideas_ws_status ON ideas(workspace_id, status)") },
  { version: 57, name: "workspaces.ideas_config", up: (db) => db.exec("ALTER TABLE workspaces ADD COLUMN ideas_config TEXT") },
  {
    version: 58,
    name: "repos.ideas_enabled",
    // Per-repo opt-out of idea feeders (workspace ideas_config still gates; default ON).
    up: (db) => db.exec("ALTER TABLE repos ADD COLUMN ideas_enabled INTEGER NOT NULL DEFAULT 1"),
  },
  {
    version: 59,
    name: "workspaces.route_config",
    // Per-workspace difficulty(1-5) → agent routing (JSON {"1":"backend:model",...}).
    up: (db) => db.exec("ALTER TABLE workspaces ADD COLUMN route_config TEXT"),
  },
  {
    version: 60,
    name: "workspaces.auto_grade",
    // Toggle the k3 second-pass difficulty grader after every plan (default ON).
    up: (db) => db.exec("ALTER TABLE workspaces ADD COLUMN auto_grade INTEGER NOT NULL DEFAULT 1"),
  },
  {
    version: 61,
    name: "runs/jobs lookup indexes",
    // runs.started_at / runs.status and jobs.ticket_id / jobs.workspace_id are filtered or joined on
    // in runs.ts + tickets.ts cost/digest/fleet queries (spentSince, dailyCosts, runningCount,
    // costMap, ...) with no covering index — every call was a full table scan on two tables that
    // only grow. Additive-only; safe to add without a backfill.
    up: (db) =>
      db.exec(`
        CREATE INDEX IF NOT EXISTS idx_runs_started ON runs(started_at);
        CREATE INDEX IF NOT EXISTS idx_runs_status ON runs(status);
        CREATE INDEX IF NOT EXISTS idx_jobs_ticket ON jobs(ticket_id);
        CREATE INDEX IF NOT EXISTS idx_jobs_workspace ON jobs(workspace_id);
      `),
  },
  {
    version: 62,
    name: "workspaces.token",
    // Per-workspace API token (PER-24) — the trust boundary for cross-tenant authz. Sandboxed
    // jobs get their own workspace's token injected into their env; the API rejects any request
    // whose token doesn't own the resource's workspace_id (see checkScope in api.ts).
    up: (db) => {
      db.exec("ALTER TABLE workspaces ADD COLUMN token TEXT");
      const rows = db.prepare("SELECT id FROM workspaces WHERE token IS NULL").all() as { id: string }[];
      const set = db.prepare("UPDATE workspaces SET token = ? WHERE id = ?");
      for (const r of rows) set.run(randomBytes(24).toString("hex"), r.id);
      db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_workspaces_token ON workspaces(token)");
    },
  },
  {
    version: 63,
    name: "notes.repo_ids",
    // Repo-scoping for context (★) memos: JSON array of repo ids this note applies to. NULL/empty =
    // workspace-wide (unchanged behavior). When set, contextBlock() injects the note ONLY into agents
    // whose repo is in the list — so a design doc can be the northstar for inventory-docs +
    // warehouse-dbt-migrations without loading into every other repo's agents.
    up: (db) => db.exec("ALTER TABLE notes ADD COLUMN repo_ids TEXT"),
  },
  {
    version: 64,
    name: "sessions/reviews.ticket_id ON DELETE SET NULL",
    // sessions.ticket_id and reviews.ticket_id were plain `REFERENCES tickets(id)` (default NO
    // ACTION) while foreign_keys=ON is enforced globally (db.ts:35) — deleting any ticket that had a
    // live session or review row threw SQLITE_CONSTRAINT (PER-42). SQLite can't ALTER a column's ON
    // DELETE action, so rebuild both tables with ON DELETE SET NULL: sessions/reviews are historical
    // records that should survive their ticket's deletion (just lose the now-dangling reference),
    // unlike reviews.run_id which cascades because a review can't stand without its run. Neither
    // table is referenced by any other table's FK, so the rebuild has no downstream entanglement.
    up: (db) => {
      db.exec(`
        CREATE TABLE sessions_new (
          id TEXT PRIMARY KEY,
          ticket_id TEXT REFERENCES tickets(id) ON DELETE SET NULL,
          workspace_id TEXT REFERENCES workspaces(id) ON DELETE CASCADE,
          repo_id TEXT REFERENCES repos(id),
          title TEXT,
          backend TEXT NOT NULL DEFAULT 'claude-code',
          model TEXT,
          role TEXT NOT NULL DEFAULT 'human',
          cwd TEXT NOT NULL,
          pid INTEGER,
          status TEXT NOT NULL DEFAULT 'live',
          created_at TEXT NOT NULL,
          ended_at TEXT,
          summary TEXT,
          tags TEXT,
          first_prompt TEXT
        );
        INSERT INTO sessions_new SELECT id,ticket_id,workspace_id,repo_id,title,backend,model,role,cwd,pid,status,created_at,ended_at,summary,tags,first_prompt FROM sessions;
        DROP TABLE sessions;
        ALTER TABLE sessions_new RENAME TO sessions;
        CREATE INDEX IF NOT EXISTS idx_sessions_ticket ON sessions(ticket_id);
        CREATE INDEX IF NOT EXISTS idx_sessions_status ON sessions(status);

        CREATE TABLE reviews_new (
          id TEXT PRIMARY KEY,
          run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
          ticket_id TEXT REFERENCES tickets(id) ON DELETE SET NULL,
          state TEXT NOT NULL DEFAULT 'pending',
          diff_ref TEXT,
          notes TEXT,
          created_at TEXT NOT NULL,
          reviewed_at TEXT,
          actor TEXT
        );
        INSERT INTO reviews_new SELECT id,run_id,ticket_id,state,diff_ref,notes,created_at,reviewed_at,actor FROM reviews;
        DROP TABLE reviews;
        ALTER TABLE reviews_new RENAME TO reviews;
        CREATE INDEX IF NOT EXISTS idx_reviews_state ON reviews(state);
      `);
    },
  },
  {
    version: 65,
    name: "tickets.report",
    // Build agent's structured handoff (markdown): what changed, why, files, testing, risks,
    // follow-ups. Written at finish via `mc review --report`. Rendered in the review card and
    // reused as the PR body at merge time. DB-only (not serialized to the ticket .md frontmatter).
    up: (db) => db.exec("ALTER TABLE tickets ADD COLUMN report TEXT"),
  },
  {
    // 66 is a permanent hole: it was reserved for the jobs.ticket_id FK rebuild (PER-44), but by the time
    // that landed, deployed DBs were already past it and the runner skips `version <= user_version` —
    // so it shipped as 69 instead. Never reserve a number for an unlanded migration.
    version: 67,
    name: "chat_messages.workspace_id — per-workspace manager threads",
    // Flow's workspace selection now picks BOTH the Claude profile and the conversation: each workspace
    // gets its own thread instead of one shared log. NULL = the unscoped thread (Telegram, briefings, and
    // "all workspaces" in Flow). ON DELETE CASCADE — a deleted workspace's conversation goes with it
    // rather than silently reappearing in the unscoped thread.
    up: (db) => {
      db.exec(
        "ALTER TABLE chat_messages ADD COLUMN workspace_id TEXT REFERENCES workspaces(id) ON DELETE CASCADE",
      );
      db.exec("CREATE INDEX IF NOT EXISTS idx_chat_workspace ON chat_messages(workspace_id, id)");
    },
  },
  {
    version: 68,
    name: "repos.delivery default 'pr' — backfill existing repos",
    // PR delivery is now the default: work ships as a reviewable GitHub PR instead of a commit
    // straight onto the shared checkout's default branch. Backfill every existing repo so the
    // backlog behaves consistently. Repos with no git remote are flipped back by hand (a `pr`
    // merge needs somewhere to push); isolation no longer depends on this column either way.
    up: (db) => {
      db.exec("UPDATE repos SET delivery = 'pr' WHERE delivery = 'commit'");
    },
  },
  {
    version: 69,
    name: "jobs.ticket_id real FK, ON DELETE SET NULL",
    // jobs.ticket_id (v14) was added via bare ALTER TABLE ADD COLUMN — not a REFERENCES at
    // all, so deleting a ticket with scheduled/historical jobs silently orphans them instead
    // of either blocking or nulling out (PER-44). Rebuild jobs with a real FK, ON DELETE SET
    // NULL (jobs are historical/schedule records that should survive their ticket's deletion,
    // same treatment as sessions/reviews). jobs IS referenced by runs.job_id and
    // triggers.job_id (both ON DELETE CASCADE) — SQLite converts DROP TABLE on a table with
    // FK-enforcing children into an implicit delete-cascade when foreign_keys=ON, which would
    // wipe every run and trigger. Must run with foreign_keys off for the DROP, hence manualTx.
    manualTx: true,
    up: (db) => {
      db.pragma("foreign_keys = OFF");
      db.exec(`
        BEGIN;
        CREATE TABLE jobs_new (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          description TEXT,
          goal TEXT NOT NULL,
          append_system TEXT,
          profile TEXT NOT NULL DEFAULT 'claude',
          cwd TEXT NOT NULL,
          add_dirs TEXT,
          model TEXT,
          allowed_tools TEXT,
          disallowed_tools TEXT,
          trigger_type TEXT NOT NULL DEFAULT 'manual',
          cron_expr TEXT,
          timezone TEXT NOT NULL DEFAULT 'UTC',
          max_budget_usd REAL,
          timeout_sec INTEGER NOT NULL DEFAULT 3600,
          enabled INTEGER NOT NULL DEFAULT 1,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          retry_max INTEGER NOT NULL DEFAULT 0,
          retry_backoff_sec INTEGER NOT NULL DEFAULT 60,
          verify INTEGER NOT NULL DEFAULT 0,
          sandbox TEXT NOT NULL DEFAULT '${CONFIG.sandbox.defaultMode}',
          on_success TEXT,
          on_failure TEXT,
          workspace_id TEXT,
          backend TEXT NOT NULL DEFAULT 'claude-code',
          ticket_id TEXT REFERENCES tickets(id) ON DELETE SET NULL,
          notify TEXT
        );
        INSERT INTO jobs_new SELECT id,name,description,goal,append_system,profile,cwd,add_dirs,model,allowed_tools,disallowed_tools,trigger_type,cron_expr,timezone,max_budget_usd,timeout_sec,enabled,created_at,updated_at,retry_max,retry_backoff_sec,verify,sandbox,on_success,on_failure,workspace_id,backend,ticket_id,notify FROM jobs;
        -- Jobs whose ticket was deleted while no FK existed are exactly the bug this migration
        -- closes, and they are already present in deployed data. Null them: that is what
        -- ON DELETE SET NULL would have done at deletion time. Without this the foreign_key_check
        -- below throws AFTER the rebuild has committed, leaving user_version behind the schema and
        -- the daemon crash-looping on every start.
        UPDATE jobs_new SET ticket_id = NULL
          WHERE ticket_id IS NOT NULL AND ticket_id NOT IN (SELECT id FROM tickets);
        DROP TABLE jobs;
        ALTER TABLE jobs_new RENAME TO jobs;
        CREATE INDEX IF NOT EXISTS idx_jobs_ticket ON jobs(ticket_id);
        CREATE INDEX IF NOT EXISTS idx_jobs_workspace ON jobs(workspace_id);
        COMMIT;
      `);
      db.pragma("foreign_keys = ON");
      const violations = db.pragma("foreign_key_check(jobs)") as unknown[];
      if (violations.length) {
        throw new Error(`jobs FK rebuild left violations: ${JSON.stringify(violations)}`);
      }
    },
  },
  {
    version: 70,
    name: "repos.gate_cmds / risk_paths / human_gate — evidence gate + risk tiers",
    // require_human was a boolean: humans approve everything, or nothing. human_gate is the same
    // switch with the two useful middle positions, so a repo can hand over its routine lane and
    // still stop at the changes that would hurt. Backfilled exactly, then the boolean is dropped —
    // two sources of truth for "does this need the operator" is how a gate quietly stops applying.
    up: (db) => {
      db.exec("ALTER TABLE repos ADD COLUMN gate_cmds TEXT");
      db.exec("ALTER TABLE repos ADD COLUMN risk_paths TEXT");
      db.exec("ALTER TABLE repos ADD COLUMN human_gate TEXT NOT NULL DEFAULT 'always'");
      db.exec("UPDATE repos SET human_gate = CASE WHEN require_human = 0 THEN 'never' ELSE 'always' END");
      db.exec("ALTER TABLE repos DROP COLUMN require_human");
    },
  },
  {
    version: 71,
    name: "reviews.gate_json / reviews.risk",
    up: (db) => {
      db.exec("ALTER TABLE reviews ADD COLUMN gate_json TEXT");
      db.exec("ALTER TABLE reviews ADD COLUMN risk TEXT");
    },
  },
  {
    version: 72,
    name: "lessons table — feedback distilled into durable rules",
    up: (db) =>
      db.exec(`CREATE TABLE IF NOT EXISTS lessons (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL,
        repo_id TEXT REFERENCES repos(id) ON DELETE CASCADE,
        scope TEXT,
        topic TEXT NOT NULL DEFAULT 'build',
        rule TEXT NOT NULL,
        source TEXT NOT NULL DEFAULT 'operator',
        source_ref TEXT,
        hits INTEGER NOT NULL DEFAULT 0,
        seen INTEGER NOT NULL DEFAULT 1,
        last_fired TEXT,
        state TEXT NOT NULL DEFAULT 'active',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_lessons_ws ON lessons(workspace_id, state);
      CREATE INDEX IF NOT EXISTS idx_lessons_repo ON lessons(repo_id);`),
  },
  {
    version: 73,
    name: "ideas.acceptance — drafts carry their own spec",
    up: (db) => db.exec("ALTER TABLE ideas ADD COLUMN acceptance TEXT"),
  },
  {
    version: 74,
    name: "panels — reviews.panel_json + per-workspace plan_panel/review_panel",
    up: (db) => {
      db.exec("ALTER TABLE reviews ADD COLUMN panel_json TEXT");
      db.exec("ALTER TABLE workspaces ADD COLUMN plan_panel INTEGER NOT NULL DEFAULT 0");
      db.exec("ALTER TABLE workspaces ADD COLUMN review_panel INTEGER NOT NULL DEFAULT 0");
    },
  },
  {
    version: 75,
    name: "sessions.agent_name — unique live handle for attach/wait",
    // Herdr-style named occupants: Robert/Buzz address terminals by name (`builder`, `reviewer`)
    // instead of opaque UUID prefixes. Cleared when the session ends so names recycle.
    up: (db) => {
      db.exec("ALTER TABLE sessions ADD COLUMN agent_name TEXT");
      db.exec(
        "CREATE UNIQUE INDEX IF NOT EXISTS idx_sessions_agent_name_live ON sessions(agent_name) WHERE agent_name IS NOT NULL AND status = 'live'"
      );
    },
  },
  {
    version: 76,
    name: "tickets.buzz_event_id / buzz_channel_id — one Buzz thread per ticket",
    // Lifecycle posts used to land flat in the channel, so a ticket's plan, runs, review and merge
    // were scattered across an unreadable timeline. Now the first post for a ticket becomes a thread
    // anchor and every later event replies into it. The channel is one message per ticket; the
    // ticket's whole life is inside its thread. Channel is stored alongside the event because a
    // reply tag only groups correctly in the channel that holds the anchor.
    up: (db) => {
      db.exec("ALTER TABLE tickets ADD COLUMN buzz_event_id TEXT");
      db.exec("ALTER TABLE tickets ADD COLUMN buzz_channel_id TEXT");
    },
  },
  {
    version: 77,
    name: "deleted_externals table — tombstone connector-linked tickets deleted locally",
    // A local delete of a ClickUp/Jira-linked ticket used to leave no trace: the next sync saw the
    // external task still open and re-created it under a fresh key (PER-70). This is the tombstone
    // syncWorkspace consults before mirroring a "new" external task in — a human delete stays deleted.
    up: (db) =>
      db.exec(`CREATE TABLE IF NOT EXISTS deleted_externals (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL,
        connector TEXT NOT NULL,
        external_id TEXT NOT NULL,
        deleted_at TEXT NOT NULL,
        UNIQUE(workspace_id, connector, external_id)
      )`),
  },
  {
    version: 78,
    name: "run_steps table — structured worker progress checklist",
    // A running worker used to be a black box between run.started and run.ended. This lets a worker
    // declare a step checklist and mark it active/done/skipped as it works, so the fleet view can show
    // "2/4 · fix root cause" instead of a bare spinner. See `mc steps` (scripts/mc) and occupantFromRun.
    up: (db) =>
      db.exec(`CREATE TABLE IF NOT EXISTS run_steps (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        run_id TEXT NOT NULL,
        idx INTEGER NOT NULL,
        label TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'todo',
        note TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(run_id, idx)
      );
      CREATE INDEX IF NOT EXISTS idx_run_steps_run ON run_steps(run_id);`),
  },
  {
    version: 79,
    name: "asks table — worker HITL questions (mc ask) with park & resume",
    // A worker that hits an ambiguous/destructive decision used to guess or die. Now it files an ask,
    // parks its run, and the operator's answer (Telegram button / `mc answer` / API) re-dispatches the
    // same job with the answer as context. Living in SQLite (not memory) is what makes park & resume
    // restart-proof: a daemon deploy between the ask and the answer loses nothing.
    up: (db) =>
      db.exec(`CREATE TABLE IF NOT EXISTS asks (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL,
        job_id TEXT NOT NULL,
        ticket_id TEXT,
        workspace_id TEXT,
        question TEXT NOT NULL,
        options TEXT,
        answer TEXT,
        answered_by TEXT,
        status TEXT NOT NULL DEFAULT 'open',
        created_at TEXT NOT NULL,
        answered_at TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_asks_run ON asks(run_id);
      CREATE INDEX IF NOT EXISTS idx_asks_status ON asks(status);`),
  },
  {
    version: 80,
    name: "runs.resume_session — the prior session a re-dispatch continues after an answered ask",
    // Set on the RESUME run (not the asking run): the old run's session_id, so execute() can pass it
    // to backend.buildArgs as --resume and thread the same conversation through instead of starting fresh.
    up: (db) => db.exec("ALTER TABLE runs ADD COLUMN resume_session TEXT"),
  },
  {
    version: 81,
    name: "run_messages table — operator→worker mailbox (mc tell) with piggyback delivery",
    // No dedicated polling loop: a worker already checkpoints via `mc step`/`mc note`, so those API
    // responses carry any undelivered messages instead. Ticket-scoped (not just run-scoped) so a
    // message survives park & resume and retries — any current or future run on the ticket picks it
    // up. See src/messages.ts.
    up: (db) =>
      db.exec(`CREATE TABLE IF NOT EXISTS run_messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ticket_id TEXT,
        run_id TEXT,
        workspace_id TEXT,
        text TEXT NOT NULL,
        from_who TEXT NOT NULL,
        created_at TEXT NOT NULL,
        delivered_at TEXT,
        delivered_to_run TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_run_messages_ticket ON run_messages(ticket_id);
      CREATE INDEX IF NOT EXISTS idx_run_messages_run ON run_messages(run_id);`),
  },
  {
    version: 82,
    name: "workspaces.stall_minutes/ask_remind_hours/ask_policy — per-ws ops overrides",
    // null on all three = inherit the global CONFIG default (or "robert", for ask_policy);
    // stall_minutes/ask_remind_hours: 0 = off for this workspace. See monitor.ts/asks.ts.
    up: (db) => db.exec(`
      ALTER TABLE workspaces ADD COLUMN stall_minutes INTEGER;
      ALTER TABLE workspaces ADD COLUMN ask_remind_hours INTEGER;
      ALTER TABLE workspaces ADD COLUMN ask_policy TEXT;`),
  },
  {
    version: 83,
    name: "workspaces.merge_gate — agent reviews the open PR and merges it when clean",
    // 0 = the operator merges (the behaviour every workspace had until now). See merge-gate.ts.
    up: (db) => db.exec("ALTER TABLE workspaces ADD COLUMN merge_gate INTEGER NOT NULL DEFAULT 0"),
  },
  {
    version: 84,
    name: "workspaces.verify_mode — shadow/enforce/strict verifier policy (null = daemon default)",
    up: (db) => db.exec("ALTER TABLE workspaces ADD COLUMN verify_mode TEXT"),
  },
  {
    version: 85,
    name: "workspaces.live_steer — operator messages injected into LIVE runs over streaming stdin",
    // 0 = mailbox-only delivery at checkpoints (the behaviour every workspace had until now).
    up: (db) => db.exec("ALTER TABLE workspaces ADD COLUMN live_steer INTEGER NOT NULL DEFAULT 0"),
  },
  {
    // 86 because live_steer took 85 on main: concurrent PRs both claimed the next number, and the
    // one that merged second renumbers here — ascending, no reserved gap. See migration 67's note.
    version: 86,
    name: "runs.cache_read/cache_write — prompt-cache token totals for cache-health telemetry",
    up: (db) =>
      db.exec(`ALTER TABLE runs ADD COLUMN cache_read INTEGER;
      ALTER TABLE runs ADD COLUMN cache_write INTEGER;`),
  },
  {
    version: 87,
    name: "review_min_difficulty — per-ws/repo floor below which the AI reviewer is skipped (0 reviewers)",
    // Cost lever: tickets graded easier than this go straight to the approve lane with no AI
    // reviewer spent (repo.human_gate still decides ship vs. wait-for-human). NULL/0 = review all;
    // a repo's value overrides its workspace's.
    up: (db) =>
      db.exec(`ALTER TABLE workspaces ADD COLUMN review_min_difficulty INTEGER;
      ALTER TABLE repos ADD COLUMN review_min_difficulty INTEGER;`),
  },
  {
    version: 88,
    name: "tickets.status_source — mirror vs local-owned status tracking",
    // Pull-only connectors (acme→ClickUp, globex→Jira, sync every 30m) mirror upstream status
    // into tickets Chronos never actually works — dozens of 'in_progress' rows that are just tracker
    // state, polluting Buzz boards, the recovery stall sweep, autoplan's build-concurrency count, and
    // the daily digest with "work" nobody is doing. status_source distinguishes a tracker-mirrored
    // status from one Chronos itself set (LOCAL_OWNED in connectors/index.ts is untouched — this is
    // additive bookkeeping, not a new protection).
    //
    // Backfill: a ticket imported from a tracker (external_id set) that no job has ever touched
    // (jobs.ticket_id) is exactly a pure mirror — nothing at Chronos ever dispatched on it, so its
    // status can only have come from the tracker. Everything else — native tickets, or an external
    // ticket Chronos has actually worked — is 'local'.
    //
    // Choke point: updateTicket() (src/tickets.ts) defaults status_source to 'local' whenever `status`
    // is part of the patch and the caller didn't say otherwise. Only connectors/index.ts's syncWorkspace
    // passes 'external' explicitly, so a future call site can't silently mis-tag a real local
    // transition — and dispatching real work on a mirror flips it back to 'local' automatically, since
    // dispatch always patches `status` through the same choke point.
    up: (db) => {
      db.exec("ALTER TABLE tickets ADD COLUMN status_source TEXT NOT NULL DEFAULT 'local'");
      db.exec(`
        UPDATE tickets SET status_source = 'external'
        WHERE external_id IS NOT NULL
          AND id NOT IN (SELECT DISTINCT ticket_id FROM jobs WHERE ticket_id IS NOT NULL)
      `);
    },
  },
  {
    version: 89,
    name: "tickets.complexity_source — human-set difficulty is authoritative, nobody may overwrite it",
    // `complexity` (the 1-5 plan-graded difficulty driving build-agent routing + review_min_difficulty)
    // is written by three different actors: the operator/Robert (via the generic PATCH — mc ticket
    // new/update --difficulty), the scout's plan (setPlan), and the second-pass k3 grader (gradeTicket /
    // `mc grade`, kicked off by maybeGrade in src/autoplan.ts after every plan when ws.auto_grade is on).
    // Without bookkeeping, the grader runs unconditionally after the plan and can clobber a difficulty
    // The operator assigned by hand at ticket-creation time. complexity_source distinguishes 'human' (authoritative
    // — see maybeGrade's guard and gradeTicket's refusal to write over it) from 'scout'/'grader' (which
    // keep re-grading normally, matching the existing second-pass flow).
    //
    // Nullable, no backfill: unlike status_source (where the mirror/local distinction could be inferred
    // from existing external_id/jobs data), there's no way to know in hindsight who set an existing
    // row's complexity — null just means "legacy/unknown", and is treated the same as 'scout'/'grader'
    // everywhere (i.e. NOT authoritative) since only 'human' ever blocks anything.
    //
    // Choke point: updateTicket() (src/tickets.ts) defaults complexity_source to 'human' whenever
    // `complexity` is part of the patch and the caller didn't say otherwise — the generic PATCH is the
    // operator's (and Robert's) only path. setPlan and gradeTicket bypass updateTicket and stamp 'scout'
    // / 'grader' directly.
    up: (db) => db.exec("ALTER TABLE tickets ADD COLUMN complexity_source TEXT"),
  },
  {
    version: 90,
    name: "tickets.external_status — the tracker's own label, so divergence from local status is visible",
    // status_source (v88) records *provenance* — who last wrote `status`. It says nothing about
    // *agreement*: a ticket Chronos closed locally (status_source 'local') while ClickUp still shows
    // it "in progress" looks identical to one both sides agree on. ACM-3 sat like that for days and
    // kept getting reported as an open P1. syncWorkspace already pulls ExternalTask.statusRaw every
    // 30m and threw it away into the `## External` markdown prose; this column keeps it as data so
    // isStatusDivergent() (src/connectors/types.ts) can derive the mismatch at read time, against the
    // *current* local status rather than a flag that goes stale between syncs.
    //
    // Nullable, no backfill: the tracker's label for existing rows isn't recoverable from anything we
    // store (the `## External` prose is guarded text, not a field). NULL means "no pull has told us
    // yet" and never counts as divergent — the next sync fills it in for every mirrored ticket.
    // Freshness is the workspace's last connector sync (GET /workspaces → last_sync); deliberately no
    // per-ticket "observed at" column, since writing one every sync would bump updated_at on every
    // mirrored ticket and reshuffle every board that orders by it.
    up: (db) => db.exec("ALTER TABLE tickets ADD COLUMN external_status TEXT"),
  },
  {
    version: 91,
    name: "workspaces.capabilities — what the environment can actually reach, so a worker learns it before step 3",
    // 3 of the 12 asks in Chronos' history are a worker hitting a wall nothing had declared:
    // CED-99 ("Cursor sandbox cannot read ~/.config/gcloud") got to step 3 of 6 first, and ACM-106
    // ("no VPN, no REDSHIFT_*/SNOWFLAKE_*") hit the identical wall ACM-105 had already hit — the
    // knowledge existed in the system and never reached the next worker.
    //
    // JSON array of {name, available, note}. Only the UNAVAILABLE entries are injected into goals:
    // listing what works is noise in a prompt, while listing what does not is the thing that stops a
    // run from being spent reaching a wall. NULL/absent means "nothing declared" and injects nothing,
    // so every existing workspace keeps today's prompts byte-for-byte.
    up: (db) => db.exec("ALTER TABLE workspaces ADD COLUMN capabilities TEXT"),
  },
  {
    // 92 because capabilities took 91 on main — concurrent PRs both claimed the next number, and
    // the one that merged second renumbers here. Same story as migrations 86 and 67.
    version: 92,
    name: "board_posts table — one public agent board (threads + mentions), the Buzz-channel replacement",
    // Cross-ticket coordination used to live in Buzz channels: a hosted Nostr relay, 15 identity
    // keypairs, a presence launchd job, and a hand-maintained forum list — heavy plumbing for what
    // is, functionally, a small shared feed. This is the in-house replacement: ONE public board,
    // no DMs, no channels. thread_root_id NULL = root post; replies point at their root (flat
    // two-level threads — a reply to a reply is flattened to the root by the store, so a thread
    // can never nest into an unreadable tree). `mentions` is the JSON list of @handles parsed at
    // write time: the wake watcher (src/board.ts) subscribes to board.posted and wakes mentioned
    // executives — replacing buzz-inbound's 2s poller and the LLM router in one move, and closing
    // the exec↔exec peer-wake gap that was Buzz's last real job. ticket_id is an optional
    // cross-link so a thread that turns out to be about a ticket appears on that ticket's page.
    up: (db) =>
      db.exec(`CREATE TABLE IF NOT EXISTS board_posts (
        id TEXT PRIMARY KEY,
        thread_root_id TEXT,
        author TEXT NOT NULL,
        kind TEXT NOT NULL DEFAULT 'post',
        body TEXT NOT NULL,
        mentions TEXT,
        ticket_id TEXT,
        workspace_id TEXT,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_board_posts_thread ON board_posts(thread_root_id);
      CREATE INDEX IF NOT EXISTS idx_board_posts_created ON board_posts(created_at);
      CREATE INDEX IF NOT EXISTS idx_board_posts_ticket ON board_posts(ticket_id);`),
  },
  {
    version: 93,
    name: "agent_chat table — per-executive chat display history (exec threads are not workspaces)",
    // POST /agent/exec/:id first shipped storing exec threads in chat_messages under a synthetic
    // workspace_id ("agent:ada") — but chat_messages.workspace_id is a real FK to workspaces
    // (migration 63), so the insert died with SQLITE_CONSTRAINT_FOREIGNKEY *after* the executive
    // had already answered: the reply was produced, never stored, and the HTTP response never sent
    // (the catch path re-ran the same failing insert), leaving the UI on "thinking…" forever.
    // Executive threads get their own table instead of loosening that FK — the cascade on
    // workspace deletion is behavior the per-workspace manager threads rely on.
    up: (db) =>
      db.exec(`CREATE TABLE IF NOT EXISTS agent_chat (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        agent TEXT NOT NULL,
        you TEXT NOT NULL,
        reply TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL,
        source TEXT NOT NULL DEFAULT 'web'
      );
      CREATE INDEX IF NOT EXISTS idx_agent_chat ON agent_chat(agent, id);`),
  },
  {
    version: 94,
    name: "sessions.goal — operator-set objective for a terminal (Desk wall)",
    // The Desk wall is terminal-first, not ticket-first: every terminal carries a plain-English goal
    // ("open the flyway rollback PR", "write the migration memo") that the operator sets at spawn and
    // the agent can refine via `mc goal set`. Distinct from `title` (AI-generated from the first
    // prompt) — a goal is a commitment with a done state, a title is a label.
    up: (db) =>
      db.exec(`
        ALTER TABLE sessions ADD COLUMN goal TEXT;
        ALTER TABLE sessions ADD COLUMN goal_done_at TEXT;
      `),
  },
  {
    version: 95,
    name: "sessions.goal_kind / goal_source — what shape of work a terminal is, and who last named it",
    // `goal_kind` (pr | investigation | qa) is the operator's answer to "what does done look like
    // here", picked at spawn and shown as a chip on the card. `goal_source` is who last wrote the
    // goal, and it is what makes the title safe to refine automatically: a goal still marked 'seed'
    // (typed into the spawn dialog) or 'auto' (derived from the agent's own Understanding) may be
    // rewritten as the agent learns what the work really is; one marked 'human' (edited in place on
    // the card) or 'agent' (`mc goal set`) is never overwritten by the deriver.
    up: (db) =>
      db.exec(`
        ALTER TABLE sessions ADD COLUMN goal_kind TEXT;
        ALTER TABLE sessions ADD COLUMN goal_source TEXT;
      `),
  },
  {
    version: 96,
    name: "sessions: the day's ledger — who opened it, what it was called first, what it cost",
    // One row per terminal worked on, answerable months later: who opened it and why, what it was
    // called before the agent knew better, what it spent, what it left behind. Deliberately columns
    // on `sessions` rather than a second table: a parallel log drifts from the thing it describes,
    // and every field here is either already known at spawn or snapshotted from the CLI's own
    // transcript when the pty dies (see snapshotUsage in terminal.ts).
    up: (db) =>
      db.exec(`
        ALTER TABLE sessions ADD COLUMN created_by TEXT;      -- operator | robert | agent:<name> | ticket | cron
        ALTER TABLE sessions ADD COLUMN spawn_goal TEXT;      -- the title as TYPED, before the agent sharpened it
        ALTER TABLE sessions ADD COLUMN turns INTEGER;
        ALTER TABLE sessions ADD COLUMN tokens_in INTEGER;
        ALTER TABLE sessions ADD COLUMN tokens_out INTEGER;
        ALTER TABLE sessions ADD COLUMN cost_usd REAL;
        ALTER TABLE sessions ADD COLUMN context_peak INTEGER; -- fullest the window ever got
        ALTER TABLE sessions ADD COLUMN lines_added INTEGER;
        ALTER TABLE sessions ADD COLUMN lines_removed INTEGER;
        ALTER TABLE sessions ADD COLUMN model_ms INTEGER;     -- time the model was actually thinking
        ALTER TABLE sessions ADD COLUMN branch TEXT;          -- git branch the work landed on
        ALTER TABLE sessions ADD COLUMN blocked_count INTEGER; -- times it had to stop and ask you
      `),
  },
  {
    version: 97,
    name: "sessions.watch_* — Robert re-reads one terminal on a clock and reports on Telegram",
    // A watch is 1:1 with a terminal and dies with it, so it lives on the row rather than in a
    // parallel table (same call as migration 96). `watch_last_at` is the only moving part: the
    // sweeper fires when now - watch_last_at >= watch_every_min, so a daemon restart resumes the
    // cadence instead of firing every watch at once on boot.
    up: (db) =>
      db.exec(`
        ALTER TABLE sessions ADD COLUMN watch_every_min INTEGER;  -- null = unwatched
        ALTER TABLE sessions ADD COLUMN watch_note TEXT;          -- what the operator asked to be watched FOR
        ALTER TABLE sessions ADD COLUMN watch_by TEXT;            -- operator | robert | agent:<name>
        ALTER TABLE sessions ADD COLUMN watch_started_at TEXT;
        ALTER TABLE sessions ADD COLUMN watch_last_at TEXT;       -- last report sent
      `),
  },
  {
    version: 98,
    name: "asks: a terminal can ask too, and Robert gets first refusal",
    // `mc ask` only ever worked inside a dispatched run, because run_id/job_id were NOT NULL — an
    // agent in a Desk terminal (which has a session, not a run) had no way to ask anything at all.
    // SQLite can't relax NOT NULL in place, so rebuild: run_id/job_id become nullable and
    // `session_id` joins them. Exactly one of run_id / session_id is set on any row.
    //
    // `route` is who gets it FIRST: 'operator' is the old behavior (card straight to the operator's phone),
    // 'robert' hands it to the overseer, who either answers it or escalates. `triage` keeps what he
    // decided and why, so an answered ask can still say who really decided it.
    up: (db) => {
      db.exec(`
        CREATE TABLE asks_new (
          id TEXT PRIMARY KEY,
          run_id TEXT,
          job_id TEXT,
          session_id TEXT REFERENCES sessions(id) ON DELETE CASCADE,
          ticket_id TEXT,
          workspace_id TEXT,
          asked_by TEXT,                              -- agent handle / terminal goal, for the card
          route TEXT NOT NULL DEFAULT 'operator',     -- operator | robert
          triage TEXT,                                -- Robert's call, in his words
          escalated_at TEXT,
          question TEXT NOT NULL,
          options TEXT,
          answer TEXT,
          answered_by TEXT,
          status TEXT NOT NULL DEFAULT 'open',
          created_at TEXT NOT NULL,
          answered_at TEXT
        );
        INSERT INTO asks_new (id,run_id,job_id,ticket_id,workspace_id,question,options,answer,answered_by,status,created_at,answered_at)
          SELECT id,run_id,job_id,ticket_id,workspace_id,question,options,answer,answered_by,status,created_at,answered_at FROM asks;
        DROP TABLE asks;
        ALTER TABLE asks_new RENAME TO asks;
        CREATE INDEX IF NOT EXISTS idx_asks_run ON asks(run_id);
        CREATE INDEX IF NOT EXISTS idx_asks_session ON asks(session_id);
        CREATE INDEX IF NOT EXISTS idx_asks_status ON asks(status);
      `);
    },
  },
  {
    version: 99,
    name: "sessions.worktree_* — where a terminal ACTUALLY ended up working",
    // A Desk terminal learns its repo mid-session (the spawn dialog's pick is a guess made before
    // anyone read the task), so it claims a worktree with `mc worktree` once it knows. That path has
    // to be remembered rather than inferred from `cwd`: cwd is frozen at spawn, so without this a
    // reopened terminal resumes OUTSIDE the worktree it spent an hour in.
    up: (db) =>
      db.exec(`
        ALTER TABLE sessions ADD COLUMN worktree_path TEXT;
        ALTER TABLE sessions ADD COLUMN worktree_branch TEXT;
      `),
  },
  {
    version: 100,
    name: "workspaces.sandbox_allow — credential dirs ONE workspace's agents may reach",
    // `CONFIG.sandbox.secrets` is an absolute read+write deny, last in the rule order, and that is
    // the right default: ~/.ssh, ~/.aws, ~/.config/gcloud are exactly what a compromised agent would
    // reach for. But it is a global answer to a per-client question. Globex's whole job IS
    // BigQuery — its agents cannot run `bq` at all without gcloud's credential store, and they were
    // reporting it as a macOS "Full Disk Access" problem, because from inside the sandbox a Seatbelt
    // denial is indistinguishable from one.
    //
    // So: a per-workspace re-grant, applied AFTER the secrets deny and only for that workspace.
    // Null for every workspace until someone deliberately sets it.
    up: (db) => db.exec("ALTER TABLE workspaces ADD COLUMN sandbox_allow TEXT"),
  },
  {
    version: 101,
    name: "workspaces.backends — which agent CLIs a client is allowed to run",
    // Only two of the five CLIs isolate per workspace: claude (CLAUDE_CONFIG_DIR) and codex
    // (CODEX_HOME). cursor, grok and opencode have no config-dir env at all, so they run under ONE
    // shared login no matter whose workspace spawned them — Acme's work and Globex's work would
    // go through the same account. That is a client-separation problem, not a preference, which is
    // why this is enforced at spawn rather than just filtered out of the picker.
    //
    // Null = every registered backend (the default, and what every workspace had before this).
    up: (db) => db.exec("ALTER TABLE workspaces ADD COLUMN backends TEXT"),
  },
  {
    version: 102,
    name: "watches table — condition → wake, the cheap half of monitoring",
    // An executive could only 'keep an eye on' something by leaving prose in its memory, which
    // rides EVERY heartbeat prompt: paid for on every tick, whether or not anything moved. A watch
    // inverts that — the daemon evaluates the condition (a bus event match, or a GET on our own API
    // plus a predicate), and a model turn is spent only when it actually fires.
    //
    // No FK on workspace_id: a watch may be unscoped (cross-workspace), same as board posts.
    up: (db) =>
      db.exec(`CREATE TABLE IF NOT EXISTS watches (
        id TEXT PRIMARY KEY,
        owner TEXT NOT NULL,
        what TEXT NOT NULL,
        mode TEXT NOT NULL,
        on_topic TEXT,
        where_json TEXT,
        check_path TEXT,
        when_expr TEXT,
        every_sec INTEGER,
        say TEXT,
        one_shot INTEGER NOT NULL DEFAULT 1,
        enabled INTEGER NOT NULL DEFAULT 1,
        until TEXT NOT NULL,
        workspace_id TEXT,
        created_by TEXT,
        created_at TEXT NOT NULL,
        last_checked_at TEXT,
        last_fired_at TEXT,
        fire_count INTEGER NOT NULL DEFAULT 0,
        last_state TEXT,
        disabled_reason TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_watches_live ON watches(enabled, mode);
      CREATE INDEX IF NOT EXISTS idx_watches_owner ON watches(owner, enabled);`),
  },
  {
    version: 103,
    name: "watches.at — scheduled self-wakes (mode 'at': a time, not a condition)",
    // "Wake me in 20 minutes with this message." The agent registers the line; when it comes due,
    // the daemon posts it to the board @mentioning them — no gate, no judgment call, because the
    // decision to wake was already made by the agent that scheduled it. Its own migration (not a
    // column in 102, the watches table) so the two can merge in either order without a
    // half-applied table.
    up: (db) => db.exec(`ALTER TABLE watches ADD COLUMN at TEXT`),
  },
  {
    version: 104,
    name: "jots table — the thought you parked, and the terminal it becomes",
    // The gap this fills: there was nowhere to put work you have decided to do but cannot start yet,
    // because you do not know enough to write the prompt. Three homes existed and each was wrong.
    //
    //  - A ticket is a commitment. On Acme and Globex it syncs to ClickUp and Jira, so a
    //    half-formed thought would land in a client's tracker as if it were a plan.
    //  - An idea is a proposal awaiting triage, written mostly BY the feeders (miner/followups) FOR
    //    The operator. Parking your own notes there mixes what you decided with what a model
    //    suggested, and promoting one produces a ticket, not the terminal you actually wanted.
    //  - A note (src/store/notes.ts) is a markdown document. Documents do not have a run button.
    //
    // So: a row, owned by a client, editable in place, with one action — open a terminal seeded from
    // it. No connector, no acceptance criteria, no complexity grade. The row survives the run and
    // keeps the session id, so it stays a door back into the work.
    up: (db) => db.exec(`
      CREATE TABLE IF NOT EXISTS jots (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
        title TEXT NOT NULL,
        body TEXT,
        status TEXT NOT NULL DEFAULT 'open',
        pos INTEGER NOT NULL DEFAULT 0,
        -- No FK to sessions: a terminal's row is reaped on retention long before the jot is, and an
        -- ON DELETE CASCADE would take the thought with it. A dangling id reads as "that terminal is
        -- gone", which the Desk already handles for its own reopen path.
        session_id TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        ran_at TEXT,
        done_at TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_jots_ws ON jots(workspace_id, status, pos);`),
  },
  {
    version: 105,
    name: "workspaces.default_dir — where a repo-less session lands",
    // A terminal spawned with no repo picked used to fall into the workspace's FIRST repo (sorted
    // by name), which is an accident of registration order, not a choice. A client whose work
    // spans several checkouts wants those sessions to open in the parent folder that holds all of
    // them (e.g. ~/Documents/GitHub/acme), so `cd <repo>` is one hop and cross-repo work has a
    // natural floor. Null = keep the old first-repo fallback.
    up: (db) => db.exec("ALTER TABLE workspaces ADD COLUMN default_dir TEXT"),
  },
  {
    version: 106,
    name: "workspace_vars — shared env vars handed to a workspace's agents, with a shelf life",
    // The operator gets a token (a client's staging key, a one-day API credential) and wants every
    // agent in THAT workspace to have it without pasting it into a terminal — pasting puts a live
    // credential in a transcript, in scrollback, and in whatever the agent echoes back. Rows here
    // are merged into the env of every child spawned for the workspace, so the value travels
    // daemon → child env and is used without ever being read.
    // `expires_at` NULL = no expiration at all; otherwise reads filter and purge past it, so a
    // 12-hour token stops existing rather than lingering. UNIQUE(workspace_id,name) makes re-adding
    // a var the rotate/re-arm path. ON DELETE CASCADE: a deleted workspace takes its secrets with it.
    up: (db) =>
      db.exec(`CREATE TABLE IF NOT EXISTS workspace_vars (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        value TEXT NOT NULL,
        expires_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(workspace_id, name)
      );
      CREATE INDEX IF NOT EXISTS idx_workspace_vars_ws ON workspace_vars(workspace_id);`),
  },
  {
    version: 107,
    name: "jots.for_date / source / planned_by — the card a planner filed for a given day",
    // "Plan tomorrow" opens one terminal per client that reads the tracker, the last terminals, the
    // PRs and the memos, and files the day's cards. Those cards are jots — the row that already has
    // the one action wanted here (Run opens a terminal seeded from it) — but three things about a
    // planned card are not true of a parked thought:
    //  - it belongs to a DAY (`for_date`, YYYY-MM-DD), so the Desk can group "Next Day 09-04" and a
    //    re-plan can replace yesterday's unrun cards instead of stacking on them;
    //  - an agent wrote it (`source` 'nextday'), and jot writes are otherwise operator-only — the
    //    scoped write path in api.ts admits an agent ONLY for a dated card, never a bare one;
    //  - the terminal that filed it (`planned_by`) is the door back to the reasoning. No FK: session
    //    rows are reaped on retention long before the card is.
    up: (db) => db.exec(`
      ALTER TABLE jots ADD COLUMN for_date TEXT;
      ALTER TABLE jots ADD COLUMN source TEXT NOT NULL DEFAULT 'operator';
      ALTER TABLE jots ADD COLUMN planned_by TEXT;
      CREATE INDEX IF NOT EXISTS idx_jots_ws_date ON jots(workspace_id, for_date);`),
  },
  {
    version: 108,
    name: "launches — a terminal you open more than once, saved under a name",
    // Recurring work (the morning Airflow check, "review the open PRs", the dbt run) was retyped
    // into the New-terminal dialog every time, or lived in the operator's head. A launch is that
    // dialog's fields under a name, pinned to one client's header. It is not a jot (a jot becomes
    // one terminal and closes) and not a job (a job runs headless on a cron; a launch opens a live
    // terminal with the operator at the keyboard). No FK to sessions: the last terminal it opened
    // is a door, and doors may dangle once retention reaps the row.
    up: (db) => db.exec(`
      CREATE TABLE IF NOT EXISTS launches (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        goal TEXT,
        goal_kind TEXT,
        description TEXT,
        backend TEXT,
        model TEXT,
        cwd TEXT,
        pos INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        last_run_at TEXT,
        run_count INTEGER NOT NULL DEFAULT 0,
        last_session_id TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_launches_ws ON launches(workspace_id, pos);`),
  },
  {
    version: 109,
    name: "sessions.cost_estimated — Desk spend must not look like a metered fact",
    // snapshotUsage already distinguishes CLI cost-state (exact) from token-table arithmetic
    // (estimate). Without a column the day's log and the combined ledger can only say "cost_usd",
    // so an estimate is presented as a fact. Persist the flag with the number.
    up: (db) => db.exec("ALTER TABLE sessions ADD COLUMN cost_estimated INTEGER NOT NULL DEFAULT 0"),
  },
  // One-time jobs (trigger_type "once"): the single fire time. Cleared when it fires — see src/once.ts.
  { version: 110, name: "jobs.run_at", up: (db) => db.exec("ALTER TABLE jobs ADD COLUMN run_at TEXT") },
  {
    version: 111,
    name: "robert_wakes — the wake queue is a table, not a Map",
    // Robert's wakes lived in an in-memory debounce Map and fired the turn fire-and-forget, so a
    // daemon restart or a thrown turn lost the wake with nothing left to say it happened. See
    // src/wake-queue.ts for the drain contract this schema serves.
    up: (db) =>
      db.exec(`
CREATE TABLE IF NOT EXISTS robert_wakes (
  id TEXT PRIMARY KEY,
  generation INTEGER NOT NULL,
  topic TEXT NOT NULL,
  key TEXT NOT NULL,
  subject TEXT,
  payload TEXT,
  workspace_id TEXT,
  hits INTEGER NOT NULL DEFAULT 1,
  attempts INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  claimed_at TEXT,
  handled_at TEXT,
  acked_at TEXT,
  last_error TEXT
);
CREATE INDEX IF NOT EXISTS idx_robert_wakes_acked ON robert_wakes(acked_at);
CREATE INDEX IF NOT EXISTS idx_robert_wakes_key ON robert_wakes(key);
CREATE INDEX IF NOT EXISTS idx_robert_wakes_subject ON robert_wakes(subject);`),
  },
  {
    version: 112,
    name: "asks/reviews hold_until + hold_reason + resurfaced_at — \"later\" is an answer",
    // An open ask or a pending review only had two states on the operator's list: live, or gone. So
    // "not now" had nowhere to go — the item stayed live-looking forever (and kept pinging on
    // askRemindHours), or somebody fabricated an answer to clear it. A dated hold is the third state:
    // it leaves the live "needs you" list and comes BACK on its date, which is why the date and not an
    // age heuristic is the durable mechanism. `resurfaced_at` is what keeps the return card to once.
    // Recovery stalls are derived rows with no table of their own — their holds live in kv beside the
    // decision they already record there (`recover.hold.<id>`; see src/recovery.ts).
    up: (db) => db.exec(`
      ALTER TABLE asks ADD COLUMN hold_until TEXT;
      ALTER TABLE asks ADD COLUMN hold_reason TEXT;
      ALTER TABLE asks ADD COLUMN resurfaced_at TEXT;
      ALTER TABLE reviews ADD COLUMN hold_until TEXT;
      ALTER TABLE reviews ADD COLUMN hold_reason TEXT;
      ALTER TABLE reviews ADD COLUMN resurfaced_at TEXT;
      CREATE INDEX IF NOT EXISTS idx_asks_hold ON asks(status, hold_until);
      CREATE INDEX IF NOT EXISTS idx_reviews_hold ON reviews(state, hold_until);`),
  },
  {
    version: 113,
    name: "sessions.end_reason — why a terminal ended when nobody closed it",
    // A terminal the daemon ends on its own (terminal-failover.ts: out of credits → handed to a new
    // grok terminal) looked exactly like one the operator closed: an ended card with no story. The
    // reason is what makes the Desk say where the work went.
    up: (db) => db.exec("ALTER TABLE sessions ADD COLUMN end_reason TEXT"),
  },
  {
    version: 114,
    name: "session_status — what a terminal declared and what its hooks reported",
    // term-status.ts. Kept in memory before, so a deploy wiped every `mc state blocked` and a blocked
    // card went green an hour later on its own. One JSON blob per terminal: declarations, progress,
    // hook turn boundaries, live subagents.
    up: (db) => db.exec(`
      CREATE TABLE IF NOT EXISTS session_status (
        session_id TEXT PRIMARY KEY,
        data TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );`),
  },
  {
    version: 115,
    name: "watch_reports — every standing-watch check Robert made, readable on the Desk",
    // desk-watch.ts sent each report to Telegram and kept nothing, so the Desk could say a terminal was
    // watched but never what Robert had seen. One row per check; `final` marks the closing verdict.
    up: (db) => db.exec(`
      CREATE TABLE IF NOT EXISTS watch_reports (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL,
        at TEXT NOT NULL,
        state TEXT NOT NULL,
        body TEXT NOT NULL,
        final INTEGER NOT NULL DEFAULT 0,
        failed INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS idx_watch_reports_session ON watch_reports(session_id, id);`),
  },
  {
    version: 116,
    name: "chat_messages.steps — what Robert did during a turn, one timestamped step per move",
    // robert-steps.ts. The Desk shows the trail under his reply; kept on the row so a reload shows it too.
    up: (db) => db.exec("ALTER TABLE chat_messages ADD COLUMN steps TEXT"),
  },
  {
    version: 117,
    name: "sessions.lead_token — a Lead's credential to type into its own workspace's terminals",
    // A Lead (role "lead", LEADS.md) is Robert's deputy for one goal: it may type into the workers
    // it opened, the one thing a plain worker may never do. The workspace token is not enough — that
    // would let ANY worker drive any other terminal in the workspace — so a Lead gets its own random
    // credential, set at create and cleared at end (sessions.ts), checked by authz.ts leadScope.
    up: (db) => db.exec("ALTER TABLE sessions ADD COLUMN lead_token TEXT"),
  },
  {
    version: 118,
    name: "chat attachments — screenshots and files pasted or dropped into Robert's chat",
    // attachments.ts (Desk chat section). Two halves of one feature: the table is the id→file index
    // the thumbnails resolve through (`GET /api/attachments/chat/:id`), and the column is what the
    // chat log redraws them from after a reload. The column holds display JSON only ({id,url,mime,
    // name}) — `you` stays the words the operator typed, and the absolute paths the model is given
    // are rebuilt from the table at turn time, so moving CHRONOS_ATTACHMENTS does not strand a row.
    up: (db) => db.exec(`
      CREATE TABLE IF NOT EXISTS chat_attachments (
        id TEXT PRIMARY KEY,
        rel_path TEXT NOT NULL,
        name TEXT NOT NULL,
        mime TEXT NOT NULL,
        size INTEGER NOT NULL,
        text_path TEXT,
        created_at TEXT NOT NULL
      );
      ALTER TABLE chat_messages ADD COLUMN attachments TEXT;`),
  },
  {
    version: 119,
    name: "session_phases — the phase history the Fleet pulse card draws",
    // term-status.ts resolved a terminal's phase on every read but kept the transitions in a Map, so
    // the daemon could say "decide, 14m" and nothing could say what the hour before that looked like:
    // a restart erased the whole fleet's recent past. One append-only row per transition is enough to
    // draw it back. `at` is epoch ms (not the ISO text the rest of the schema uses) because every
    // consumer measures durations with it, and PRIMARY KEY(session_id, at) makes a double-write from
    // two code paths in the same millisecond a no-op instead of a duplicate segment. Pruned to 7 days
    // in term-status.ts — this is a drawing, not an audit trail; activity.ts is the audit trail.
    up: (db) => db.exec(`
      CREATE TABLE IF NOT EXISTS session_phases (
        session_id TEXT NOT NULL,
        phase TEXT NOT NULL,
        at INTEGER NOT NULL,
        PRIMARY KEY (session_id, at)
      );
      CREATE INDEX IF NOT EXISTS idx_session_phases_at ON session_phases(at);`),
  },
  {
    version: 120,
    name: "sessions.lead_id + lead_wakes — server-stamped Lead↔worker ownership, and the wakes already typed",
    // Until now the Lead→worker link was a STRING THE WORKER ASSERTED: `created_by = "lead:<id8>"`,
    // signed by `mc` from its own MC_AGENT_NAME. Anything that could open a terminal could claim to
    // be a Lead's worker (and thereby route its stops into that Lead's pty), and an id8 prefix is not
    // a key. `lead_id` is stamped by the daemon from the `x-mc-lead` credential at POST /sessions and
    // is never accepted from a request body — the linkage is now as hard as the token behind it.
    //
    // `lead_wakes` is the durable half of the Lead wake path, the mirror of `robert_wakes` for stops
    // that were typed into a Lead instead of queued for Robert: without it a daemon restart re-derives
    // every stopped worker's `since`, so every one of them woke its Lead a second time about the same
    // stop (robert-drive.ts leadAlreadyWoken). Pruned to 7 days at startup — a keystroke log, not an
    // audit trail.
    up: (db) => {
      db.exec(`
        ALTER TABLE sessions ADD COLUMN lead_id TEXT;
        CREATE INDEX IF NOT EXISTS idx_sessions_lead ON sessions(lead_id, status);
        CREATE TABLE IF NOT EXISTS lead_wakes (
          key TEXT PRIMARY KEY,
          lead_id TEXT NOT NULL,
          session_id TEXT NOT NULL,
          kind TEXT NOT NULL,
          created_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_lead_wakes_session ON lead_wakes(session_id, created_at);`);
      // Backfill the existing workers of existing Leads, so the terminals open at deploy time keep
      // their Lead instead of silently reverting to waking Robert. Only an UNAMBIGUOUS id8 → one
      // `role='lead'` row counts: two Leads sharing an 8-hex prefix is exactly the ambiguity this
      // column exists to remove, and guessing between them would hand one Lead the other's worker.
      const workers = db
        .prepare("SELECT id, created_by FROM sessions WHERE created_by LIKE 'lead:%'")
        .all() as Array<{ id: string; created_by: string }>;
      const candidates = db.prepare("SELECT id FROM sessions WHERE role = 'lead' AND id LIKE ? LIMIT 2");
      const stamp = db.prepare("UPDATE sessions SET lead_id = ? WHERE id = ?");
      for (const w of workers) {
        const m = /^lead:([0-9a-f]{8})$/i.exec(w.created_by ?? "");
        if (!m) continue;
        const hits = candidates.all(`${m[1]}%`) as Array<{ id: string }>;
        if (hits.length === 1) stamp.run(hits[0].id, w.id);
      }
    },
  },
  {
    version: 121,
    name: "lead_events — a Lead's durable inbox, pulled first and pushed as one digest",
    // Until now a worker stopping was typed straight into its Lead's pty: five workers finishing
    // together were five prompts, five Lead turns and five flattened 1200-char lines, and a Lead that
    // wanted to WAIT for the next one had no way to — the live Collage Lead was running
    // `sleep 40; mc session focus <id>` in a loop. A stop is now a ROW: the Lead long-polls for it
    // (`mc lead wait`), and only a Lead that is not pulling gets one typed digest (robert-drive.ts).
    //
    // `key` is the drive key (session+phase+since) — UNIQUE, so the same stop re-armed inserts once,
    // and NULL for the kinds that have no stop behind them (`ended`, and PR 3's `report`/`ask`);
    // SQLite lets NULLs repeat in a UNIQUE column, which is exactly what those need. The three
    // timestamps are the lifecycle: `seen_at` = handed to the Lead (pulled or digested), `delivered_at`
    // = typed into it, `acked_at` = the Lead acted on that worker. Pruned to 7 days at startup.
    up: (db) => db.exec(`
      CREATE TABLE IF NOT EXISTS lead_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        lead_id TEXT NOT NULL,
        session_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        key TEXT UNIQUE,
        payload TEXT,
        created_at TEXT NOT NULL,
        seen_at TEXT,
        delivered_at TEXT,
        acked_at TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_lead_events_inbox ON lead_events(lead_id, seen_at, id);`),
  },
  {
    version: 122,
    name: "lead_slices — a Lead's plan, outside its context window",
    // A Lead's plan lived only in the turn that wrote it: one compaction and the terminal that was
    // steering seven workers could no longer say which slice each one was on, or which were already
    // done. The board is that plan as ROWS — `mc lead board` after any confusion rebuilds the whole
    // picture, next to `mc lead workers` and `mc lead inbox`.
    //
    // `n` is the Lead's own numbering (1, 2, 3…), UNIQUE per Lead so two `board add` calls racing
    // cannot both take the same number; `session_id` is the worker on it, which the daemon only ever
    // sets to one of THAT Lead's own workers (api.ts).
    up: (db) => db.exec(`
      CREATE TABLE IF NOT EXISTS lead_slices (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        lead_id TEXT NOT NULL,
        n INTEGER NOT NULL,
        title TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'todo',
        session_id TEXT,
        pr_url TEXT,
        note TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(lead_id, n)
      );
      CREATE INDEX IF NOT EXISTS idx_lead_slices_lead ON lead_slices(lead_id, n);`),
  },
  {
    version: 123,
    name: "sessions.cache_read/cache_write — Desk prompt-cache on the ledger",
    // Desk transcripts already counted cache tokens in memory (session-usage) for live estimates,
    // but never persisted them — analytics/session spend could not show Desk cache health beside
    // headless runs. Mirror runs.cache_* so /stats and Altitude see both surfaces.
    up: (db) =>
      db.exec(`
        ALTER TABLE sessions ADD COLUMN cache_read INTEGER;
        ALTER TABLE sessions ADD COLUMN cache_write INTEGER;`),
  },
  {
    version: 124,
    name: "runs.cost_estimated — labelled token-table dollars on headless runs",
    // grok/cursor/codex/openai-api often report tokens but never a vendor cost. Estimating those
    // closes the PER-24 coverage hole — but only if the dollar stays labelled so a budget alarm
    // never treats an estimate as metered fact (same contract as sessions.cost_estimated).
    up: (db) => db.exec("ALTER TABLE runs ADD COLUMN cost_estimated INTEGER NOT NULL DEFAULT 0"),
  },
  {
    version: 125,
    name: "repo_accelerators — opt-in per-repo workspace accelerators (graphify/ast-grep/repomix)",
    // Foundation only: a stored on/off switch (+ optional mode, e.g. graphify's code-only canary)
    // per (repo, tool). Nothing reads this to change a prompt or spawn an MCP server yet — enabling
    // a row here is inert until a future PR wires real integration (see src/accel/zero-tax.test.ts
    // for the boundary that pins that). One row per (repo_id, tool): flipping the switch is an
    // upsert, never a growing history.
    up: (db) =>
      db.exec(`CREATE TABLE IF NOT EXISTS repo_accelerators (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
        repo_id TEXT NOT NULL REFERENCES repos(id) ON DELETE CASCADE,
        tool TEXT NOT NULL CHECK (tool IN ('graphify','ast-grep','repomix')),
        enabled INTEGER NOT NULL DEFAULT 0 CHECK (enabled IN (0,1)),
        mode TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(repo_id, tool)
      );
      CREATE INDEX IF NOT EXISTS idx_repo_accel_ws ON repo_accelerators(workspace_id);`),
  },
  {
    version: 126,
    name: "accel_telemetry — content-free accelerator build/query metrics",
    // Metrics only: never stores question text, query result, stderr bodies, or source content.
    // `error` holds a short code/class only (timeout, output-cap, …) — never a sanitized message.
    // session_id is optional, same-workspace validated at write time, FK ON DELETE SET NULL.
    // Indexed for the 7-day aggregate under /stats efficiency.accelerators.
    up: (db) =>
      db.exec(`CREATE TABLE IF NOT EXISTS accel_telemetry (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
        repo_id TEXT NOT NULL REFERENCES repos(id) ON DELETE CASCADE,
        session_id TEXT REFERENCES sessions(id) ON DELETE SET NULL,
        tool TEXT NOT NULL,
        op TEXT NOT NULL CHECK (op IN ('build','query')),
        ok INTEGER NOT NULL CHECK (ok IN (0,1)),
        duration_ms INTEGER NOT NULL CHECK (duration_ms >= 0),
        budget INTEGER CHECK (budget IS NULL OR budget >= 0),
        input_bytes INTEGER NOT NULL DEFAULT 0 CHECK (input_bytes >= 0),
        output_bytes INTEGER NOT NULL DEFAULT 0 CHECK (output_bytes >= 0),
        estimated_output_tokens INTEGER NOT NULL DEFAULT 0 CHECK (estimated_output_tokens >= 0),
        artifact_bytes INTEGER CHECK (artifact_bytes IS NULL OR artifact_bytes >= 0),
        head TEXT,
        tool_version TEXT,
        error TEXT,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_accel_telemetry_ws_created
        ON accel_telemetry(workspace_id, created_at);
      CREATE INDEX IF NOT EXISTS idx_accel_telemetry_created
        ON accel_telemetry(created_at);
      CREATE INDEX IF NOT EXISTS idx_accel_telemetry_repo_tool_op_created
        ON accel_telemetry(repo_id, tool, op, created_at);
      CREATE INDEX IF NOT EXISTS idx_accel_telemetry_session_created
        ON accel_telemetry(session_id, created_at);`),
  },
  {
    version: 127,
    name: "memory_relations — judged relationships between two remembered facts",
    // Until now memory could only notice that a new fact was the SAME as an old one (Jaccard
    // dedupe). It could never notice that it CONTRADICTED one, so the index quietly accumulated
    // rules that disagree and an agent acted on whichever it read first. A row here is one judged
    // pair: what the two sides said, the verdict, and who judged it.
    //
    // Both sides are (kind, ref) rather than an FK: a lesson is a row, but an index line is a line
    // inside a memo body with no id of its own — it is identified by the hash of its prose
    // (entryHash, src/memory-tiers.ts). `*_text` is denormalized on purpose: the point of the row
    // is to show the operator the two statements that disagree, and it must survive the source
    // being edited underneath it.
    //
    // UNIQUE(workspace_id, source_ref, target_ref) keeps a pair from being re-judged on every
    // capture. Editing either side changes its hash, which is a genuinely new pair.
    up: (db) =>
      db.exec(`CREATE TABLE IF NOT EXISTS memory_relations (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
        source_kind TEXT NOT NULL CHECK (source_kind IN ('lesson','memory-line')),
        source_ref TEXT NOT NULL,
        source_text TEXT NOT NULL,
        target_kind TEXT NOT NULL CHECK (target_kind IN ('lesson','memory-line')),
        target_ref TEXT NOT NULL,
        target_text TEXT NOT NULL,
        relation TEXT NOT NULL CHECK (relation IN
          ('conflicts_with','supersedes','scoped','related','compatible','not_conflict')),
        confidence REAL,
        reason TEXT,
        judged_by TEXT,
        status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','resolved','dismissed')),
        resolved_at TEXT,
        created_at TEXT NOT NULL,
        UNIQUE(workspace_id, source_ref, target_ref)
      );
      CREATE INDEX IF NOT EXISTS idx_memrel_ws_status
        ON memory_relations(workspace_id, status, created_at);
      CREATE INDEX IF NOT EXISTS idx_memrel_source ON memory_relations(source_ref);
      CREATE INDEX IF NOT EXISTS idx_memrel_target ON memory_relations(target_ref);`),
  },
  {
    version: 128,
    name: "sessions.focus_only — Desk spawn can skip the live terminal",
    // Optional at create: the operator asks for the Focus story and composer, and the Desk never
    // mounts this session's xterm. Default 0 so every existing terminal keeps its raw pane.
    up: (db) =>
      db.exec(
        "ALTER TABLE sessions ADD COLUMN focus_only INTEGER NOT NULL DEFAULT 0 CHECK (focus_only IN (0,1))",
      ),
  },
  {
    version: 129,
    name: "session_goals — a terminal may be given more than one finish line",
    // A terminal used to have exactly one goal, in three columns on `sessions`. From every surface's
    // point of view it still does: `sessions.goal` / `goal_kind` / `goal_done_at` keep mirroring the
    // CURRENT goal (the first one not ticked). This table is the list behind that mirror — the
    // operator can queue "open the PR", then "update the runbook", and the card still shows one
    // thing at a time. A terminal with a single goal never needs a row here (src/store/sessions.ts
    // seeds one lazily the first time a second goal is added), so nothing has to be backfilled.
    up: (db) =>
      db.exec(`
      CREATE TABLE IF NOT EXISTS session_goals (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        seq INTEGER NOT NULL,
        text TEXT NOT NULL,
        kind TEXT,
        source TEXT,
        done_at TEXT,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_session_goals_session ON session_goals(session_id, seq);`),
  },
  {
    version: 130,
    name: "runs/sessions cloud_* — a run that lives on someone else's VM",
    // A cloud run has no pid and no stdout: Chronos launches it, then RECONCILES. These four columns
    // are everything a daemon that was asleep (or off) while the work happened needs to pick the run
    // back up — the agent+run ids to poll, the human link for the Desk card, and the SSE cursor so a
    // replay resumes where the stream dropped instead of re-storing every event from the start.
    // sessions gets the same four so a cloud TERMINAL card can render state and links without a pty.
    up: (db) => {
      for (const t of ["runs", "sessions"]) {
        db.exec(`ALTER TABLE ${t} ADD COLUMN cloud_agent_id TEXT`);
        db.exec(`ALTER TABLE ${t} ADD COLUMN cloud_run_id TEXT`);
        db.exec(`ALTER TABLE ${t} ADD COLUMN cloud_url TEXT`);
        db.exec(`ALTER TABLE ${t} ADD COLUMN cloud_last_event_id TEXT`);
      }
      // The reconciler's only query: every cloud run still believed to be running.
      db.exec("CREATE INDEX IF NOT EXISTS idx_runs_cloud_live ON runs(status, cloud_agent_id)");
    },
  },
  {
    version: 131,
    name: "prose_samples — the operator's own writing, per workspace",
    // What the operator actually sent (Slack/Jira/ClickUp/email), so agents drafting business messages
    // on his behalf write the way he does (src/prose.ts). `draft` is set when the sample is an edit:
    // the agent's draft he rewrote — the strongest signal there is. `hash` dedupes a comment the
    // connector sees on every pull.
    up: (db) => {
      db.exec(`CREATE TABLE IF NOT EXISTS prose_samples (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
        source TEXT NOT NULL,
        channel TEXT NOT NULL,
        origin TEXT NOT NULL,
        body TEXT NOT NULL,
        draft TEXT,
        context TEXT,
        ref TEXT,
        hash TEXT NOT NULL,
        created_at TEXT NOT NULL
      )`);
      db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_prose_hash ON prose_samples(workspace_id, hash)");
      db.exec("CREATE INDEX IF NOT EXISTS idx_prose_ws ON prose_samples(workspace_id, created_at)");
    },
  },
  {
    version: 132,
    name: "memory_usage — which memory agents actually read",
    // Evidence for ranking and pruning workspace memory (src/memory-usage.ts): every recall query and
    // each hit it returned, every memo/skill an agent opened, every memo the relevance block put in
    // front of a fresh agent. Append-only; the retention sweep drops rows past ~60 days. `hits` is
    // set on `recall` rows only — a query that found nothing is a gap in the memory, not noise.
    up: (db) => {
      db.exec(`CREATE TABLE IF NOT EXISTS memory_usage (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
        kind TEXT NOT NULL,
        ref_kind TEXT,
        ref TEXT,
        query TEXT,
        hits INTEGER,
        source TEXT,
        session_id TEXT,
        ts TEXT NOT NULL
      )`);
      db.exec("CREATE INDEX IF NOT EXISTS idx_memory_usage_ws ON memory_usage(workspace_id, ts)");
      db.exec("CREATE INDEX IF NOT EXISTS idx_memory_usage_ts ON memory_usage(ts)");
    },
  },
  {
    version: 133,
    name: "dream_runs + memory_clocks — the per-workspace dream pass",
    // dream_runs: one row per pass (src/dream-pass.ts). `chunk` is the inbox lines the bundle showed
    // (the plan must decide every one), `snapshot` is everything apply needs to undo itself, `stats`
    // and `receipt` are what the operator reads. memory_clocks: when each line of the memory tree was
    // last reinforced by evidence, keyed by its prose hash (memory-tiers.ts entryHash) — kept out of
    // the ★ bodies so the injected text carries no markers.
    up: (db) => {
      db.exec(`CREATE TABLE IF NOT EXISTS dream_runs (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
        slot TEXT,
        source TEXT NOT NULL,
        status TEXT NOT NULL,
        job_id TEXT,
        run_id TEXT,
        chunk TEXT,
        stats TEXT,
        receipt TEXT,
        snapshot TEXT,
        error TEXT,
        created_at TEXT NOT NULL,
        gathered_at TEXT,
        finished_at TEXT,
        undone_at TEXT
      )`);
      db.exec("CREATE INDEX IF NOT EXISTS idx_dream_runs_ws ON dream_runs(workspace_id, created_at)");
      db.exec(`CREATE TABLE IF NOT EXISTS memory_clocks (
        workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
        hash TEXT NOT NULL,
        reinforced TEXT NOT NULL,
        first_seen TEXT NOT NULL,
        PRIMARY KEY (workspace_id, hash)
      )`);
    },
  },
  {
    version: 134,
    name: "hosts + repo_checkouts + sessions/runs.host_id — paths and pids belong to a computer",
    // HOSTS.md phase 1: the seam, no behavior change. Today every process runs on the brain, so every
    // existing row is `local` and nothing reads these columns to decide anything yet. They exist now
    // so that when a second Mac joins, a pid or a path is never read on the wrong machine.
    //
    // repo_checkouts: `repos.path` is the brain's own checkout and stays the thing every caller reads.
    // The `local` row mirrors it (backfilled here, kept in sync by store/repos.ts); a remote host adds
    // its own row with ITS path, since /Users/alice on one Mac is /Users/a.smith on another. `head`
    // and `scanned_at` stay null until a host actually scans (phase 2).
    //
    // host_id on sessions/runs is a plain column, not a REFERENCES: SQLite refuses ADD COLUMN with a
    // foreign key and a non-null default while foreign_keys is on, and a table rebuild of sessions
    // and runs is not worth it for a key the brain writes itself.
    up: (db) => {
      db.exec(`CREATE TABLE IF NOT EXISTS hosts (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        platform TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'online',
        policy_json TEXT,
        reserve_json TEXT,
        token_hash TEXT,
        cert_fp TEXT,
        last_seen_at TEXT,
        capabilities_json TEXT,
        created_at TEXT NOT NULL
      )`);
      ensureLocalHost(db);
      db.exec(`CREATE TABLE IF NOT EXISTS repo_checkouts (
        repo_id TEXT NOT NULL REFERENCES repos(id) ON DELETE CASCADE,
        host_id TEXT NOT NULL REFERENCES hosts(id) ON DELETE CASCADE,
        path TEXT NOT NULL,
        head TEXT,
        scanned_at TEXT,
        PRIMARY KEY (repo_id, host_id)
      )`);
      db.exec("CREATE INDEX IF NOT EXISTS idx_repo_checkouts_host ON repo_checkouts(host_id)");
      db.exec("INSERT OR IGNORE INTO repo_checkouts (repo_id,host_id,path) SELECT id,'local',path FROM repos");
      db.exec("ALTER TABLE sessions ADD COLUMN host_id TEXT NOT NULL DEFAULT 'local'");
      db.exec("ALTER TABLE runs ADD COLUMN host_id TEXT NOT NULL DEFAULT 'local'");
    },
  },

];

export const LATEST_VERSION = MIGRATIONS[MIGRATIONS.length - 1].version;

/**
 * The brain is always a host. Run by migration 134 and again at every boot (store/db.ts), so even a
 * row deleted by hand comes back: every session and run defaults to `local`, and the registry must
 * be able to find the host they name. Idempotent; never touches an existing row.
 */
export function ensureLocalHost(db: Database.Database): void {
  db.prepare(
    "INSERT OR IGNORE INTO hosts (id,name,platform,status,created_at) VALUES ('local','local',?,'online',?)",
  ).run(process.platform, new Date().toISOString());
}

// Applies every migration newer than the DB's current `user_version`, each in its own transaction.
// Retrofit: every DB that predates this migration system built its schema by re-running ALL of the
// above statements (tolerant of "duplicate column") on EVERY boot, so any DB that already has a
// `jobs` table is already at the latest schema — jump user_version straight to head instead of
// replaying 50+ DDL statements against it.
export function migrate(db: Database.Database): void {
  let version = db.pragma("user_version", { simple: true }) as number;
  if (version > LATEST_VERSION) {
    throw new Error(
      `[store] DB is at version ${version}, but this daemon binary only knows up to version ${LATEST_VERSION}. ` +
      `Schema incompatibility: the database is newer than this binary. Upgrade the daemon.`,
    );
  }
  if (version === 0) {
    const hasJobs = db
      .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='jobs'")
      .get();
    if (hasJobs) {
      db.pragma(`user_version = ${LATEST_VERSION}`);
      version = LATEST_VERSION;
    }
  }
  for (const m of MIGRATIONS) {
    if (m.version <= version) continue;
    if (m.manualTx) {
      m.up(db);
      db.pragma(`user_version = ${m.version}`);
    } else {
      const apply = db.transaction(() => {
        m.up(db);
        db.pragma(`user_version = ${m.version}`);
      });
      apply();
    }
    console.log(`[chronos] migration ${m.version} applied: ${m.name}`);
  }
}
