import { test } from "node:test";
import assert from "node:assert";
import Database from "better-sqlite3";
import { ensureLocalHost, migrate, MIGRATIONS, LATEST_VERSION } from "./migrate.js";

test("migrate throws when DB version is newer than binary", () => {
  const db = new Database(":memory:");
  const futureVersion = LATEST_VERSION + 1;
  db.pragma(`user_version = ${futureVersion}`);

  assert.throws(
    () => migrate(db),
    (err) =>
      err instanceof Error &&
      err.message.includes("DB is at version") &&
      err.message.includes("only knows up to version") &&
      err.message.includes("Upgrade the daemon"),
  );
  db.close();
});

// Apply every migration up to (and including) `ceiling`, honoring user_version like migrate() does —
// lets a test seed rows at a pre-migration schema shape, then apply exactly one later migration.
function applyUpTo(db: Database.Database, ceiling: number): void {
  let version = db.pragma("user_version", { simple: true }) as number;
  for (const m of MIGRATIONS) {
    if (m.version <= version || m.version > ceiling) continue;
    if (m.manualTx) {
      m.up(db);
      db.pragma(`user_version = ${m.version}`);
    } else {
      db.transaction(() => {
        m.up(db);
        db.pragma(`user_version = ${m.version}`);
      })();
    }
    version = m.version;
  }
}

test("migration 88 backfills tickets.status_source: external-only mirrors get 'external', everything else 'local'", () => {
  const db = new Database(":memory:");
  applyUpTo(db, 87); // schema as it existed right before status_source

  const ws = "ws1";
  const ts = "2026-07-01T00:00:00.000Z";
  // migration 69 (jobs.ticket_id real FK) flips foreign_keys ON and leaves it there — tickets.workspace_id
  // is a real FK too, so a real workspaces row is required from here on.
  db.prepare(`INSERT INTO workspaces (id,slug,name,config_dir,created_at,updated_at) VALUES (@id,@id,@id,'/tmp/ws1',@ts,@ts)`).run({ id: ws, ts });
  const insertTicket = db.prepare(
    `INSERT INTO tickets (id,workspace_id,key,slug,title,status,priority,file_path,external_system,external_id,created_at,updated_at)
     VALUES (@id,@ws,@key,@slug,@title,@status,'P2',@fp,@es,@eid,@ts,@ts)`
  );
  // A: pure mirror — external, no job ever touched it.
  insertTicket.run({ id: "tA", ws, key: "ACM-1", slug: "a", title: "A", status: "in_progress", fp: "/a.md", es: "clickup", eid: "ext-1", ts });
  // B: external, but Chronos actually dispatched a job against it — real work, not a mirror.
  insertTicket.run({ id: "tB", ws, key: "ACM-2", slug: "b", title: "B", status: "in_progress", fp: "/b.md", es: "clickup", eid: "ext-2", ts });
  // C: native ticket, no external link at all.
  insertTicket.run({ id: "tC", ws, key: "ACM-3", slug: "c", title: "C", status: "backlog", fp: "/c.md", es: null, eid: null, ts });

  db.prepare(
    `INSERT INTO jobs (id,name,goal,cwd,created_at,updated_at,ticket_id) VALUES ('j1','ticket:ACM-2','g','/tmp',@ts,@ts,'tB')`
  ).run({ ts });

  applyUpTo(db, 88);

  const row = (id: string) => db.prepare("SELECT status_source FROM tickets WHERE id = ?").get(id) as { status_source: string };
  assert.equal(row("tA").status_source, "external", "external ticket with no job is a pure mirror");
  assert.equal(row("tB").status_source, "local", "external ticket a job actually touched is local");
  assert.equal(row("tC").status_source, "local", "native ticket defaults local");
  db.close();
});

test("migration 89 adds tickets.complexity_source, nullable, no backfill", () => {
  const db = new Database(":memory:");
  applyUpTo(db, 88); // schema as it existed right before complexity_source

  const ws = "ws1";
  const ts = "2026-07-01T00:00:00.000Z";
  db.prepare(`INSERT INTO workspaces (id,slug,name,config_dir,created_at,updated_at) VALUES (@id,@id,@id,'/tmp/ws1',@ts,@ts)`).run({ id: ws, ts });
  db.prepare(
    `INSERT INTO tickets (id,workspace_id,key,slug,title,status,priority,complexity,file_path,created_at,updated_at)
     VALUES ('tA',@ws,'ACM-1','a','A','backlog','P2','3','/a.md',@ts,@ts)`
  ).run({ ws, ts });

  applyUpTo(db, 89);

  const row = db.prepare("SELECT complexity_source FROM tickets WHERE id = 'tA'").get() as { complexity_source: string | null };
  assert.equal(row.complexity_source, null, "existing rows are left null — no backfill, legacy/unknown");
  db.close();
});

