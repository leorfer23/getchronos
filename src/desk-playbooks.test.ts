/**
 * The Desk's side of a playbook OK (static/desk.html). Its `api()` is the page's one door to the daemon:
 * lifted out and run in a vm, it must send the operator's hand (`x-mc-operator: 1`) on a run's OK — the
 * one playbook route that needs it (ledger-routes.ts operatorHand) — and on nothing else of a run's.
 * And a refused save must say why even when api() cut the JSON body off at 200 characters.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";

const html = fs.readFileSync(path.join(process.cwd(), "static/desk.html"), "utf8");
const lift = (re: RegExp, what: string) => {
  const m = re.exec(html);
  assert.ok(m, `${what} is where this test looks for it`);
  return m[0];
};
const apiSrc = lift(/const api = \(p, opts\) => \{[\s\S]*?\n\};\n/, "the Desk's api()");
const errSrc = lift(/const errMsg = \(e\) => \{[^\n]*\n/, "errMsg");
const pbErrSrc = lift(/function pbErr\(e\) \{[\s\S]*?\n\}\n/, "pbErr");

function page() {
  const sent: Array<{ url: string; headers: Record<string, string> }> = [];
  const ctx: any = {
    TOKEN: "admin-token",
    LOCK: null,
    DeskScope: { lens: (_p: string, d: unknown) => d },
    fetch: (url: string, o: any) => {
      sent.push({ url, headers: o.headers });
      return Promise.resolve({ ok: true, status: 200, json: async () => ({}) });
    },
  };
  vm.runInNewContext(`${apiSrc}${errSrc}${pbErrSrc}; globalThis.api = api; globalThis.pbErr = pbErr;`, ctx);
  return { ctx, sent };
}

test("the Desk sends the operator's hand on a playbook run's OK, and on no other playbook route", async () => {
  const { ctx, sent } = page();
  await ctx.api("/playbook-runs/0a1b2c3d-0000-4000-8000-000000000000/ok", { method: "POST", body: "{}" });
  for (const p of ["/playbook-runs/0a1b2c3d/stop", "/playbooks/abc/runs", "/playbooks", "/playbook-runs/0a1b2c3d/steps/1/start", "/playbook-runs/x/ok/more"]) {
    await ctx.api(p, { method: "POST", body: "{}" });
  }
  assert.equal(sent[0].url, "/api/playbook-runs/0a1b2c3d-0000-4000-8000-000000000000/ok");
  assert.equal(sent[0].headers["x-mc-operator"], "1");
  assert.equal(sent[0].headers["x-mc-admin"], "admin-token");
  for (const s of sent.slice(1)) assert.equal(s.headers["x-mc-operator"], undefined, s.url);
  // The routes that had it keep it.
  await ctx.api("/sessions/abc/kill", { method: "POST" });
  assert.equal(sent.at(-1)!.headers["x-mc-operator"], "1");
});

test("a refused save says why, even from a JSON body api() cut off", () => {
  const { ctx } = page();
  const whole = new Error(JSON.stringify({ error: "step 2: a merge step merges the run's PR" }));
  assert.equal(ctx.pbErr(whole), "step 2: a merge step merges the run's PR");
  const cut = new Error(JSON.stringify({ error: `step 1: \`cd /x\` is outside this workspace's repos and services; ${"step 9: … ".repeat(30)}`, errors: [] }).slice(0, 200));
  assert.match(ctx.pbErr(cut), /^step 1: `cd \/x` is outside this workspace's repos and services; step 9.*…$/);
  assert.equal(ctx.pbErr(new Error("plain text")), "plain text");
});
