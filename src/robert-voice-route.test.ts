/**
 * Small talk never fans out, and a spoken line never gets "Which project is this about?".
 * Pure router logic (resolveTurn / routeSmart with a stubbed model) — no manager runs (CLAUDE.md gotcha 2).
 */
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { db, sessions, workspaces } from "./store.js";
import { CONFIG } from "./config.js";
import { setRouteModel } from "./route-model.js";
import {
  isSocial,
  resolveTurn,
  resolveTurnSmart,
  resolveVoiceAsk,
  routeMessage,
  routeSmart,
  setSticky,
  wantsFanout,
} from "./thread-router.js";

let atlas: any, cedar: any;
let modelCalls = 0;
const answer = (json: object) => setRouteModel(async () => { modelCalls++; return JSON.stringify(json); });

beforeEach(() => {
  db.exec("DELETE FROM chat_messages; DELETE FROM tickets; DELETE FROM repos; DELETE FROM sessions; DELETE FROM workspaces; DELETE FROM kv;");
  CONFIG.thread.aliases = {};
  CONFIG.thread.stickyMinutes = 90;
  atlas = workspaces.create({ slug: "atlas", name: "Atlas", config_dir: "/tmp/atlas" });
  cedar = workspaces.create({ slug: "cedar", name: "Cedar", config_dir: "/tmp/cedar" });
  modelCalls = 0;
});
afterEach(() => setRouteModel(null));

// ── B. social detection that survives speech-to-text ──────────────────────────────────────────────

test("greetings, thanks and acks are social in any repetition, punctuation or accent", () => {
  for (const t of [
    "Hola, hola.", "hola hola", "Buenas buenas!", "ok dale gracias", "Ok, dale, gracias.", "holaaa", "HOLA",
    "buen día", "Buenos días, Robert", "¿Cómo estás?", "qué tal, todo bien?", "¿Me escuchás?", "probando, probando",
    "thanks!", "thank you!", "hey hey", "good morning", "how are you doing", "can you hear me", "chau, nos vemos",
    "hasta mañana", "jajaja", "👍", "🙏🙏", "perfecto, genial, gracias", "listo",
  ]) assert.equal(isSocial(t), true, t);
});

test("a work request never reads as social, however polite or short", () => {
  for (const t of [
    "dale, mergealo", "ok, push the branch", "gracias, ahora abrí el PR", "hola, ¿cómo va el deploy?",
    "hola robert, revisá la migración", "listo, cerrá la terminal", "thanks, now run the tests", "perfecto, mandalo",
    "sí", "no", "yes", "status", "¿cómo va todo?", "¿qué pasó?", "ok 2", "hola atlas",
    "hola hola hola hola hola hola hola hola hola hola hola hola hola", // 13 words: not a greeting any more
  ]) assert.equal(isSocial(t), false, t);
});

test("'Hola, hola.' with nothing sticky gets ONE reply from the unscoped Robert, never the fleet", async () => {
  answer({ project: "all", confidence: 0.9, why: "small talk" }); // what the model said on the live system
  const t = await resolveTurnSmart("Hola, hola.", { surface: "t" });
  assert.equal(modelCalls, 0, "small talk never pays a model round trip");
  assert.equal(t.ws, null);
  assert.equal(t.ask, null);
  assert.equal(t.routed?.social, true);
  assert.equal(wantsFanout(t), false);
});

test("small talk ignores the terminal on screen, but still follows the sticky project", async () => {
  const s = sessions.create({ workspace_id: cedar.id, cwd: "/tmp", backend: "claude-code", title: "x" } as any);
  const onScreen = await resolveTurnSmart("buenas buenas", { surface: "t", stagedSessionId: s.id });
  assert.equal(onScreen.ws, null, "the staged terminal is not a reason to wake cedar's Robert for a hello");
  setSticky("t", atlas.id);
  const sticky = await resolveTurnSmart("ok dale gracias", { surface: "t", stagedSessionId: s.id });
  assert.equal(sticky.ws, atlas.id, "a thanks right after an atlas turn is still about atlas");
  assert.equal(wantsFanout(sticky), false);
});

