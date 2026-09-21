import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { AGENTS_DIR, agentDef, agentPrompt, loadAgents, loadAgentsFrom } from "./agent-defs.js";

// ── the real agents/ tree ────────────────────────────────────────────────────────────────────────

test("every agent directory loads", () => {
  const agents = loadAgents();
  for (const id of ["robert", "lead"]) {
    assert.ok(agents.has(id), `missing agents/${id}/`);
    assert.ok(agents.get(id)!.name, `agents/${id} has no name`);
    assert.ok(agents.get(id)!.description, `agents/${id} has no description`);
  }
});

// LEADS.md: openSession folds this into a Lead's system prompt ahead of FOCUS_CONTRACT (terminal.ts).
// A missing surface or a stray unresolved include would throw at spawn time instead of load time.
test("agentPrompt(\"lead\") renders, reusing wall-hands for its hands", () => {
  const p = agentPrompt("lead");
  assert.match(p, /LEAD for one goal/);
  assert.match(p, /HOW YOU USE THE HANDS/); // {{> wall-hands}}
  assert.ok(!p.includes("{{"), "unresolved placeholder in the Lead persona");
});

// An `_`-prefixed directory is how you park an executive: keep the persona, make it unloadable. If
// one ever loaded again it would be spawnable — and reachable from every seam that takes an agent
// id — without anyone deciding to bring it back.
test("an _-prefixed agent directory does not load", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mc-agents-"));
  for (const id of ["live", "_parked"]) {
    fs.mkdirSync(path.join(dir, id));
    fs.writeFileSync(path.join(dir, id, "AGENT.md"), `---\nname: ${id}\ndescription: fixture\n---\nbody\n`);
  }
  assert.deepEqual([...loadAgentsFrom(dir).keys()], ["live"]);
});

// A placeholder that survives into a composed prompt is a live agent reading "{{prot}}" as an
// instruction. interpolate() throws on unknown names, so this catches the other half: a well-formed
// placeholder nobody expanded because it sat inside a block that was never included.
// Digit-led {{0.id}} / {{1.key}} are intentional — they document Telegram PROPOSE batch prior-item
// refs (PER-16), which interpolate() deliberately does not expand (VAR_RE requires a letter start).
test("no composed prompt contains an unresolved placeholder", () => {
  const batchRef = /^\{\{\d+\.[A-Za-z_][A-Za-z0-9_]*\}\}$/;
  for (const [id, def] of loadAgents()) {
    for (const [surface, prompt] of Object.entries(def.surfaces)) {
      for (const m of prompt.match(/\{\{[^}]*\}\}/g) ?? []) {
        assert.match(m, batchRef, `agents/${id} surface "${surface}" has an unexpanded ${m}`);
      }
      assert.ok(!prompt.includes("<!--"), `agents/${id} surface "${surface}" leaked an HTML comment`);
    }
  }
});

// The half the test above missed — and the half that is EXECUTED rather than read. A placeholder
// left in a prompt makes an agent say something odd; one left in `env` made an executive spawn with
// PATH=~/.mc/bin:{{env.PATH}}, and every run of hers died with
// `sandbox-exec: execvp() of 'claude' failed: No such file or directory`.
test("no declared env value contains an unresolved placeholder", () => {
  for (const [id, def] of loadAgents())
    for (const [k, v] of Object.entries(def.env))
      assert.ok(!v.includes("{{"), `agents/${id} env.${k} kept an unexpanded placeholder: ${v}`);
});

test("a placeholder name may carry uppercase, and an unknown one still throws", () => {
  const root = fixture({
    "zed/AGENT.md": `---\nname: T\ndescription: d\nenv:\n  PATH: "{{home}}/.mc/bin:{{env.PATH}}"\n---\n\nbody\n`,
  });
  const def = loadAgentsFrom(root).get("zed")!;
  assert.equal(def.env.PATH, `${os.homedir()}/.mc/bin:${process.env.PATH}`);

  // The case fix must not turn the guard off: a name that isn't in the closed list still throws,
  // whatever its case.
  const typo = fixture({ "zed/AGENT.md": `---\nname: T\ndescription: d\nenv:\n  X: "{{env.Path}}"\n---\n\nbody\n` });
  assert.throws(() => loadAgentsFrom(typo), /unknown placeholder \{\{env\.Path\}\}/);
});