test("migration 118 adds the chat_attachments index and chat_messages.attachments", () => {
  const db = new Database(":memory:");
  applyUpTo(db, 117); // schema as it existed right before chat attachments

  const ts = "2026-09-16T00:00:00.000Z";
  db.prepare(`INSERT INTO chat_messages (you,reply,created_at,source,workspace_id) VALUES ('hola','hey',@ts,'web',NULL)`).run({ ts });

  applyUpTo(db, 118);

  const row = db.prepare("SELECT attachments FROM chat_messages").get() as { attachments: string | null };
  assert.equal(row.attachments, null, "existing rows are left null — no backfill");
  // The id→file index the Desk's thumbnails resolve through.
  assert.doesNotThrow(() => db.prepare("SELECT id, rel_path, name, mime, size, text_path FROM chat_attachments LIMIT 0").run());
  db.close();
});

test("migration 120 backfills sessions.lead_id from created_by, and refuses to guess when the id8 is ambiguous", () => {
  const db = new Database(":memory:");
  applyUpTo(db, 119); // schema as it existed right before lead_id

  const ws = "ws1";
  const ts = "2026-09-18T00:00:00.000Z";
  db.prepare(`INSERT INTO workspaces (id,slug,name,config_dir,created_at,updated_at) VALUES (@id,@id,@id,'/tmp/ws1',@ts,@ts)`).run({ id: ws, ts });
  const mk = db.prepare(
    `INSERT INTO sessions (id,workspace_id,role,cwd,status,created_at,created_by) VALUES (@id,@ws,@role,'/tmp',@status,@ts,@by)`,
  );
  const add = (id: string, role: string, by: string | null, status = "live") => mk.run({ id, ws, role, by, status, ts });

  add("aaaaaaaa-lead", "lead", "operator");
  add("aaaaaaaa-worker", "worker", "lead:aaaaaaaa");
  // An ended Lead still owns the workers it opened — reopening keeps its id, so the link must survive.
  add("bbbbbbbb-lead", "lead", "operator", "ended");
  add("bbbbbbbb-worker", "worker", "lead:bbbbbbbb", "ended");
  // Two Leads sharing an id8: the exact ambiguity lead_id exists to remove — guess nothing.
  add("cccccccc-lead-1", "lead", "operator");
  add("cccccccc-lead-2", "lead", "operator");
  add("cccccccc-worker", "worker", "lead:cccccccc");
  // No Lead at all behind the string, and a plain operator terminal.
  add("dddddddd-worker", "worker", "lead:eeeeeeee");
  add("plain", "worker", "operator");

  applyUpTo(db, 120);

  const leadOf = (id: string) => (db.prepare("SELECT lead_id FROM sessions WHERE id = ?").get(id) as { lead_id: string | null }).lead_id;
  assert.equal(leadOf("aaaaaaaa-worker"), "aaaaaaaa-lead");
  assert.equal(leadOf("bbbbbbbb-worker"), "bbbbbbbb-lead");
  assert.equal(leadOf("cccccccc-worker"), null, "two Leads match that id8 — no guess");
  assert.equal(leadOf("dddddddd-worker"), null, "nothing matches that id8");
  assert.equal(leadOf("plain"), null);
  assert.equal(leadOf("aaaaaaaa-lead"), null, "a Lead is nobody's worker");
  // The durable half of the Lead wake path ships in the same migration.
  assert.doesNotThrow(() => db.prepare("SELECT key, lead_id, session_id, kind, created_at FROM lead_wakes LIMIT 0").run());
  db.close();
});

test("migration 117 adds sessions.lead_token, nullable, no backfill — and a fresh DB gets it too", () => {
  const db = new Database(":memory:");
  applyUpTo(db, 116); // schema as it existed right before lead_token

  const ws = "ws1";
  const ts = "2026-09-16T00:00:00.000Z";
  db.prepare(`INSERT INTO workspaces (id,slug,name,config_dir,created_at,updated_at) VALUES (@id,@id,@id,'/tmp/ws1',@ts,@ts)`).run({ id: ws, ts });
  db.prepare(
    `INSERT INTO sessions (id,workspace_id,role,cwd,status,created_at) VALUES ('s1',@ws,'worker','/tmp','live',@ts)`
  ).run({ ws, ts });

  applyUpTo(db, 117);

  const row = db.prepare("SELECT lead_token FROM sessions WHERE id = 's1'").get() as { lead_token: string | null };
  assert.equal(row.lead_token, null, "existing rows are left null — no backfill");
  db.close();

  // migrate() replays every migration in order for a DB with no user_version at all — the same path
  // a brand-new install takes — so the column must exist at the end without any special-casing.
  const fresh = new Database(":memory:");
  migrate(fresh);
  assert.doesNotThrow(() => fresh.prepare("SELECT lead_token FROM sessions LIMIT 0").run());
  fresh.close();
});