test("fan-out only for a real shop-wide question, an explicit #all, or the shop picked by hand", async () => {
  assert.equal(wantsFanout(resolveTurn("what's running?", { surface: "t" })), true, "fleet keyword");
  assert.equal(wantsFanout(resolveTurn("#all cerrá lo terminado", { surface: "t" })), true, "explicit #all");
  assert.equal(wantsFanout(resolveTurn("anything", { route: false, surface: "t" })), true, "the shop, picked by hand");
  assert.equal(wantsFanout(resolveTurn("hola", { surface: "t" })), false, "small talk");
  assert.equal(wantsFanout(resolveTurn("#atlas status", { surface: "t" })), false, "one project");

  // The model's "all": a request long enough to be one fans out; a two-word shrug does not.
  answer({ project: "all", confidence: 0.8, why: "spans projects" });
  assert.equal(wantsFanout(await resolveTurnSmart("close every finished terminal everywhere", { surface: "t" })), true);
  assert.equal(wantsFanout(await resolveTurnSmart("¿estás ahí?", { surface: "t" })), false);
  assert.equal(wantsFanout(await resolveTurnSmart("¿todo ok", { surface: "t" })), false);
});

// ── C. a spoken line never asks which project ─────────────────────────────────────────────────────

test("voice: the router's ask falls back to the bubble answered, then the sticky, then the unscoped Robert", async () => {
  answer({ project: "ask", confidence: 0.1, why: "no topic" });
  const asked = await resolveTurnSmart("push the branch and open the PR", { surface: "t" });
  assert.ok(asked.ask, "typed, this still asks");

  const viaReply = resolveVoiceAsk(asked, { replyWorkspace: cedar.id, surface: "t" });
  assert.equal(viaReply.ask, null);
  assert.equal(viaReply.ws, cedar.id);

  setSticky("t", atlas.id);
  const viaSticky = resolveVoiceAsk(asked, { surface: "t" });
  assert.equal(viaSticky.ws, atlas.id);
  assert.equal(resolveVoiceAsk(asked, { replyWorkspace: cedar.id, surface: "t" }).ws, cedar.id, "the reply beats the sticky");

  db.exec("DELETE FROM kv;");
  const unscoped = resolveVoiceAsk(asked, { surface: "t" });
  assert.equal(unscoped.ask, null);
  assert.equal(unscoped.ws, null);
  assert.equal(unscoped.text, "push the branch and open the PR");
  assert.equal(wantsFanout(unscoped), false, "nothing to go on is not a question for every project");
});

test("voice: a deleted parent workspace is skipped, a turn with no ask is untouched", () => {
  const asked = routeMessage("push the branch", { surface: "t" });
  assert.equal(asked.how, "ask");
  const t = resolveTurn("push the branch", { surface: "t" });
  assert.equal(resolveVoiceAsk(t, { replyWorkspace: "no-such-ws", surface: "t" }).ws, null);
  const routed = resolveTurn("#atlas ship it", { surface: "t" });
  assert.equal(resolveVoiceAsk(routed, { surface: "t" }), routed);
});

test("POST /agent: a voice turn goes through resolveVoiceAsk; a typed one keeps the ask", async () => {
  const fs = await import("node:fs");
  const path = await import("node:path");
  const api = fs.readFileSync(path.join(process.cwd(), "src/api.ts"), "utf8");
  const route = api.slice(api.indexOf('api.post("/agent", requireAdmin'), api.indexOf('api.post("/agent/exec/:id"'));
  assert.match(route, /const turn = voice && named\.length < 2 \? resolveVoiceAsk\(routedTurn, \{ replyWorkspace: quote\?\.workspace_id \?\? null, surface \}\) : routedTurn;/);
  assert.match(route, /const fanout = named\.length >= 2 \? named : wantsFanout\(turn\) \? activeWorkspaceIds\(\) : null;/);
  // F: the latency stamps ride both the reply row and the error row.
  assert.match(route, /const askedAt = new Date\(\)\.toISOString\(\);/);
  assert.match(route, /if \(kind === "text" && t && !firstDeltaAt\) firstDeltaAt = new Date\(\)\.toISOString\(\);/);
  assert.equal((route.match(/timing\(\)\)/g) || []).length, 2);
});