test("robert has the two authority surfaces and no default", () => {
  const def = agentDef("robert");
  assert.deepEqual(Object.keys(def.surfaces).sort(), ["telegram", "web"]);
  assert.throws(() => agentPrompt("robert"), /no surface "default"/);
});

// The whole point of _blocks/: Telegram and web must describe the SAME API, so the catalogs cannot
// drift the way two copies of the prose would.
test("robert's surfaces share the mutation catalog and differ only in authority", () => {
  const tg = agentPrompt("robert", "telegram");
  const web = agentPrompt("robert", "web");
  const catalog = fs.readFileSync(path.join(AGENTS_DIR, "_blocks", "mut-endpoints.md"), "utf8").slice(0, 200);
  assert.ok(tg.includes(catalog), "telegram surface lost the mutation catalog");
  assert.ok(web.includes(catalog), "web surface lost the mutation catalog");
  // Telegram proposes and waits for a tap; the desk holds the admin token and acts.
  assert.ok(tg.includes("PROPOSE {"), "telegram surface lost the PROPOSE protocol");
  assert.ok(!tg.includes("x-mc-admin: $CHRONOS_ADMIN"), "telegram surface must not be told to mutate directly");
  assert.ok(web.includes("x-mc-admin: $CHRONOS_ADMIN"), "web surface lost its execute-directly instruction");
});

test("robert's memory key is his id", () => {
  assert.equal(agentDef("robert").memory, "robert");
});

// ── parsing, against fixtures ────────────────────────────────────────────────────────────────────

function fixture(files: Record<string, string>): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agent-defs-"));
  for (const [rel, body] of Object.entries(files)) {
    const p = path.join(root, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, body);
  }
  return root;
}

const MINIMAL = "---\nname: T\ndescription: d\n---\n\nbody\n";

test("frontmatter drives the knobs; the directory name is the id", () => {
  const root = fixture({
    "zed/AGENT.md": `---\nname: Zed\ndescription: a test agent\nmodel: opus\ntools: "Bash,Read"\nsandbox: strict\ncwd: "{{home}}/x"\nenv:\n  A: "{{port}}"\n---\n\nhello\n`,
  });
  const def = loadAgentsFrom(root).get("zed")!;
  assert.equal(def.id, "zed");
  assert.equal(def.model, "opus");
  assert.equal(def.sandbox, "strict");
  assert.equal(def.cwd, `${os.homedir()}/x`);
  assert.match(def.env.A, /^\d+$/);
  assert.equal(def.surfaces.default, "\nhello\n");
});

// A bundle resolves to JSON with the placeholders already gone, because what reaches the CLI is the
// string itself — a `{{repo}}` that survived would be a path no machine has, and the CLI's answer to
// an unusable --mcp-config is silence plus an executive with no browser.
test("mcp: names a bundle in _mcp/, interpolated", () => {
  const root = fixture({
    "_mcp/kit.json": `{"mcpServers":{"k":{"command":"node","args":["{{repo}}/x.js","{{home}}/out"]}}}`,
    "zed/AGENT.md": "---\nname: T\ndescription: d\nmcp: kit\n---\n\nb\n",
  });
  const def = loadAgentsFrom(root).get("zed")!;
  const cfg = JSON.parse(def.mcp!);
  assert.equal(cfg.mcpServers.k.args[1], `${os.homedir()}/out`);
  assert.ok(!def.mcp!.includes("{{"), `placeholder survived: ${def.mcp}`);
  assert.equal(loadAgentsFrom(fixture({ "zed/AGENT.md": MINIMAL })).get("zed")!.mcp, null);
});

// One executive browsed, and its bundle had to agree with its allowlist — a
// declared server whose tools aren't allowed is dead weight. No live agent declares one now, so what
// is left to pin is the rule itself, against whoever declares the next bundle.
test("a declared mcp bundle agrees with the tool allowlist", () => {
  for (const [id, def] of loadAgents()) {
    if (!def.mcp) continue;
    assert.match(def.tools ?? "", /\bmcp__/, `agents/${id} declares an mcp bundle but allows no mcp__ tool`);
  }
});

