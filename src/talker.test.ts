/**
 * The voice front (src/talker.ts): the walls it keeps in code, what it spawns with, and one whole turn
 * on a fake provider. No network, no claude process.
 */
import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { bus } from "./bus.js";
import { chat, db, kv, workspaces } from "./store.js";
import { requests } from "./store/requests.js";
import * as L from "./ledger.js";
import * as T from "./talker.js";
import { writeSetting, _resetSettingsCache } from "./settings.js";
import { frontTakes } from "./agent-route.js";

L.setLedgerPhaseProvider(() => ({ phase: "working", line: null }));
L.setLedgerProgressProvider(() => null);

const mkWs = (slug: string) =>
  workspaces.create({ slug: `${slug}-${Math.random().toString(36).slice(2, 6)}`, name: slug, config_dir: `/tmp/tk-${slug}-${Math.random()}` } as any);

beforeEach(() => {
  db.exec("DELETE FROM request_checks; DELETE FROM request_decisions; DELETE FROM request_deliverables; DELETE FROM request_terminals; DELETE FROM requests; DELETE FROM chat_messages;");
  L.resetLedgerMemory();
  kv.set("settings:global", "{}");
  _resetSettingsCache();
  T.setTalkerFetch(null);
  T.setTalkerDelegator(null);
});
after(() => { T.setTalkerFetch(null); T.setTalkerDelegator(null); });

// ───────────────────────────── the delegation wall ─────────────────────────────

test("a turn that read workspace A's rows cannot put A's text into the message to workspace B", () => {
  const A = mkWs("alpha"), B = mkWs("bravo");
  const secretA = "ALPHA-ONLY merger terms with the acquirer";
  const rowA = requests.create({ workspace_id: A.id, words: secretA, via: "typed", opened_by: "operator" } as any);
  const rowB = requests.create({ workspace_id: B.id, words: "fix the export button", via: "typed", opened_by: "operator" } as any);
  // The model saw every workspace's rows in its NOW block…
  const ctx = T.talkerContext(null);
  assert.ok(ctx.includes(secretA.slice(0, 20)), "the front reads A's rows (read access across workspaces)");
  // …and its reply tries every way to carry A's text to B: extra fields, A's id among B's.
  const reply = `Dale, se lo paso.\n§delegate ${B.slug} ids=${rowB.id.slice(0, 8)} note="${secretA}" words="${secretA}"`;
  const { delegates } = T.splitReply(reply);
  assert.equal(delegates.length, 1);
  const st = { words: "decile a bravo que arregle el botón de exportar", earlier: [], scope: null };
  const d = T.buildDelegation({ ...delegates[0], note: secretA, words: secretA, request_text: secretA } as any, st);
  assert.ok(d.ok);
  if (!d.ok) return;
  assert.equal(d.ws.id, B.id);
  assert.ok(!d.payload.includes("ALPHA-ONLY"), "no field of the model's reaches the payload");
  assert.ok(d.payload.includes(st.words), "his own words are what B's Robert gets");
  assert.ok(d.payload.includes(rowB.id.slice(0, 8)) && d.payload.includes("fix the export button"), "plus B's own row");
  // An id of A's named for B is dropped: the work still goes to B with his words, and nothing of A's rides along.
  const bad = T.buildDelegation({ project: B.slug, ids: [rowA.id.slice(0, 8)] }, st);
  assert.ok(bad.ok);
  if (bad.ok) { assert.deepEqual(bad.requestIds, []); assert.ok(!bad.payload.includes(rowA.id.slice(0, 8)) && !bad.payload.includes(rowA.words)); }
  // The fleet-wide (workspace-less) row is nobody's to hand over either.
  const fleet = requests.create({ workspace_id: null, words: "the operator's own note", via: "typed", opened_by: "operator" } as any);
  const fl = T.buildDelegation({ project: B.slug, ids: [fleet.id] }, st);
  assert.ok(fl.ok && !fl.payload.includes("the operator's own note"));
  assert.equal(T.buildDelegation({ project: "no-such-project" }, st).ok, false, "a project that does not exist is still refused");
  for (const said of ["Dale, lo miro en Chronos.", "On it.", "Dale, me pongo con eso."]) assert.ok(T.PROMISE_RE.test(said), said);
  for (const said of ["Hola, buenas noches.", "Dos cosas te esperan."]) assert.ok(!T.PROMISE_RE.test(said), said);
});

