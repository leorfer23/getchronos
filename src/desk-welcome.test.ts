/**
 * The Desk's first-run welcome (static/desk-welcome.js): its decisions, lifted out of the page and run
 * in a vm (no document → the file hands back only its pure half).
 *
 * What it guards: it shows only to a brand-new Desk (not done AND no project); a CLI row says the one
 * thing to do about it — Test, Sign in, Install (with the "you already pay for the app" wording) or the
 * command to paste; Continue needs one agent that works; the project's slug, folder name and backend;
 * the parity line in every shape it may arrive in; server errors in plain words; and a hello short
 * enough to read in a breath, whose chips are messages (and one guide link).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";

const ctx: any = { window: {} };
vm.runInNewContext(fs.readFileSync(path.join(process.cwd(), "static/desk-welcome.js"), "utf8"), ctx);
const W = ctx.window.DeskWelcome;
const plain = (v: unknown) => JSON.parse(JSON.stringify(v));

const cli = (o: Record<string, unknown>) => ({
  id: "claude", label: "Claude Code", backend: "claude-code", installed: true, version: "2.1.322", loggedIn: true,
  authDetail: "claude.ai subscription", install: "curl -fsSL https://claude.ai/install.sh | bash", login: "claude auth login",
  app: false, can_install: true, ...o,
});

test("it shows once, to a brand-new Desk: not done and no project", () => {
  assert.equal(W.shouldShow(false, 0), true);
  assert.equal(W.shouldShow(true, 0), false, "finished or skipped: never again");
  assert.equal(W.shouldShow(false, 1), false, "someone already set a project up");
  assert.equal(W.shouldShow(undefined, 0), false, "an older daemon that cannot say");
  assert.deepEqual(plain(W.STEPS), ["name", "agents", "project", "phone", "meet"]);
});

test("each CLI row is one state with one thing to do", () => {
  assert.equal(W.cliState(cli({})), "ready");
  assert.equal(W.cliState(cli({ loggedIn: null })), "ready", "can't tell: Test says for sure");
  assert.equal(W.cliState(cli({ loggedIn: false })), "signin");
  assert.equal(W.cliState(cli({ installed: false, loggedIn: null })), "install");
  assert.equal(W.cliState(cli({ installed: false, can_install: false })), "missing");
  assert.equal(W.cliLine(cli({})), "2.1.322 · claude.ai subscription");
  assert.equal(W.cliLine(cli({ loggedIn: false })), "Installed — not signed in yet");
  assert.equal(W.cliLine(cli({ installed: false, app: true })), "You use Claude — install Claude Code, it runs on the same subscription");
  assert.equal(W.cliLine(cli({ id: "codex", label: "Codex (ChatGPT)", installed: false, app: true })), "You use ChatGPT — install Codex, it runs on the same subscription");
  assert.equal(W.cliLine(cli({ installed: false })), "Not installed");
  assert.match(W.cliLine(cli({ installed: false, can_install: false })), /paste this in a terminal/);
});

test("Claude Code and Codex always show; the rest fold away unless installed or their app is here", () => {
  const rows = W.cliRows([
    cli({}), cli({ id: "codex", installed: false, loggedIn: null }), cli({ id: "cursor-agent", installed: false }),
    cli({ id: "grok", installed: true, loggedIn: false }), cli({ id: "opencode", installed: false, app: false }),
  ]);
  assert.deepEqual(plain(rows.shown.map((c: any) => c.id)), ["claude", "codex", "grok"]);
  assert.deepEqual(plain(rows.more.map((c: any) => c.id)), ["cursor-agent", "opencode"]);
  assert.deepEqual(plain(rows.ready.map((c: any) => c.id)), ["claude"], "one that works is what Continue needs");
  assert.equal(W.cliRows([cli({ id: "cursor-agent", installed: false, app: true })]).shown.length, 1, "Cursor's app is here: offer it");
});

test("the first project opens on Claude Code when it works, else on the CLI that does", () => {
  assert.equal(W.preferredBackend([cli({ id: "codex", backend: "codex" }), cli({})]), "claude-code");
  assert.equal(W.preferredBackend([cli({ loggedIn: false }), cli({ id: "codex", backend: "codex" })]), "codex");
  assert.equal(W.preferredBackend([cli({ installed: false })]), null, "nothing works: the daemon's default");
});

test("slug and name: from what was typed, plain and short", () => {
  assert.equal(W.slugify("My App"), "my-app");
  assert.equal(W.slugify("Café Société!!"), "cafe-societe");
  assert.equal(W.slugify("  --  "), "project");
  assert.equal(W.slugify("x".repeat(60)).length, 40);
  assert.equal(W.baseName("~/code/my-app/"), "my-app");
  assert.equal(W.baseName("/Users/operator/work/globex"), "globex");
  assert.equal(W.baseName("~"), "");
  assert.equal(W.cleanName("  Ada   O’Neil "), "Ada O'Neil");
});

test("the parity line reads GET /api/setup/parity (src/parity.ts): the default profile only, the right fix", () => {
  const prof = (o: Record<string, unknown>) => ({ profile: "claude", dir: "/Users/operator/.claude", default: true, mode: "own", missing: [], extra: [], conflicts: [], notes: [], ...o });
  const report = (o: Record<string, unknown> = {}) => ({
    ok: true, lines: [], fixes: [],
    claude: { profiles: [prof({})], desktop: { config: null, servers: [], importable: [], alreadyThere: [], conflicts: [], invalid: [], extensions: [] } },
    codex: { profiles: [prof({ profile: "claude", dir: "/Users/operator/.codex" })] },
    ...o,
  });
  assert.equal(W.parityLine(null), null);
  assert.equal(W.parityLine({ clis: [] }), null, "an older or unknown shape says nothing");
  assert.deepEqual(plain(W.parityLine(report())), { count: 0, fix: [], subs: "Claude / ChatGPT" });
  assert.equal(W.parityLine(report({ codex: { profiles: [] } })).subs, "Claude", "no Codex here: only Claude is named");
  // Agents on a separate copy that lacks two servers; a client profile lacks one too — never auto-fixed.
  const separate = report({
    ok: false,
    claude: {
      profiles: [prof({ mode: "separate", missing: ["dart", "thoughtspot"] }), prof({ profile: "claude-acme", default: false, mode: "separate", missing: ["jira"] })],
      desktop: { config: "/x", servers: ["notion"], importable: ["notion"], alreadyThere: [], conflicts: [], invalid: [], extensions: [] },
    },
    fixes: [
      { id: "claude-own-home", label: "Give agents your own Claude Code setup (2 MCP servers they lack: dart, thoughtspot)" },
      { id: "claude-bring-over:claude", label: "Copy your 2 MCP servers into the agents' separate setup" },
      { id: "claude-bring-over:claude-acme", label: "Copy your MCP servers into claude-acme (jira)" },
      { id: "claude-desktop-import", label: "Add 1 Claude Desktop server to the agents' Claude Code setup (notion)" },
    ],
  });
  assert.deepEqual(plain(W.parityLine(separate)), { count: 3, fix: ["claude-own-home", "claude-desktop-import"], subs: "Claude / ChatGPT" });
  // Signed out of his own Claude Code: no switch on offer, so the agents' copy gets the servers.
  const signedOut = { ...separate, fixes: separate.fixes.filter((f) => f.id !== "claude-own-home") };
  assert.deepEqual(plain(W.parityLine(signedOut).fix), ["claude-bring-over:claude", "claude-desktop-import"]);
  // A separate copy with nothing missing still has a fix (his skills, plugins and CLAUDE.md); no fix → nothing to say.
  const copy = report({ ok: false, claude: { profiles: [prof({ mode: "separate" })], desktop: report().claude.desktop }, fixes: [{ id: "claude-own-home", label: "Give agents your own Claude Code setup" }] });
  assert.deepEqual(plain(W.parityLine(copy)), { count: 0, fix: ["claude-own-home"], subs: "Claude / ChatGPT" });
  assert.equal(W.parityLine({ ...copy, fixes: [] }), null);
});

test("server errors in plain words", () => {
  assert.equal(W.plainError(409, { error: "slug already exists" }), "There's already a project with that name — pick another.");
  assert.equal(W.plainError(409, { error: 'config_dir already used by workspace "acme"' }), "Project acme already uses this Claude account.");
  assert.equal(W.plainError(400, { error: "path exists but is not a git repository: /x (delivery is 'pr')" }), "That folder isn't a git repository.");
  assert.equal(W.plainError(403, { error: "admin token required (x-mc-admin)" }), "This browser isn't signed in to Chronos as you.");
  assert.equal(W.plainError(400, { error: "invalid request body — name: Required" }), "Name: Required");
  assert.equal(W.plainError(0, null, "fetch failed"), "Couldn't reach Chronos — is the daemon still running?");
  assert.equal(W.plainError(500, null, ""), "Chronos hit an error — its log says why.");
});

test("the hello is instant and short, says the name, and its chips are real messages", () => {
  const lines = W.intro("Ada");
  assert.ok(lines.length >= 3 && lines.length <= 5);
  assert.equal(lines[0], "Hi, I'm Ada.");
  assert.ok(lines.every((l: string) => l.length <= 110), "each line reads at a glance");
  const c = plain(W.chips("acme"));
  assert.deepEqual(plain(c.map((x: any) => x.label)), ["What can you do?", "Why use this instead of a terminal?", "Start my first task", "Show me the guide"]);
  assert.equal(c[2].say, "Start my first task in #acme", "the first task lands on the project just made");
  assert.equal(W.chips(null)[2].say, "Start my first task");
  assert.equal(c[3].href, "/guide");
  assert.ok(c.slice(0, 3).every((x: any) => x.say && !x.href));
});

test("optional extras: one folded line on the last step — only what isn't on, each how-to with its command as code", async () => {
  const { optionalUpgrades } = await import("./setup-optional.js");
  const bare = {
    appleSilicon: true, voice: "missing", uv: true, hearing: "missing", hearingFinal: "missing", cloudKey: false, finalEngine: "accurate",
    telegram: false, desktopNotify: true, phone: false, calendars: 0, failoverChain: ["grok"], failoverReady: [],
    gh: "missing", fff: false, rtk: false, browser: false, logDir: "/Users/operator/getchronos", phoneGuide: true,
  } as const;
  const items = optionalUpgrades({ ...bare, failoverChain: [...bare.failoverChain], failoverReady: [] });
  const x = plain(W.extrasList({ items, summary: { on: 0, total: items.length } }));
  assert.equal(x.total, 12);
  assert.equal(x.todo.length, 12, "a plain Mac: every extra is one you can add");
  assert.equal(W.extrasList({ items: items.map((i) => ({ ...i, status: "on" })) }), null, "all on: no line at all");
  assert.equal(W.extrasList(null), null, "an older daemon (404) or an error: no line");
  assert.equal(W.extrasList({ error: "boom" }), null);
  const one = plain(W.extrasList({ items: [{ ...items[0], status: "on" }, items[1]] }));
  assert.deepEqual(one, { on: 1, total: 2, todo: [{ id: items[1].id, label: items[1].label, how: items[1].how }] });

  const how = Object.fromEntries(items.map((i) => [i.id, plain(W.extraHow(i.how))]));
  assert.deepEqual(how.hearing, { lead: "In the Chronos folder:", cmd: "bash scripts/install-whisper.sh", tail: "", link: "" });
  assert.deepEqual(how.github, { lead: "", cmd: "brew install gh && gh auth login", tail: "", link: "" });
  assert.deepEqual(how.rtk, { lead: "", cmd: "brew install rtk", tail: "then restart Chronos", link: "" });
  assert.equal(how.browser.cmd, items.find((i) => i.id === "browser")!.how, "the whole npx line");
  assert.deepEqual(how.phone, { lead: "", cmd: "", tail: "Tailscale: a few minutes, no domain needed", link: "/guide/phone" });
  assert.deepEqual(how.calendar, { lead: "", cmd: 'POST /api/calendars {"name":"Work","ics_url":"<your calendar\'s private ICS link>"}', tail: "Google, iCloud and Outlook all give one", link: "" });
  assert.equal(how.telegram.lead, items.find((i) => i.id === "telegram")!.how, "words stay words");
  for (const [id, h] of Object.entries(how) as [string, any][]) {
    assert.ok(h.lead || h.cmd || h.link, `${id}: something to read`);
    assert.ok(!/^(brew|bash|npm|npx|gh) /.test(h.lead), `${id}: a command is never left as prose`);
  }
});
