#!/usr/bin/env node
/**
 * Snapshot real tickets out of the live DB into evals/cases/*.json.
 *
 * The evals replay these fixtures, not the database: a check that reads ~/chronos/chronos.db would
 * pass or fail depending on what the fleet happened to be doing that morning, and would not run at
 * all on another machine. Re-run this when a real ticket exercises a shape the corpus is missing.
 *
 *   node scripts/export-eval-cases.mjs PER-4 PER-3 ACM-95
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";

const keys = process.argv.slice(2);
if (!keys.length) {
  console.error("usage: export-eval-cases.mjs <TICKET-KEY> [...]");
  process.exit(1);
}

const dbPath = process.env.CHRONOS_DB || path.join(os.homedir(), "chronos", "chronos.db");
const db = new Database(dbPath, { readonly: true });
const outDir = path.join(path.dirname(new URL(import.meta.url).pathname), "..", "evals", "cases");
fs.mkdirSync(outDir, { recursive: true });

for (const key of keys) {
  const t = db.prepare("select * from tickets where key = ?").get(key);
  if (!t) {
    console.error(`skip ${key}: not found`);
    continue;
  }
  const ws = db.prepare("select * from workspaces where id = ?").get(t.workspace_id);
  const repo = t.repo_id ? db.prepare("select * from repos where id = ?").get(t.repo_id) : null;
  const reviews = db
    .prepare("select state, notes from reviews where ticket_id = ? and state = 'changes_requested' and notes is not null order by rowid")
    .all(t.id);

  // The ticket body is a file on disk, and it is most of what the agent is told to read.
  let body = "";
  try {
    body = fs.readFileSync(t.file_path, "utf8");
  } catch {
    console.error(`  ${key}: body file missing (${t.file_path}) — exporting without it`);
  }

  const kase = {
    name: `${key} — ${t.title}`,
    workspace: {
      name: ws.name,
      default_backend: ws.default_backend,
      default_model: ws.default_model,
      sandbox_mode: ws.sandbox_mode,
      route_config: ws.route_config,
    },
    repo: repo && {
      name: repo.name,
      default_branch: repo.default_branch,
      delivery: repo.delivery,
      human_gate: repo.human_gate,
      done_criteria: repo.done_criteria,
      gate_cmds: repo.gate_cmds,
    },
    ticket: {
      title: t.title,
      priority: t.priority,
      complexity: t.complexity,
      tags: t.tags,
      body,
    },
    reviews,
  };

  const file = path.join(outDir, `${key}.json`);
  fs.writeFileSync(file, JSON.stringify(kase, null, 2) + "\n");
  console.log(`${key} -> evals/cases/${key}.json  (repo: ${repo?.name ?? "none"}, rework rounds: ${reviews.length})`);
}