test("his earlier words ride along only when asked (back=1..2), and only his — never the replies", () => {
  const B = mkWs("bravo");
  const st = { words: "sí, eso", earlier: ["y lo del export en bravo?", "hola"], scope: null };
  const d0 = T.buildDelegation({ project: B.slug }, st);
  assert.ok(d0.ok && !d0.payload.includes("export"));
  const d1 = T.buildDelegation({ project: B.slug, back: 1 }, st);
  assert.ok(d1.ok && d1.payload.includes("y lo del export en bravo?") && !d1.payload.includes("hola"));
});

test("a page locked to one workspace (screen share) sees and delegates only there", () => {
  const A = mkWs("alpha"), B = mkWs("bravo");
  requests.create({ workspace_id: A.id, words: "alpha secret thing", via: "typed", opened_by: "operator" } as any);
  requests.create({ workspace_id: B.id, words: "bravo visible thing", via: "typed", opened_by: "operator" } as any);
  const ctx = T.talkerContext(B.id);
  assert.ok(ctx.includes("bravo visible thing"));
  assert.ok(!ctx.includes("alpha secret thing"), "the lock is a wall for what it reads");
  assert.ok(!ctx.includes(A.slug), "and for the projects it names");
  assert.equal(T.buildDelegation({ project: A.slug }, { words: "x", earlier: [], scope: B.id }).ok, false, "and for where it writes");
});

// ───────────────────────────── no approvals, no daemon routes ─────────────────────────────

test("the front can only delegate: no approve/merge/send/deploy verb, no daemon route, no daemon token", () => {
  const { delegates, spoken } = T.splitReply("Listo.\n§approve 3f2a91bc\n§merge 212\n§send draft\n§decision yes\n§delegate x");
  assert.equal(spoken, "Listo.");
  assert.deepEqual(delegates.map((d) => d.project), ["x"], "every other § verb is ignored");
  const src = fs.readFileSync(path.join(process.cwd(), "src/talker.ts"), "utf8");
  for (const banned of ["recordDecision", "ledger-routes", "/decision", "x-mc-admin", "x-mc-operator", "adminToken", "robertToken", "localhost:", "127.0.0.1"]) {
    assert.ok(!src.includes(banned), `talker.ts must not reference ${banned}`);
  }
  // The cli engine runs with no tools and no MCP at all.
  const args = T.cliTalkerArgs("/tmp/prof");
  const at = (f: string) => args[args.indexOf(f) + 1];
  assert.equal(at("--tools"), "", "no built-in tools");
  assert.ok(args.includes("--strict-mcp-config") && !args.includes("--mcp-config"), "no MCP server");
  assert.ok(args.includes("--disable-slash-commands") && args.includes("--no-session-persistence"));
  assert.ok(at("--system-prompt").startsWith("You are Robert"), "its own system prompt replaces Claude Code's");
  assert.ok(!args.includes("--dangerously-skip-permissions") && !args.includes("--allowed-tools"));
  const settings = JSON.parse(at("--settings"));
  assert.equal(settings.outputStyle, "default");
  assert.equal(settings.alwaysThinkingEnabled, false);
  assert.ok(settings.claudeMdExcludes.includes("/tmp/prof/CLAUDE.md"));
  assert.ok(T.TALKER_SYSTEM.length < 9000, "the prompt stays ~2k tokens");
});

test("the spoken stream stops at the first §: delegate lines are never spoken or shown", () => {
  const out: string[] = [];
  const f = T.speakFilter((t) => out.push(t));
  f.push("Dale, se lo paso a Robert de bravo.");
  f.push("\n§dele");
  f.push("gate bravo ids=1234abcd");
  assert.equal(out.join(""), "Dale, se lo paso a Robert de bravo.\n");
  assert.ok(f.cut());
});

// ───────────────────────────── setting off = today's path ─────────────────────────────

test("off (the default), POST /agent does not hand anything to the front; files never go to it", () => {
  assert.equal(T.talkerOn(), false, "voice.talker defaults to off");
  assert.equal(frontTakes({}, T.talkerOn()), false);
  writeSetting("voice.talker", true);
  assert.equal(T.talkerOn(), true);
  assert.equal(frontTakes({}, T.talkerOn()), true);
  assert.equal(frontTakes({ attachments: [{ id: "a" }] }, true), false, "a line with files stays on today's path");
});

// ───────────────────────────── engines + credentials ─────────────────────────────

