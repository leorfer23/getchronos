import { test } from "node:test";
import assert from "node:assert/strict";
import { db, workspaces, repos, repoAccelerators } from "../store.js";
import { agentContext } from "../skills.js";
import { formatDoneCriteria } from "../tickets.js";

/**
 * The zero-prompt-tax boundary is real code, not a stub. An earlier version of this PR "proved"
 * zero tax with an uncalled `accelPromptBlock()` that always returned "" — that only proves an
 * unused function returns "", not that agent context is unaffected. A source-text regex check
 * (grepping tickets.ts/agent-defs.ts for "accel") was tried next and is also weak: it says nothing
 * once real integration lands and legitimately adds an accelerator reference somewhere in that text.
 *
 * This instead calls the two REAL functions that inject content into what an agent actually sees:
 * - `agentContext(workspace_id, repo_id)` (src/skills.ts) — the standing context folded into every
 *   agent's system prompt for a workspace/repo (used by both runner.ts and terminal.ts).
 * - `formatDoneCriteria(repo)` (src/tickets.ts) — the per-repo Definition-of-Done block folded into
 *   every build/review ticket's goal.
 * Enabling every accelerator for the repo must change neither. If a future integration PR wires
 * accelerators into either surface, this test's failure is the deliberate, reviewed signal that the
 * zero-tax boundary moved — not a silent drift.
 */

test("enabling every accelerator for a repo does not change agentContext()'s output", () => {
  db.exec("DELETE FROM repo_accelerators; DELETE FROM repos; DELETE FROM workspaces;");
  const wsId = workspaces.create({ slug: "acme", name: "Acme", config_dir: "/tmp/acme" }).id;
  const repo = repos.create({ workspace_id: wsId, name: "r", path: "/tmp/r" });

  const before = agentContext(wsId, repo.id);
  repoAccelerators.setEnabled(wsId, repo.id, "graphify", true, "code-only");
  repoAccelerators.setEnabled(wsId, repo.id, "ast-grep", true);
  repoAccelerators.setEnabled(wsId, repo.id, "repomix", true);
  const after = agentContext(wsId, repo.id);

  assert.equal(after, before);
});

test("enabling every accelerator for a repo does not change formatDoneCriteria()'s output", () => {
  db.exec("DELETE FROM repo_accelerators; DELETE FROM repos; DELETE FROM workspaces;");
  const wsId = workspaces.create({ slug: "acme", name: "Acme", config_dir: "/tmp/acme" }).id;
  const repo = repos.create({
    workspace_id: wsId, name: "r", path: "/tmp/r",
    done_criteria: "- [ ] tests pass", human_gate: "high",
  });

  const before = formatDoneCriteria(repo);
  repoAccelerators.setEnabled(wsId, repo.id, "graphify", true, "code-only");
  repoAccelerators.setEnabled(wsId, repo.id, "ast-grep", true);
  repoAccelerators.setEnabled(wsId, repo.id, "repomix", true);
  const after = formatDoneCriteria(repo);

  assert.equal(after, before);
});
