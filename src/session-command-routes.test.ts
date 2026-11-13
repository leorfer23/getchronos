/**
 * GET /api/sessions/:id/commands, asked of the running API: the operator and the workspace that owns the
 * terminal get its list; another workspace — or that workspace's Robert — gets the 404 an unknown id
 * gets; no token at all gets 401. And what comes back is names and descriptions, never a path or a body.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";

const PORT = await new Promise<number>((resolve) => {
  const s = net.createServer();
  s.listen(0, "127.0.0.1", () => { const p = (s.address() as net.AddressInfo).port; s.close(() => resolve(p)); });
});
process.env.CHRONOS_PORT = String(PORT);

const { startServer } = await import("./api.js");
const { CONFIG } = await import("./config.js");
const { robertToken } = await import("./authz.js");
const { sessions, workspaces } = await import("./store.js");
const { clearCommandsCache, modelNow } = await import("./session-command-routes.js");

const base = `http://127.0.0.1:${PORT}/api`;
let server: any;
before(() => { server = startServer(); });
after(() => { server?.close?.(); });

const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "mc-cmds-")));
const put = (p: string, body: string) => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, body); };
const skill = (dir: string, name: string, desc: string) => put(path.join(dir, "SKILL.md"), `---\nname: ${name}\ndescription: ${desc}\n---\nTHE BODY OF ${name}\n`);

const cfgA = path.join(tmp, "profiles", ".claude-acme");
skill(path.join(cfgA, "skills", "acme-skill"), "acme-skill", "Acme's own skill");
put(path.join(cfgA, "commands", "ops", "deploy.md"), "---\ndescription: Deploy acme\n---\n");
put(path.join(cfgA, ".claude.json"), JSON.stringify({ mcpServers: { acmesrv: { command: "x", env: { TOKEN: "s3cr3t" } } } }));
const repoA = path.join(tmp, "work", "acme");
fs.mkdirSync(path.join(repoA, ".git"), { recursive: true });
skill(path.join(repoA, ".claude", "skills", "repo-skill"), "repo-skill", "In acme's repo");
const cfgB = path.join(tmp, "profiles", ".claude-initech");
skill(path.join(cfgB, "skills", "initech-skill"), "initech-skill", "INITECH ONLY");

const A = workspaces.create({ slug: `cm-a-${Date.now()}`, name: "Acme", config_dir: cfgA, default_dir: repoA } as any);
const B = workspaces.create({ slug: `cm-b-${Date.now()}`, name: "Initech", config_dir: cfgB } as any);
const sA = sessions.create({ workspace_id: A.id, cwd: repoA, backend: "claude-code", model: "opus" } as any);
const sB = sessions.create({ workspace_id: B.id, cwd: tmp, backend: "claude-code" } as any);
const json = { "content-type": "application/json" };
const as = {
  operator: { ...json, "x-mc-admin": CONFIG.adminToken },
  A: { ...json, "x-mc-workspace-token": workspaces.get(A.id)!.token },
  B: { ...json, "x-mc-workspace-token": workspaces.get(B.id)!.token },
  robertA: { ...json, "x-mc-admin": robertToken(A.id) },
  robertB: { ...json, "x-mc-admin": robertToken(B.id) },
  nobody: json,
};

async function get(p: string, headers: Record<string, string>) {
  const r = await fetch(base + p, { headers });
  let body: any = null;
  try { body = await r.json(); } catch {}
  return { status: r.status, body };
}

test("the operator, the owning workspace and its own Robert get the list; another workspace and its Robert get a 404; nobody gets 401", async () => {
  clearCommandsCache();
  const p = `/sessions/${sA.id}/commands`;
  const missing = await get("/sessions/00000000-0000-0000-0000-000000000000/commands", as.B);
  assert.equal(missing.status, 404);
  for (const who of ["B", "robertB"] as const) {
    const r = await get(p, as[who]);
    assert.equal(r.status, 404, `${who}: ${r.status} ${JSON.stringify(r.body)}`);
    assert.deepEqual(r.body, missing.body, `${who}: the same answer an unknown id gets`);
  }
  assert.equal((await get(p, as.nobody)).status, 401);
  for (const who of ["operator", "A", "robertA"] as const) assert.equal((await get(p, as[who])).status, 200, who);
  assert.equal((await get(`/sessions/${sB.id}/commands`, as.A)).status, 404, "and the other way round");
});

test("what comes back: the CLI's built-ins, the profile's and the repo's skills and commands, MCP names — no path, body or value", async () => {
  clearCommandsCache();
  const { body } = await get(`/sessions/${sA.id}/commands`, as.A);
  assert.equal(body.backend, "claude-code");
  assert.equal(body.cli.label, "Claude Code");
  assert.match(body.cli.docs, /^https:\/\//);
  assert.equal(body.model, "opus");
  assert.equal(body.switch_model, "/model {model}");
  assert.ok(body.models.includes("sonnet"));
  assert.equal(body.profile, "claude-acme");
  const names = body.items.map((i: any) => `${i.group}:${i.name}`);
  for (const n of ["builtin:compact", "skill:acme-skill", "skill:repo-skill", "command:ops:deploy"]) assert.ok(names.includes(n), `${n} in ${names}`);
  assert.ok(!names.includes("builtin:loop"), "lean Desk terminals have no session cron");
  assert.deepEqual(body.mcp, ["acmesrv"]);
  const all = JSON.stringify(body);
  for (const leak of [tmp, "THE BODY", "s3cr3t", "INITECH"]) assert.ok(!all.includes(leak), `"${leak}" leaked: ${all.slice(0, 400)}`);
});

test("a terminal on another computer lists its CLI's own commands only, and says why", async () => {
  clearCommandsCache();
  const remote = sessions.create({ workspace_id: A.id, cwd: "/srv/acme", backend: "claude-code", host_id: "m2" } as any);
  const { status, body } = await get(`/sessions/${remote.id}/commands`, as.operator);
  assert.equal(status, 200);
  assert.ok(body.items.length && body.items.every((i: any) => i.group === "builtin"));
  assert.equal(body.notes.length, 1);
});

test("the model shown is the one the transcript last answered with, so a /model switch shows", () => {
  assert.equal(modelNow({ id: "x", backend: "claude-code", model: "opus" }, ["claude-opus-5-5", "claude-sonnet-5"]), "sonnet");
  assert.equal(modelNow({ id: "x", backend: "claude-code", model: "opus" }, []), "opus", "nothing answered yet: the one it opened with");
  assert.equal(modelNow({ id: "x", backend: "grok", model: "grok-4.5" }, ["claude-opus-5-5"]), "grok-4.5", "only claude reads its transcript");
});