test("engine: cli unless api is chosen AND a key exists; keys come from the env, never a setting", () => {
  assert.equal(T.talkerEngine(), "cli");
  writeSetting("voice.talker_engine", "api");
  const had = { a: process.env.ANTHROPIC_API_KEY, g: process.env.AI_GATEWAY_API_KEY, c: process.env.CHRONOS_TALKER_API_KEY };
  delete process.env.ANTHROPIC_API_KEY; delete process.env.AI_GATEWAY_API_KEY; delete process.env.CHRONOS_TALKER_API_KEY;
  try {
    assert.equal(T.talkerEngine(), "cli", "api without a key stays on cli");
    assert.equal(T.talkerCredential({ AI_GATEWAY_API_KEY: "g" }, "auto", "claude-haiku-5-5")?.model, "anthropic/claude-haiku-5.5");
    assert.equal(T.talkerCredential({ ANTHROPIC_API_KEY: "k", AI_GATEWAY_API_KEY: "g" }, "auto", "claude-haiku-5-5")?.provider, "anthropic");
    assert.equal(T.talkerCredential({ AI_GATEWAY_API_KEY: "g" }, "anthropic", "x"), null);
    assert.equal(T.apiModelId("gateway", "anthropic/claude-sonnet-5.5"), "anthropic/claude-sonnet-5.5");
    assert.ok(!JSON.stringify(T.talkerStatus()).includes("sk-"), "status never carries a key");
  } finally {
    if (had.a) process.env.ANTHROPIC_API_KEY = had.a;
    if (had.g) process.env.AI_GATEWAY_API_KEY = had.g;
    if (had.c) process.env.CHRONOS_TALKER_API_KEY = had.c;
  }
});

// ───────────────────────────── one whole turn ─────────────────────────────

function sse(text: string): Response {
  const events = [
    { type: "message_start", message: { usage: { input_tokens: 10 } } },
    { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
    ...text.match(/[\s\S]{1,7}/g)!.map((t) => ({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: t } })),
    { type: "content_block_stop", index: 0 },
    { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 5 } },
  ];
  const body = events.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join("");
  return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
}

test("a whole turn (api engine, fake provider): streams, stores, delegates in the background, opens the request", async () => {
  const B = mkWs("bravo");
  writeSetting("voice.talker", true);
  writeSetting("voice.talker_engine", "api");
  const had = process.env.CHRONOS_TALKER_API_KEY;
  process.env.CHRONOS_TALKER_API_KEY = "test-key";
  const sent: any[] = [];
  T.setTalkerFetch(async (_url, init) => { sent.push(JSON.parse(String(init.body))); return sse(`Dale, se lo paso a Robert de bravo.\n§delegate ${B.slug} kind=pr`); });
  let delegated: { payload: string; ws: string; turn: string } | null = null;
  T.setTalkerDelegator(async (payload, ws, turn) => { delegated = { payload, ws, turn }; return { reply: "Abrí una terminal para el botón. Te aviso cuando esté." }; });
  const events: any[] = [];
  const on = (e: any) => events.push(e);
  bus.on("event", on);
  try {
    const t = await T.startTalkerTurn({ text: "decile a bravo que arregle el botón", voice: true, surface: "phone", client: "c1", scope: null, askedAt: new Date().toISOString() });
    assert.ok(t.ok);
    if (!t.ok) return;
    await t.go();
    await new Promise((r) => setTimeout(r, 30));
    const body = sent[0];
    assert.equal(body.model, "claude-haiku-5-5");
    assert.equal(body.system[0].cache_control.type, "ephemeral", "the fixed prompt is cached");
    assert.ok(!body.tools, "no tools on the wire");
    assert.match(body.messages.at(-1).content, /HE SAID: decile a bravo/);
    const deltas = events.filter((e) => e.topic === "agent.delta" && e.turn === t.turn).map((e) => e.text).join("");
    assert.equal(deltas, "Dale, se lo paso a Robert de bravo.\n", "only the spoken part streams");
    const push = events.find((e) => e.topic === "agent.push" && e.turn === t.turn);
    assert.equal(push.reply, "Dale, se lo paso a Robert de bravo.");
    assert.ok(events.some((e) => e.topic === "agent.asked" && e.turn === t.turn && e.voice === true));
    // Delegated: B's Robert got his words; a request in B is bound to that turn.
    assert.ok(delegated, "the project Robert was asked");
    assert.equal(delegated!.ws, B.id);
    assert.ok(delegated!.payload.includes("decile a bravo que arregle el botón"));
    const reqB = requests.list({ workspace_id: B.id, limit: 5 });
    assert.equal(reqB.length, 1);
    assert.equal(reqB[0].turn_id, delegated!.turn);
    assert.equal(reqB[0].kind, "pr");
    // The result comes back as a push with no operator line — what every live call speaks.
    const result = events.find((e) => e.topic === "agent.push" && String(e.turn).startsWith("front-result:"));
    assert.equal(result.you, "");
    assert.match(result.reply, /^bravo: Abrí una terminal/);
    // Timing is recorded on the front's row.
    const row = chat.frontTurns(null, 5).find((r) => r.you.startsWith("decile"));
    assert.ok(row);
    const timed = db.prepare("SELECT asked_at, first_delta_at, voice FROM chat_messages WHERE source = 'front' AND you != ''").get() as any;
    assert.ok(timed.asked_at && timed.first_delta_at && timed.voice === 1);
  } finally {
    bus.off("event", on);
    if (had) process.env.CHRONOS_TALKER_API_KEY = had; else delete process.env.CHRONOS_TALKER_API_KEY;
  }
});

