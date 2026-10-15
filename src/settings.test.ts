import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { CONFIG } from "./config.js";
import { kv, workspaces } from "./store.js";
import { _resetSettingsCache, resolveSetting, setting, settingOn, settingsView, writeSetting } from "./settings.js";
import { routeConfigDir } from "./profile-route.js";

let n = 0;
const mkWs = () => workspaces.create({ slug: "set-ws" + ++n, name: "Set " + n, config_dir: "/tmp/set-ws" + n }).id;

beforeEach(() => {
  for (const k of ["settings:global", "web.model"]) kv.del(k);
  _resetSettingsCache();
});

test("default → global → workspace, and null clears back to inherit", () => {
  const a = mkWs();
  const b = mkWs();
  assert.deepEqual(resolveSetting("robert.drive", a), { value: CONFIG.robertDrive.enabled, source: "default" });
  writeSetting("robert.drive", false);
  assert.equal(settingOn("robert.drive", a), false);
  assert.equal(resolveSetting("robert.drive", a).source, "global");
  writeSetting("robert.drive", true, a);
  assert.equal(settingOn("robert.drive", a), true);
  assert.equal(settingOn("robert.drive", b), false);
  writeSetting("robert.drive", null, a);
  assert.deepEqual(resolveSetting("robert.drive", a), { value: false, source: "global" });
  writeSetting("robert.drive", null);
  assert.equal(resolveSetting("robert.drive", a).source, "default");
});

test("values are type-checked; global-only settings refuse a workspace", () => {
  const a = mkWs();
  assert.throws(() => writeSetting("robert.drive", "yes"), /on\/off/);
  assert.throws(() => writeSetting("robert.per_terminal_hour", 999), /at most 60/);
  assert.throws(() => writeSetting("failover.backends", ["nope"]), /unknown nope/);
  assert.throws(() => writeSetting("robert.per_hour", 5, a), /every workspace/);
  assert.throws(() => writeSetting("nope.nope", 1), /unknown setting/);
  writeSetting("robert.per_terminal_hour", "7", a);
  assert.equal(setting("robert.per_terminal_hour", a), 7);
});

test("robert.model reads and writes the web.model key the chat picker already uses", () => {
  assert.equal(setting("robert.model"), CONFIG.agent.voiceModel);
  writeSetting("robert.model", "sonnet");
  assert.equal(kv.get("web.model"), "sonnet");
  kv.set("web.model", "haiku");
  assert.equal(setting("robert.model"), "haiku");
});

test("workspace columns read 0/1 and JSON off the row and write through the workspace schema", () => {
  const a = mkWs();
  writeSetting("ws.auto_merge_prs", true, a);
  assert.equal(workspaces.get(a)!.auto_merge_prs, 1);
  assert.equal(setting("ws.auto_merge_prs", a), true);
  writeSetting("ws.sandbox_mode", "strict", a);
  assert.equal(setting("ws.sandbox_mode", a), "strict");
  writeSetting("ws.max_concurrent", null, a);
  assert.equal(setting("ws.max_concurrent", a), null);
  assert.throws(() => writeSetting("ws.auto_merge_prs", true), /pick one/);
});

test("the view: a workspace sees both+ws settings with what it inherits; global sees both+global", () => {
  const a = mkWs();
  writeSetting("robert.enabled", false);
  const wsView = settingsView(a);
  const r = wsView.find((v) => v.key === "robert.enabled")!;
  assert.deepEqual([r.value, r.source, r.inherited], [false, "global", false]);
  assert.ok(wsView.some((v) => v.key === "ws.sandbox_mode"));
  assert.ok(!wsView.some((v) => v.key === "robert.per_hour"));
  const g = settingsView(null);
  assert.ok(g.some((v) => v.key === "robert.per_hour"));
  assert.ok(!g.some((v) => v.level === "ws"));
});

test("accounts.alternates from Settings routes a walled workspace; untouched falls back to the env map", () => {
  const a = mkWs();
  const pinned = workspaces.get(a)!.config_dir;
  const wallOf = (d: string) => (d === pinned ? { window: "weekly", resetsAt: null } : null);
  const exists = () => true;
  assert.equal(routeConfigDir(pinned, a, 0, { wallOf, exists }).dir, pinned);
  assert.throws(() => writeSetting("accounts.alternates", ["claude"]), /pick one/);
  writeSetting("accounts.alternates", ["claude"], a);
  assert.equal(routeConfigDir(pinned, a, 0, { wallOf, exists }).dir, CONFIG.profiles.claude);
  assert.equal(resolveSetting("accounts.alternates", mkWs()).source, "default", "never leaks to another workspace");
  writeSetting("accounts.alternates", null, a);
  assert.equal(routeConfigDir(pinned, a, 0, { wallOf, exists }).dir, pinned);
});
