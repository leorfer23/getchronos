/**
 * The Weekly retro card (static/desk-widgets/retro.js), run against a tiny DOM: the operator's tap
 * posts to the proposal's own workspace with `x-mc-operator: 1` (without it every approval is a 403),
 * the KPIs read lower-is-better, and an empty board says so instead of drawing nothing.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { pathToFileURL } from "node:url";

class FakeNode {
  tag: string; children: any[] = []; attrs: Record<string, string> = {}; style: Record<string, string> = {};
  listeners: Record<string, Function[]> = {}; textContent = ""; className = ""; disabled = false;
  constructor(tag: string) { this.tag = tag; }
  append(...cs: any[]) { this.children.push(...cs); }
  replaceChildren(...cs: any[]) { this.children = cs; }
  setAttribute(k: string, v: string) { this.attrs[k] = v; }
  addEventListener(t: string, f: Function) { (this.listeners[t] ??= []).push(f); }
  querySelectorAll(tag: string): FakeNode[] {
    const out: FakeNode[] = [];
    const walk = (n: FakeNode) => { for (const c of n.children) if (c instanceof FakeNode) { if (c.tag === tag) out.push(c); walk(c); } };
    walk(this);
    return out;
  }
}
(globalThis as any).Node = FakeNode;
(globalThis as any).document = {
  createElement: (t: string) => new FakeNode(t),
  createTextNode: (t: string) => Object.assign(new FakeNode("#text"), { textContent: t }),
};
const textOf = (n: any): string => (n.tag === "#text" ? n.textContent : n.textContent + n.children.map(textOf).join(""));

const mod = await import(pathToFileURL(path.join(process.cwd(), "static/desk-widgets/retro.js")).href);
const card = mod.default;

function ctx(calls: any[]) {
  return {
    api: async (p: string, o: any) => { calls.push({ p, o }); return {}; },
    toast: (m: string) => calls.push({ toast: m }),
    wsName: () => "Acme", wsColor: () => "var(--accent)", S: { sessions: [] },
  };
}

const row = {
  workspace_id: "ws-1", name: "Acme", slug: "acme",
  run: { until: "2026-11-09T11:00:00.000Z", created_at: "2026-11-09T11:00:00.000Z", gathered_at: "2026-11-09T11:00:05.000Z", report: "## Weekly retro · Acme\n- Verifier sent work back 3×" },
  kpis: { rejection_rate: 0.5, repeat_asks: 4, infra: 2, duplicates: 0 },
  last_week: { rejection_rate: 0.75, repeat_asks: 1, infra: 2, duplicates: 1 },
  pending: [{ id: "p-1", workspace_id: "ws-1", kind: "rule", source: "correction", text: "Save every export to ~/Downloads.", detail: null, evidence: 6 }],
  failing: [{ id: "r-9", text: "Never ask him for the schema — read it.", times: 2 }],
};

test("the tap posts to that workspace's proposal with the operator-hand header, and nothing else writes", async () => {
  const calls: any[] = [];
  const body = new FakeNode("div");
  card.render(body, { rows: [row] }, ctx(calls));
  const text = textOf(body);
  assert.match(text, /Save every export to ~\/Downloads\./);
  assert.match(text, /not holding: "Never ask him for the schema — read it\." — asked again 2×/);
  assert.match(text, /0\.50.*verifier \/ hand-off/);
  assert.equal(calls.length, 0, "rendering writes nothing");
  const [approve, dismiss] = body.querySelectorAll("button");
  assert.equal(approve.textContent, "✓");
  assert.equal(dismiss.textContent, "✕");
  await approve.listeners.click[0]();
  const post = calls.find((c) => c.p);
  assert.equal(post.p, "/workspaces/ws-1/retro/proposals/p-1");
  assert.equal(post.o.method, "POST");
  assert.equal(post.o.headers["x-mc-operator"], "1");
  assert.deepEqual(JSON.parse(post.o.body), { decision: "approve" });
  assert.ok(calls.some((c) => /memory/.test(c.toast ?? "")));
});

test("KPIs are lower-is-better: down is calm, up is the alarm, flat says so, a first week has no arrow", () => {
  const fmt = (v: number) => String(v);
  assert.equal(mod.delta(1, 4, fmt).textContent, " ▼3");
  assert.equal(mod.delta(1, 4, fmt).style.color, "var(--p-work)");
  assert.equal(mod.delta(4, 1, fmt).textContent, " ▲3");
  assert.equal(mod.delta(4, 1, fmt).style.color, "var(--danger)");
  assert.equal(mod.delta(2, 2, fmt).textContent, " =");
  assert.equal(mod.delta(2, null, fmt), null);
});

test("an empty board says the first retro is still to come", () => {
  const body = new FakeNode("div");
  card.render(body, { rows: [] }, ctx([]));
  assert.match(textOf(body), /no weekly retro yet/);
});
