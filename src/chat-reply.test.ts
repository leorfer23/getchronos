/**
 * Reply to one bubble in Robert's chat (Desk + phone).
 *
 * Hover a bubble (tap, on touch) → ↩ → the bubble is quoted above the composer and the next line
 * carries `replyTo: {id, side}`. The daemon reads the quoted words back from that row — never from
 * the client — puts them above the line for Robert, and stores the parent id + a display excerpt on
 * the new row. The pages have no build step, so a regex over the files is what notices a lost wire;
 * the store half is covered in chat.test.ts.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { AgentTextSchema } from "./validation.js";

const read = (p: string) => fs.readFileSync(path.join(process.cwd(), p), "utf8");
const api = read("src/api.ts");
const desk = read("static/desk.html");
const phone = read("static/phone.html");
const mod = read("static/chat-reply.js");
const sw = read("static/sw.js");

test("replyTo is an id and a side — no text a client could put in his mouth", () => {
  assert.ok(AgentTextSchema.safeParse({ text: "yes", replyTo: { id: 3, side: "reply" } }).success);
  assert.ok(AgentTextSchema.safeParse({ text: "yes", replyTo: null }).success);
  assert.ok(!AgentTextSchema.safeParse({ text: "yes", replyTo: { id: 3, side: "robert" } }).success);
  assert.ok(!AgentTextSchema.safeParse({ text: "yes", replyTo: { id: "3", side: "you" } }).success);
  const parsed = AgentTextSchema.parse({ text: "yes", replyTo: { id: 3, side: "you", text: "forged" } });
  assert.deepEqual(parsed.replyTo, { id: 3, side: "you" }, "extra fields are dropped");
});

test("the turn: quote read back from the row, above the words; routing and `you` stay the words typed", () => {
  assert.match(api, /const quote = req\.body\.replyTo \? chat\.quoteOf\(req\.body\.replyTo\.id, req\.body\.replyTo\.side\) : null;/);
  assert.match(api, /const prompt = quotePrompt\(quote\) \+ text \+ chatAttachmentsBlock\(files\);/);
  // The router reads req.body.text — a #tag inside the quoted parent never re-routes the reply.
  assert.match(api, /const turn = await resolveTurnSmart\(req\.body\.text,/);
  assert.match(api, /chat\.add\(text, reply \|\| "", "web", ws, steps, shown, quote\)/);
  assert.match(api, /chat\.add\(text, err, "web", ws, null, shown, quote\)/);
  // Every surface can draw the quote and mark the new row's bubbles.
  assert.match(api, /topic: "agent\.asked",[^\n]*\.\.\.\(quoted \? \{ quote: quoted \} : \{\}\)/);
  assert.equal((api.match(/id: row\.id,\n\s+\.\.\.\(shown\.length \? \{ attachments: shown \} : \{\}\),\n\s+\.\.\.\(quoted \? \{ quote: quoted \} : \{\}\),/g) || []).length, 2);
  // Quote rides the bus with the accepted turn; the HTTP body only carries the turn id.
  assert.match(api, /res\.json\(\{ accepted: true, turn: turnId, ws, how: turn\.how \}\)/);
});

test("the shared module: hover or tap shows ↩, ⎋ drops the quote, a quote click scrolls to its parent", () => {
  assert.match(mod, /window\.ChatReply = function attach\(\{ log, input, before, onMissing \}\)/);
  assert.match(mod, /@media \(hover:hover\)\{\.bub\[data-rid\]:hover>\.rp\{opacity:1;pointer-events:auto\}\}/);
  assert.match(mod, /\.bub\.rp-on>\.rp\{opacity:1;pointer-events:auto\}/);
  assert.match(mod, /touch = e\.pointerType === "touch" \|\| e\.pointerType === "pen";/);
  assert.match(mod, /if \(e\.key === "Escape" && cur\) \{ e\.preventDefault\(\); e\.stopPropagation\(\); set\(null\); \}/);
  assert.match(mod, /t\.scrollIntoView\(\{ block: "center", behavior: "smooth" \}\);/);
  // Only bubbles that are a stored row get a ↩ — a line still in flight has nothing to point at.
  assert.match(mod, /if \(!bub \|\| !id\) return bub;/);
  assert.match(mod, /window\.ChatReply\.fromRow = \(m\) =>/);
});

test("Desk: the quote rides the next typed line, every stored bubble is marked", () => {
  assert.match(desk, /<script src="\/chat-reply\.js"><\/script>/);
  assert.match(desk, /const RP = ChatReply\(\{ log: OV\.log, input: input0, before: qs\("#chat-att"\)/);
  assert.match(desk, /queueAsk\(text \|\| "Look at the attachments\.", now, false, atts, RP\.take\(\)\)/);
  assert.match(desk, /if \(item\.quote\) body\.replyTo = \{ id: item\.quote\.id, side: item\.quote\.side \};/);
  // Picking a project on his "which one?" line re-sends the same reply.
  assert.match(desk, /askWhere\(r, item\.text, item\.atts, item\.quote\)/);
  assert.match(desk, /OV\.queue\.push\(\{ text, bub, ws: c\.ws, picked: true, atts, quote \}\)/);
  // History: both halves marked, the reply's quote drawn.
  assert.match(desk, /const yb = RP\.mark\(ovLine\("you", m\.you, ws\), m\.id, "you"\);\s*RP\.quote\(yb, ChatReply\.fromRow\(m\)\);/);
  assert.match(desk, /if \(m\.reply\) RP\.mark\(ovLine\("rob", m\.reply, ws, !m\.you\), m\.id, "reply"\);/);
  // A line drawn early (agent.asked from the phone) is marked when its row lands.
  assert.match(desk, /if \(drawn\) RP\.mark\(drawn, e\.id, "you"\);/);
  assert.match(desk, /drawn: new Map\(\)/);
});

test("phone: same module, same payload, same marks", () => {
  assert.match(phone, /<script src="\/chat-reply\.js"><\/script>/);
  assert.match(phone, /const RP = ChatReply\(\{ log: qs\("#chat"\), input: rComposer, before: rComposer\.closest\("\.composer"\)/);
  assert.match(phone, /const quote = RP\.take\(\);/);
  assert.match(phone, /if \(quote\) body\.replyTo = \{ id: quote\.id, side: quote\.side \};/);
  assert.match(phone, /if \(next\) deliverRobert\(next\.text, next\.el, undefined, next\.quote\);/);
  assert.match(phone, /RP\.mark\(bubble\("rob", e\.reply\), e\.id, "reply"\)/);
  assert.match(phone, /ChatReply\.fromRow\(m\)/);
  // The PWA shell caches it, under a new version so an installed phone picks it up.
  assert.match(sw, /"\/chat-reply\.js"/);
  assert.doesNotMatch(sw, /const VERSION = "v8";/);
});