test("extra .md files become named surfaces", () => {
  const root = fixture({ "zed/AGENT.md": MINIMAL, "zed/web.md": "web prompt\n" });
  const def = loadAgentsFrom(root).get("zed")!;
  assert.deepEqual(Object.keys(def.surfaces).sort(), ["default", "web"]);
  assert.equal(def.surfaces.web, "web prompt\n");
});

test("an include pulls the block in verbatim, newline and all", () => {
  const root = fixture({
    "_blocks/shared.md": "SHARED LINE\n\n",
    "zed/AGENT.md": `---\nname: T\ndescription: d\n---\n{{> shared}}\ntail\n`,
  });
  assert.equal(loadAgentsFrom(root).get("zed")!.surfaces.default, "SHARED LINE\n\ntail\n");
});

test("a body of nothing but commentary is an empty body", () => {
  const root = fixture({
    "zed/AGENT.md": `---\nname: T\ndescription: d\n---\n\n<!-- just notes -->\n`,
    "zed/only.md": "the prompt\n",
  });
  assert.deepEqual(Object.keys(loadAgentsFrom(root).get("zed")!.surfaces), ["only"]);
});

test("malformed definitions fail loudly", () => {
  const cases: Array<[string, Record<string, string>, RegExp]> = [
    ["no frontmatter", { "zed/AGENT.md": "just a body\n" }, /missing --- frontmatter/],
    ["no name", { "zed/AGENT.md": "---\ndescription: d\n---\n\nb\n" }, /missing "name"/],
    ["bad sandbox", { "zed/AGENT.md": "---\nname: T\ndescription: d\nsandbox: loose\n---\n\nb\n" }, /sandbox must be/],
    ["unknown block", { "zed/AGENT.md": "---\nname: T\ndescription: d\n---\n{{> nope}}\n" }, /unknown block/],
    ["unknown placeholder", { "zed/AGENT.md": "---\nname: T\ndescription: d\n---\n\n{{prot}}\n" }, /unknown placeholder/],
    ["no prompt at all", { "zed/AGENT.md": "---\nname: T\ndescription: d\n---\n\n" }, /no prompt/],
    ["stray indent", { "zed/AGENT.md": "---\nname: T\ndescription: d\n  oops: 1\n---\n\nb\n" }, /outside env:/],
    ["missing mcp bundle", { "zed/AGENT.md": "---\nname: T\ndescription: d\nmcp: nope\n---\n\nb\n" }, /no MCP bundle/],
    ["mcp path traversal", { "zed/AGENT.md": "---\nname: T\ndescription: d\nmcp: ../../etc\n---\n\nb\n" }, /must be a bundle name/],
    ["mcp bad json", {
      "_mcp/kit.json": "{ not json",
      "zed/AGENT.md": "---\nname: T\ndescription: d\nmcp: kit\n---\n\nb\n",
    }, /invalid JSON/],
    ["mcp with no servers", {
      "_mcp/kit.json": '{"mcpServers":{}}',
      "zed/AGENT.md": "---\nname: T\ndescription: d\nmcp: kit\n---\n\nb\n",
    }, /no "mcpServers" entries/],
  ];
  for (const [label, files, re] of cases) {
    assert.throws(() => loadAgentsFrom(fixture(files)), re, label);
  }
});

// A persona file must not be able to name an arbitrary env var and read the daemon's secrets into a
// model's context: the interpolation table is a closed list, and unknown names throw.
test("placeholders cannot reach arbitrary env vars", () => {
  process.env.CHRONOS_TEST_SECRET = "s3cret";
  const root = fixture({ "zed/AGENT.md": "---\nname: T\ndescription: d\n---\n\n{{env.CHRONOS_TEST_SECRET}}\n" });
  // The guarantee is the closed list in vars(), NOT the case of the pattern — relying on uppercase
  // never matching is what left `{{env.PATH}}` unexpanded in a live agent's PATH. A name outside the
  // list now fails loudly at load, which is the stronger half of the same property.
  try {
    assert.throws(
      () => loadAgentsFrom(root),
      (e: Error) => {
        assert.match(e.message, /unknown placeholder \{\{env\.CHRONOS_TEST_SECRET\}\}/);
        // The message names the placeholder; quoting the VALUE would put the secret in a log.
        assert.ok(!e.message.includes("s3cret"), "the error must not quote the value");
        return true;
      },
    );
  } finally {
    delete process.env.CHRONOS_TEST_SECRET;
  }
});
