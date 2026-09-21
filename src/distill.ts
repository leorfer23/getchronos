import { tickets, workspaces, repos, jobs } from "./store.js";
import { dispatch } from "./dispatcher.js";

// Closed learning loop (Hermes-style): when a ticket ships, optionally spawn a READ-ONLY agent that
// distills a reusable skill from how the work was done. Opt-in per workspace (skill_distill). The
// distiller judges triviality itself — routine tickets produce no skill. New skills land `pending`
// (unless the workspace auto-publishes), so a human still gates what enters the vault.
export function maybeDistillSkill(ticketId: string): void {
  const t = tickets.get(ticketId);
  if (!t) return;
  const ws = workspaces.get(t.workspace_id);
  if (!ws || !ws.skill_distill) return;
  const repo = t.repo_id ? repos.get(t.repo_id) : undefined;
  const cwd = repo?.path;
  if (!cwd) return; // need a repo to inspect the diff

  const goal =
    `SKILL DISTILLATION (read-only — do NOT modify code). Ticket ${t.key} "${t.title}" just shipped.\n` +
    `Read it: \`mc ticket get ${t.key}\` (plan, work log, acceptance). Inspect what changed: \`git -C ${cwd} log -1 -p\` / \`git -C ${cwd} diff HEAD~1\`.\n\n` +
    `Decide: did this involve a NON-TRIVIAL, REPEATABLE procedure a future agent in this workspace would benefit from (a multi-step workflow, a non-obvious fix, a gotcha worth recording)? ` +
    `If it was routine/trivial, do NOTHING and stop.\n\n` +
    `If worth saving, first check existing skills (\`mc skill list\`): if a related one exists, IMPROVE it (\`mc skill patch <slug> --old "..." --new "..."\` or \`mc skill append <slug> ...\`) rather than duplicating. ` +
    `Otherwise create one:\n` +
    `  mc skill new --name "short-imperative-name" --description "search-style: when X, do Y" --category "<area>" <<'EOF'\n` +
    `  ## When to use\n  ...\n  ## Quick reference\n  ...\n  ## Procedure\n  1. ...\n  ## Pitfalls\n  - ...\n  ## Verification\n  - ...\n  EOF\n\n` +
    `Keep the description tight (it is ALL most agents will read). Capture the pitfalls you actually saw. Stay read-only; the skill lands pending for human approval.\n\n` +
    `Separately, record 0–3 durable FACTS you learned about this repo, the company's conventions, or the operator's preferences (NOT procedures — those are skills) via \`mc learn "<fact>"\`. Skip anything obvious or transient.`;

  const job = jobs.create({
    name: `distill:${t.key}`,
    description: `Distill skill from ${t.title}`,
    goal,
    workspace_id: ws.id,
    ticket_id: t.id,
    backend: ws.review_backend || ws.default_backend,
    model: ws.review_model || ws.default_model || undefined,
    cwd,
    sandbox: ws.sandbox_mode,
    disallowed_tools: "Edit,Write,MultiEdit,NotebookEdit",
    trigger_type: "manual",
  });
  dispatch(job.id, `distill:${t.key}`);
}
