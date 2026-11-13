/**
 * What `/` lists for a terminal, read off fixture profiles: skills, commands, plugins and MCP names at
 * user and project level — and, the part that is a security boundary, which links are NOT followed:
 * into another workspace's profile or repo, into the operator's private ~/.claude/plugins, or out of a
 * plugin's own directory. Nothing in an answer may carry a file's body.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { admits, cleanName, frontmatter, makeWalls, projectDirs, scanClaude, scanCodex, scanCursor, scanGrok, scanOpencode, type ClaudeScope, type SessionScope } from "./session-commands.js";

const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "mc-slash-")));
const home = path.join(tmp, "home");
const put = (p: string, body: string) => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, body); };
const link = (target: string, at: string) => { fs.mkdirSync(path.dirname(at), { recursive: true }); fs.symlinkSync(target, at); };
const skill = (dir: string, fm: string, body = "SECRET BODY never listed") => put(path.join(dir, "SKILL.md"), `---\n${fm}\n---\n${body}\n`);

// ── the operator's own ~/.claude: a shared skill, one linked in from ~/.agents, his private plugins ──
const op = path.join(home, ".claude");
skill(path.join(op, "skills", "shared-skill"), "name: shared-skill\ndescription: The operator's skill, linked into client profiles");
skill(path.join(home, ".agents", "skills", "agents-skill"), "name: agents-skill\ndescription: Lives in ~/.agents, linked from ~/.claude/skills");
link(path.join(home, ".agents", "skills", "agents-skill"), path.join(op, "skills", "agents-skill"));
skill(path.join(op, "plugins", "cache", "m", "private", "1.0.0", "skills", "op-private"), "name: op-private\ndescription: OPERATOR PRIVATE PLUGIN SKILL");
put(path.join(op, "commands", "op-cmd.md"), "---\ndescription: The operator's command\n---\nbody\n");

// ── another client's profile and repo: nothing of these may ever show for acme ──
const globex = path.join(home, ".claude-globex");
skill(path.join(globex, "skills", "globex-secret"), "name: globex-secret\ndescription: GLOBEX ONLY");
put(path.join(globex, "commands", "globex-cmd.md"), "---\ndescription: GLOBEX COMMAND\n---\n");
const globexRepo = path.join(tmp, "work", "globex-repo");
skill(path.join(globexRepo, ".claude", "skills", "globex-repo-skill"), "name: globex-repo-skill\ndescription: GLOBEX REPO SKILL");
skill(path.join(globex, "plugins", "cache", "m", "ghost", "1.0.0", "skills", "ghost-skill"), "name: ghost-skill\ndescription: GLOBEX PLUGIN");

// ── acme: a client profile, its repo, its plugin ──
const acme = path.join(home, ".claude-acme");
skill(path.join(acme, "skills", "own-skill"), "name: own-skill\ndescription: >\n  Folded across\n  two lines\nargument-hint: \"[file]\"");
skill(path.join(acme, "skills", "model-only"), "name: model-only\ndescription: Only Claude invokes this\nuser-invocable: false");
skill(path.join(acme, "skills", "dir-named"), "description: No name in frontmatter — the directory names it");
link(path.join(op, "skills", "shared-skill"), path.join(acme, "skills", "shared-skill")); // allowed: operator-shared
link(path.join(op, "skills", "agents-skill"), path.join(acme, "skills", "agents-skill")); // allowed: a shared entry's own link
link(path.join(globex, "skills", "globex-secret"), path.join(acme, "skills", "planted")); // another client's profile: never
link(path.join(op, "plugins", "cache", "m", "private", "1.0.0", "skills", "op-private"), path.join(acme, "skills", "op-private")); // his private plugins: never
link(path.join(globexRepo, ".claude", "skills", "globex-repo-skill"), path.join(acme, "skills", "repo-planted")); // another workspace's repo: never
put(path.join(acme, "commands", "deploy.md"), "---\ndescription: Deploy the thing\nargument-hint: <env>\n---\nbody\n");
put(path.join(acme, "commands", "frontend", "component.md"), "# Make a component\nbody\n");
link(path.join(acme, "commands"), path.join(acme, "commands", "loop")); // a link loop must not hang the scan
link(path.join(globex, "commands"), path.join(acme, "commands", "theirs"));
put(path.join(acme, ".claude.json"), JSON.stringify({ mcpServers: { fff: { command: "x", env: { TOKEN: "s3cr3t-value" } }, slack: { url: "https://x" } }, projects: {} }));
put(path.join(acme, "settings.json"), JSON.stringify({ env: { API_KEY: "s3cr3t-value" }, enabledPlugins: { "tools@m": true, "off@m": false, "ghost@m": true } }));
const tools = path.join(acme, "plugins", "cache", "m", "tools", "1.0.0");
put(path.join(tools, ".claude-plugin", "plugin.json"), JSON.stringify({ name: "tools", description: "Tools" }));
put(path.join(tools, "commands", "lint.md"), "---\ndescription: Lint it\n---\n");
skill(path.join(tools, "skills", "fmt"), "name: fmt\ndescription: Format it");
put(path.join(tools, ".mcp.json"), JSON.stringify({ mcpServers: { toolsrv: { command: "y" } } }));
link(path.join(globex, "commands", "globex-cmd.md"), path.join(tools, "commands", "escape.md")); // out of the plugin: never
put(path.join(acme, "plugins", "installed_plugins.json"), JSON.stringify({
  version: 2,
  plugins: {
    "tools@m": [{ scope: "user", installPath: tools, version: "1.0.0" }],
    "off@m": [{ scope: "user", installPath: tools, version: "1.0.0" }],
    // An install path in another profile: claude would load it, this list does not read it.
    "ghost@m": [{ scope: "user", installPath: path.join(globex, "plugins", "cache", "m", "ghost", "1.0.0"), version: "1.0.0" }],
  },
}));

const acmeRepo = path.join(tmp, "work", "acme-repo");
fs.mkdirSync(path.join(acmeRepo, ".git"), { recursive: true });
skill(path.join(acmeRepo, ".claude", "skills", "proj-skill"), "name: proj-skill\ndescription: The repo's own skill");
skill(path.join(acmeRepo, ".claude", "skills", "own-skill"), "name: own-skill\ndescription: PROJECT COPY — the personal one wins");
put(path.join(acmeRepo, ".claude", "commands", "ship.md"), "---\ndescription: Ship from the repo\n---\n");
link(path.join(globex, "skills", "globex-secret"), path.join(acmeRepo, ".claude", "skills", "outside"));
put(path.join(acmeRepo, ".mcp.json"), JSON.stringify({ mcpServers: { linear: { url: "https://x" }, muted: { url: "https://y" } } }));
fs.mkdirSync(path.join(acmeRepo, "packages", "web"), { recursive: true });

const scope = (over: Partial<ClaudeScope> = {}): ClaudeScope => ({
  home,
  profileDir: acme,
  project: projectDirs(path.join(acmeRepo, "packages", "web"), home),
  workspaceRoots: [acmeRepo],
  deny: [globexRepo, path.join(globex, "projects")],
  globalConfig: path.join(acme, ".claude.json"),
  mcpDeny: ["slack"],
  ...over,
});

test("frontmatter: plain, quoted, folded and literal scalars; a nested map never leaks into the next key", () => {
  assert.deepEqual(frontmatter("---\nname: a\ndescription: \"quoted: yes\"\n---\nbody"), { name: "a", description: "quoted: yes" });
  assert.equal(frontmatter("---\ndescription: >\n  one\n  two\nname: x\n---\n").description, "one two");
  assert.equal(frontmatter("---\ndescription: |\n  one\n  two\n---\n").description, "one\ntwo");
  assert.equal(frontmatter("---\ndescription: wraps\n  onto the next line\n---\n").description, "wraps onto the next line");
  const nested = frontmatter("---\nmetadata:\n  description: NOT TOP LEVEL\nname: n\n---\n");
  assert.equal(nested.description, undefined);
  assert.equal(nested.name, "n");
  assert.deepEqual(frontmatter("no fence here\nname: x"), {});
  assert.equal(frontmatter("﻿---\r\nname: crlf\r\n---\r\nbody").name, "crlf");
  assert.equal(frontmatter("---\ndescription: 'it''s'\n---\n").description, "it's");
});

test("cleanName keeps what can be typed after a slash and nothing else", () => {
  assert.equal(cleanName("review-pr"), "review-pr");
  assert.equal(cleanName("tools:lint"), "tools:lint");
  for (const bad of ["two words", "", "<b>x</b>", "a\nb", "-x", "x".repeat(101)]) assert.equal(cleanName(bad), null, bad);
});

test("projectDirs: the cwd up to its repository root, never $HOME", () => {
  assert.deepEqual(projectDirs(path.join(acmeRepo, "packages", "web"), home), [path.join(acmeRepo, "packages", "web"), path.join(acmeRepo, "packages"), acmeRepo]);
  assert.deepEqual(projectDirs(acmeRepo, home), [acmeRepo]);
  const loose = path.join(tmp, "loose", "dir");
  fs.mkdirSync(loose, { recursive: true });
  assert.deepEqual(projectDirs(loose, home), [loose], "no repository: the cwd alone");
  assert.deepEqual(projectDirs(home, home), [], "$HOME is the user level, not a project");
  assert.deepEqual(projectDirs(null, home), []);
});

test("a client profile lists its own skills, its project's and the operator's it links — named as claude names them", () => {
  const out = scanClaude(scope());
  const by = (g: string) => out.items.filter((i) => i.group === g).map((i) => i.name).sort();
  assert.deepEqual(by("skill"), ["agents-skill", "dir-named", "own-skill", "proj-skill", "shared-skill"]);
  const own = out.items.find((i) => i.name === "own-skill")!;
  assert.equal(own.desc, "Folded across two lines");
  assert.equal(own.hint, "[file]");
  assert.equal(own.from, "user", "defined at both levels: the personal one wins");
  assert.equal(own.insert, "/own-skill ");
  assert.equal(out.items.find((i) => i.name === "proj-skill")!.from, "project");
  assert.ok(!out.items.some((i) => i.name === "model-only"), "user-invocable: false is not on the menu");
  assert.deepEqual(by("command"), ["deploy", "frontend:component", "ship"], "a command in a subdirectory is /dir:name");
  assert.equal(out.items.find((i) => i.name === "frontend:component")!.desc, "Make a component", "no description: the first line of the body");
  assert.equal(out.items.find((i) => i.name === "deploy")!.hint, "<env>");
});

test("links that leave the walls are not followed: another client's profile and repo, the operator's private plugins", () => {
  const out = scanClaude(scope());
  const all = JSON.stringify(out);
  for (const leak of ["globex", "GLOBEX", "op-private", "OPERATOR PRIVATE", "planted", "outside", "theirs", "ghost", "escape"])
    assert.ok(!all.includes(leak), `"${leak}" must not reach acme's list: ${all}`);
  assert.ok(!all.includes("SECRET BODY"), "a skill's body is never listed");
  assert.ok(!all.includes("s3cr3t-value"), "a config value is never listed");
});

test("plugins: enabled ones only, namespaced, read from inside the profile; their MCP servers by name", () => {
  const out = scanClaude(scope());
  assert.deepEqual(out.plugins, ["tools"]);
  const p = out.items.filter((i) => i.group === "plugin");
  assert.deepEqual(p.map((i) => i.name).sort(), ["tools:fmt", "tools:lint"]);
  assert.ok(p.every((i) => i.from === "tools" && i.insert === `/${i.name} `));
  assert.deepEqual(out.mcp, ["fff", "linear", "muted", "toolsrv"], "slack is kept out of this workspace's terminals (desk.mcp_deny)");
});

test("a project server the operator turned off for that project is not listed", () => {
  const cfg = JSON.parse(fs.readFileSync(path.join(acme, ".claude.json"), "utf8"));
  cfg.projects[acmeRepo] = { mcpServers: { "local-one": { command: "z" } }, disabledMcpjsonServers: ["muted"] };
  put(path.join(acme, ".claude.json"), JSON.stringify(cfg));
  try {
    assert.deepEqual(scanClaude(scope()).mcp, ["fff", "linear", "local-one", "toolsrv"]);
  } finally {
    delete cfg.projects[acmeRepo];
    put(path.join(acme, ".claude.json"), JSON.stringify(cfg));
  }
});

test("the operator's own profile follows his links (~/.agents), and still not into another workspace's places", () => {
  link(path.join(globexRepo, ".claude", "skills", "globex-repo-skill"), path.join(op, "skills", "into-globex"));
  try {
    const out = scanClaude(scope({ profileDir: op, project: [], workspaceRoots: [], globalConfig: path.join(home, ".claude.json"), mcpDeny: [] }));
    const names = out.items.map((i) => i.name);
    assert.ok(names.includes("agents-skill") && names.includes("shared-skill") && names.includes("op-cmd"));
    assert.ok(!names.includes("globex-repo-skill"), "another workspace's repo stays walled even from the operator's home");
  } finally {
    fs.unlinkSync(path.join(op, "skills", "into-globex"));
  }
});

test("walls: a root that would open everything is dropped, and a deny entry holding the session's own place is too", () => {
  const w = makeWalls({ home, allow: ["/", home, tmp, acme], deny: [home, globexRepo], own: [acme] });
  assert.deepEqual(w.allow, [acme], "/, $HOME and anything above it are never roots");
  assert.deepEqual(w.deny, [globexRepo], "the sandbox re-grants its own places after the deny; so does the scan");
  assert.equal(admits(w, path.join(acme, "skills", "own-skill", "SKILL.md")), path.join(acme, "skills", "own-skill", "SKILL.md"));
  assert.equal(admits(w, path.join(acme, "skills", "planted", "SKILL.md")), null, "through a link: judged where it lands");
});

test("a profile with nothing in it lists nothing, and a missing one does not throw", () => {
  const empty = path.join(home, ".claude-empty");
  fs.mkdirSync(empty, { recursive: true });
  assert.deepEqual(scanClaude(scope({ profileDir: empty, project: [], globalConfig: path.join(empty, ".claude.json") })), { items: [], plugins: [], mcp: [] });
  assert.deepEqual(scanClaude(scope({ profileDir: path.join(home, ".claude-nope"), project: [], globalConfig: path.join(home, "nope.json") })).items, []);
});

test("settings: a skill turned off (skillOverrides) leaves the menu; a skill beats a command of the same name", () => {
  const settings = path.join(acme, "settings.json");
  const before = fs.readFileSync(settings, "utf8");
  put(settings, JSON.stringify({ ...JSON.parse(before), skillOverrides: { "dir-named": "off", "own-skill": "name-only" } }));
  put(path.join(acme, "commands", "proj-skill.md"), "---\ndescription: COMMAND SHADOWED BY A SKILL\n---\n");
  try {
    const names = scanClaude(scope()).items.map((i) => i.name);
    assert.ok(!names.includes("dir-named"), "off: hidden from the / menu");
    assert.ok(names.includes("own-skill"), "name-only only trims what the model is told");
    assert.ok(!JSON.stringify(scanClaude(scope())).includes("COMMAND SHADOWED"), "the skill is the one that runs");
  } finally {
    put(settings, before);
    fs.unlinkSync(path.join(acme, "commands", "proj-skill.md"));
  }
});

test("claude.ai synced skills: only the signed-in account's bucket, bare when free, namespaced when taken", () => {
  const cfgFile = path.join(acme, ".claude.json");
  const before = fs.readFileSync(cfgFile, "utf8");
  put(cfgFile, JSON.stringify({ ...JSON.parse(before), oauthAccount: { accountUuid: "acc-1", organizationUuid: "org-1", emailAddress: "someone@example.com" } }));
  skill(path.join(acme, "skills", "synced", "org-1_acc-1", "pdf"), "name: pdf\ndescription: Read and write PDFs");
  skill(path.join(acme, "skills", "synced", "org-1_acc-1", "compact"), "name: compact\ndescription: Collides with a built-in");
  skill(path.join(acme, "skills", "synced", "org-9_acc-9", "other-account"), "name: other-account\ndescription: ANOTHER ACCOUNT");
  try {
    const out = scanClaude(scope({ reserved: ["compact"] }));
    const synced = out.items.filter((i) => i.from === "claude.ai").map((i) => i.name).sort();
    assert.deepEqual(synced, ["anthropic-skills:compact", "pdf"]);
    const all = JSON.stringify(out);
    assert.ok(!all.includes("other-account") && !all.includes("org-1") && !all.includes("acc-1") && !all.includes("example.com"), all);
  } finally {
    put(cfgFile, before);
    fs.rmSync(path.join(acme, "skills", "synced"), { recursive: true, force: true });
  }
});

test("plugins: installed and never mentioned counts (defaultEnabled), a manifest's commands replace commands/, subfolders add a segment", () => {
  const p2 = path.join(acme, "plugins", "cache", "m", "dbkit", "2.0.0");
  put(path.join(p2, ".claude-plugin", "plugin.json"), JSON.stringify({ name: "db", commands: { about: { description: "What this kit does", argumentHint: "[topic]" } } }));
  put(path.join(p2, "commands", "ignored.md"), "---\ndescription: REPLACED BY THE MANIFEST\n---\n");
  const p3 = path.join(acme, "plugins", "cache", "m", "mig", "1.0.0");
  put(path.join(p3, "commands", "db", "migrate.md"), "---\ndescription: Run migrations\n---\n");
  const p4 = path.join(acme, "plugins", "cache", "m", "quiet", "1.0.0");
  put(path.join(p4, ".claude-plugin", "plugin.json"), JSON.stringify({ name: "quiet", defaultEnabled: false }));
  put(path.join(p4, "commands", "hush.md"), "---\ndescription: OFF BY DEFAULT\n---\n");
  const reg = path.join(acme, "plugins", "installed_plugins.json");
  const before = fs.readFileSync(reg, "utf8");
  const j = JSON.parse(before);
  j.plugins["dbkit@m"] = [{ scope: "user", installPath: p2 }];
  j.plugins["mig@m"] = [{ scope: "user", installPath: p3 }];
  j.plugins["quiet@m"] = [{ scope: "user", installPath: p4 }];
  j.plugins["elsewhere@m"] = [{ scope: "project", projectPath: path.join(tmp, "work", "some-other-repo"), installPath: p3 }];
  put(reg, JSON.stringify(j));
  try {
    const out = scanClaude(scope());
    const p = out.items.filter((i) => i.group === "plugin");
    assert.deepEqual(p.map((i) => i.name).sort(), ["db:about", "mig:db:migrate", "tools:fmt", "tools:lint"]);
    assert.equal(p.find((i) => i.name === "db:about")!.hint, "[topic]");
    assert.deepEqual(out.plugins.sort(), ["db", "mig", "tools"], "the manifest name is the namespace; a project install for another repo does not count");
    assert.ok(!JSON.stringify(out).includes("REPLACED") && !JSON.stringify(out).includes("OFF BY DEFAULT"));
  } finally {
    put(reg, before);
  }
});

// ── the other CLIs ──
const other = (over: Partial<SessionScope> = {}): SessionScope => ({ ...scope(), ...over });

test("codex: skills as $name from .agents/skills (project, then ~/.agents) and its home; no /prompts in 0.144.1; MCP from config.toml", () => {
  const ch = path.join(home, ".codex-acme");
  skill(path.join(acmeRepo, ".agents", "skills", "repo-agent"), "name: repo-agent\ndescription: In the repo");
  skill(path.join(home, ".agents", "skills", "agents-skill-2"), "name: agents-skill-2\ndescription: In ~/.agents");
  skill(path.join(ch, "skills", "home-skill"), "name: home-skill\ndescription: In CODEX_HOME");
  skill(path.join(ch, "skills", ".system", "skill-creator"), "name: skill-creator\ndescription: Bundled");
  put(path.join(ch, "prompts", "draftpr.md"), "---\ndescription: A prompt\n---\n");
  put(path.join(ch, "config.toml"), 'model = "x"\n[mcp_servers.docs]\ncommand = "d"\n[mcp_servers.docs.env]\nTOKEN = "s3cr3t-value"\n[mcp_servers."quoted-name"]\nurl = "u"\n');
  const out = scanCodex(other({ codexHome: ch, profileDir: ch }));
  const names = out.items.map((i) => i.name).sort();
  assert.deepEqual(names, ["agents-skill", "agents-skill-2", "home-skill", "repo-agent", "skill-creator"].sort());
  assert.ok(out.items.every((i) => i.group === "skill" && i.insert === `$${i.name} `), "codex skills are mentions, not slash commands");
  assert.equal(out.items.find((i) => i.name === "repo-agent")!.from, "project");
  assert.deepEqual(out.mcp, ["docs", "quoted-name"]);
  assert.ok(!JSON.stringify(out).includes("s3cr3t") && !JSON.stringify(out).includes("draftpr"));
});

test("cursor: .cursor/commands as /name (project, then its config dir) and skills from the dirs it reads; MCP from mcp.json", () => {
  const cd = path.join(home, ".cursor-acme");
  put(path.join(acmeRepo, ".cursor", "commands", "release.md"), "---\ndescription: Cut a release\n---\n");
  put(path.join(cd, "commands", "standup.md"), "# Write my standup\n");
  skill(path.join(acmeRepo, ".cursor", "skills", "cursor-skill"), "name: cursor-skill\ndescription: A cursor skill");
  put(path.join(cd, "mcp.json"), JSON.stringify({ mcpServers: { figma: { url: "u", headers: { Authorization: "s3cr3t-value" } } } }));
  const out = scanCursor(other({ cursorDir: cd }));
  const by = (g: string) => out.items.filter((i) => i.group === g).map((i) => i.name).sort();
  assert.deepEqual(by("command"), ["release", "standup"]);
  assert.ok(by("skill").includes("cursor-skill") && by("skill").includes("proj-skill"), "and the project's .claude/skills it reads too");
  assert.ok(!by("skill").includes("globex-secret"));
  assert.deepEqual(out.mcp, ["figma"]);
  assert.ok(!JSON.stringify(out).includes("s3cr3t"));
});

test("grok: flat commands (a subfolder is not read) and skills from .grok, the Claude dirs and .agents — skills win a shared name", () => {
  const gh = path.join(home, ".grok-test");
  put(path.join(gh, "commands", "ship-it.md"), "---\ndescription: Ship it\n---\n");
  put(path.join(gh, "commands", "nested", "deep.md"), "---\ndescription: NOT READ — commands are flat\n---\n");
  put(path.join(gh, "commands", "proj-skill.md"), "---\ndescription: LOSES TO THE SKILL\n---\n");
  skill(path.join(acmeRepo, ".grok", "skills", "grok-skill"), "name: grok-skill\ndescription: A grok skill");
  const out = scanGrok(other({ grokHome: gh, project: projectDirs(acmeRepo, home) }));
  const names = out.items.map((i) => i.name);
  for (const n of ["ship-it", "grok-skill", "proj-skill", "op-cmd", "shared-skill"]) assert.ok(names.includes(n), `${n} in ${names}`);
  const all = JSON.stringify(out);
  assert.ok(!all.includes("NOT READ") && !all.includes("LOSES TO THE SKILL") && !all.includes("globex"));
});

test("opencode: commands named by their path (/frontend/component), skills it reads, a command beating a skill; MCP from opencode.json", () => {
  const od = path.join(home, ".config", "opencode-test");
  put(path.join(od, "commands", "test.md"), "---\ndescription: Run the tests\n---\n");
  put(path.join(acmeRepo, ".opencode", "command", "frontend", "component.md"), "---\ndescription: A component\n---\n");
  put(path.join(od, "command", "proj-skill.md"), "---\ndescription: The command wins in opencode\n---\n");
  put(path.join(od, "opencode.json"), JSON.stringify({ mcp: { context7: { type: "remote", url: "u" } } }));
  const out = scanOpencode(other({ opencodeDir: od }));
  const by = (g: string) => out.items.filter((i) => i.group === g).map((i) => i.name).sort();
  assert.deepEqual(by("command"), ["frontend/component", "proj-skill", "test"]);
  assert.equal(out.items.find((i) => i.name === "frontend/component")!.insert, "/frontend/component ");
  assert.ok(!by("skill").includes("proj-skill"), "the command has the name");
  assert.ok(by("skill").includes("shared-skill"), "~/.claude/skills is one of the dirs it reads");
  assert.deepEqual(out.mcp, ["context7"]);
});

test("a client profile's CLI never reads the operator's ~/.codex; his own default profile does", () => {
  skill(path.join(home, ".codex", "skills", "op-codex-skill"), "name: op-codex-skill\ndescription: The operator's codex skill");
  const client = scanCursor(other({ cursorDir: path.join(home, ".cursor-acme") }));
  assert.ok(!client.items.some((i) => i.name === "op-codex-skill"), "walled for a client's profile (PR #114)");
  const mine = scanCursor(other({ profileDir: op, cursorDir: path.join(home, ".cursor-acme"), project: [], workspaceRoots: [] }));
  assert.ok(mine.items.some((i) => i.name === "op-codex-skill"));
});