test("a provider refusing the key falls back BEFORE he hears anything; a turn with no work is a closed chat request", async () => {
  writeSetting("voice.talker", true);
  writeSetting("voice.talker_engine", "api");
  const had = process.env.CHRONOS_TALKER_API_KEY;
  process.env.CHRONOS_TALKER_API_KEY = "test-key";
  try {
    T.setTalkerFetch(async () => new Response("{\"error\":\"invalid x-api-key\"}", { status: 401 }));
    const bad = await T.startTalkerTurn({ text: "hola", voice: true, surface: "phone", scope: null, askedAt: new Date().toISOString() });
    assert.equal(bad.ok, false, "POST /agent then runs today's path");
    T.setTalkerFetch(async () => sse("Hola. Nada te espera ahora."));
    const ok = await T.startTalkerTurn({ text: "hola", voice: false, surface: "desk", scope: null, askedAt: new Date().toISOString() });
    assert.ok(ok.ok);
    if (ok.ok) await ok.go();
    const rows = requests.list({ workspace_id: null, limit: 5 });
    assert.equal(rows.length, 1);
    assert.equal(rows[0].kind, "chat");
    assert.ok(rows[0].closed_at, "answered without work → closed at once, never 'stuck'");
  } finally {
    if (had) process.env.CHRONOS_TALKER_API_KEY = had; else delete process.env.CHRONOS_TALKER_API_KEY;
  }
});

test("the front's rows never reach a project Robert's recap", () => {
  chat.add("¿cómo va todo?", "Alpha tiene un merge esperando y Bravo está trabado.", "front", null);
  chat.add("hola", "hola", "web", null);
  const recap = chat.contextBlock({ workspaceId: null });
  assert.ok(!recap.includes("Alpha tiene"), "cross-workspace text from the front stays out of the unscoped Robert's recap");
  assert.ok(recap.includes("hola"));
});

test("a hand-over that was simply answered is closed; one a terminal took, or that left something to decide, stays open", async () => {
  const B = mkWs("bravo-close");
  T.setTalkerDelegator(async () => ({ reply: "Hay 15 abiertos." }));
  const st = { turn: "t-close", words: "contá los PR abiertos", earlier: [], scope: null, via: "voice", surface: "phone", delegations: [] } as any;
  const d = T.buildDelegation({ project: B.slug }, st);
  assert.ok(d.ok);
  if (!d.ok) return;
  const a = T.startDelegation(d, st);
  await a.done;
  assert.ok(requests.get(a.request)!.closed_at, "answered and nothing else: closed");
  // Something came back that waits on him: it must stay open.
  T.setTalkerDelegator(async (_p, _ws, turn) => {
    const r = requests.list({ workspace_id: B.id, limit: 20 }).find((x) => x.turn_id === turn)!;
    requests.upsertDeliverable({ request_id: r.id, kind: "pr", ref: "https://github.com/acme/app/pull/7", label: "PR" });
    assert.equal(requests.deliverables(r.id).length, 1);
    return { reply: "Abrí el PR." };
  });
  const st2 = { ...st, turn: "t-open", delegations: [] };
  const b = T.startDelegation(T.buildDelegation({ project: B.slug }, st2) as any, st2);
  await b.done;
  assert.equal(requests.get(b.request)!.closed_at, null, "a deliverable keeps it open");
  assert.equal(requests.deliverables(b.request).length, 1, "and the delegator really ran");
});