test("migration 134: a local host row, repo_checkouts backfilled from repos.path, host_id defaults to 'local'", () => {
  const db = new Database(":memory:");
  applyUpTo(db, 133); // schema as it existed right before hosts

  const ts = "2026-09-24T00:00:00.000Z";
  db.prepare(`INSERT INTO workspaces (id,slug,name,config_dir,created_at,updated_at) VALUES ('ws1','ws1','ws1','/tmp/ws1',@ts,@ts)`).run({ ts });
  db.prepare(`INSERT INTO repos (id,workspace_id,name,path,created_at) VALUES ('r1','ws1','one','/src/one',@ts)`).run({ ts });
  db.prepare(`INSERT INTO repos (id,workspace_id,name,path,created_at) VALUES ('r2','ws1','two','/src/two',@ts)`).run({ ts });
  db.prepare(`INSERT INTO sessions (id,workspace_id,role,cwd,status,created_at) VALUES ('s1','ws1','human','/src/one','live',@ts)`).run({ ts });
  db.prepare(`INSERT INTO jobs (id,name,goal,cwd,created_at,updated_at) VALUES ('j1','j','g','/tmp',@ts,@ts)`).run({ ts });
  db.prepare(`INSERT INTO runs (id,job_id,status) VALUES ('run1','j1','running')`).run();

  applyUpTo(db, 134);

  const local = db.prepare("SELECT * FROM hosts WHERE id = 'local'").get() as any;
  assert.ok(local, "the brain is always a host");
  assert.equal(local.status, "online");
  assert.equal(local.platform, process.platform);
  assert.equal(local.token_hash, null, "the local host never authenticates over a link");

  const checkouts = db.prepare("SELECT repo_id, host_id, path, head, scanned_at FROM repo_checkouts ORDER BY repo_id").all();
  assert.deepEqual(checkouts, [
    { repo_id: "r1", host_id: "local", path: "/src/one", head: null, scanned_at: null },
    { repo_id: "r2", host_id: "local", path: "/src/two", head: null, scanned_at: null },
  ]);

  assert.equal((db.prepare("SELECT host_id FROM sessions WHERE id = 's1'").get() as any).host_id, "local");
  assert.equal((db.prepare("SELECT host_id FROM runs WHERE id = 'run1'").get() as any).host_id, "local");
  // New rows written by code that knows nothing about hosts land on 'local' too.
  db.prepare(`INSERT INTO sessions (id,workspace_id,role,cwd,status,created_at) VALUES ('s2','ws1','human','/tmp','live',@ts)`).run({ ts });
  assert.equal((db.prepare("SELECT host_id FROM sessions WHERE id = 's2'").get() as any).host_id, "local");

  // A repo that goes takes its checkouts with it.
  db.prepare("DELETE FROM repos WHERE id = 'r2'").run();
  assert.equal((db.prepare("SELECT COUNT(*) AS n FROM repo_checkouts WHERE repo_id = 'r2'").get() as any).n, 0);
  db.close();
});

test("migration 135: sessions.placement exists and existing rows read null (nothing was chosen for them)", () => {
  const db = new Database(":memory:");
  applyUpTo(db, 134);
  const ts = "2026-09-24T00:00:00.000Z";
  db.prepare(`INSERT INTO workspaces (id,slug,name,config_dir,created_at,updated_at) VALUES ('ws1','ws1','ws1','/tmp/ws1',@ts,@ts)`).run({ ts });
  db.prepare(`INSERT INTO sessions (id,workspace_id,role,cwd,status,created_at) VALUES ('s1','ws1','human','/tmp','live',@ts)`).run({ ts });
  applyUpTo(db, 135);
  assert.equal((db.prepare("SELECT placement FROM sessions WHERE id = 's1'").get() as any).placement, null);
  db.close();
});

test("ensureLocalHost is idempotent and puts back a deleted local row", () => {
  const db = new Database(":memory:");
  migrate(db);
  ensureLocalHost(db);
  assert.equal((db.prepare("SELECT COUNT(*) AS n FROM hosts").get() as any).n, 1);
  db.prepare("UPDATE hosts SET name = 'brain' WHERE id = 'local'").run();
  ensureLocalHost(db);
  assert.equal((db.prepare("SELECT name FROM hosts WHERE id = 'local'").get() as any).name, "brain", "never overwrites the row");
  db.prepare("DELETE FROM hosts").run();
  ensureLocalHost(db);
  assert.ok(db.prepare("SELECT 1 FROM hosts WHERE id = 'local'").get());
  db.close();
});
