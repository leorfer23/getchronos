#!/usr/bin/env node
// Time to Robert's first word, before vs after the voice front — read from chat_messages (asked_at =
// when the daemon accepted the line, first_delta_at = first streamed text of the reply, created_at =
// when the whole reply was stored; migration 155). Read-only; the operator runs it on the daemon Mac:
//
//   node scripts/talk-latency.mjs [--since 7d] [--db ~/chronos/chronos.db]
//
// Groups: "front" = the voice front (src/talker.ts, source 'front'); "robert" = today's path (source
// 'web'), split by engine ("per project" = a fan-out, which streams nothing). Spoken and typed apart.
// This is the daemon's share only: the phone adds the silence that ends his turn (~0.75 s), whisper
// (~0.3 s small / ~1.3 s turbo) and the first sentence's synthesis.
import Database from "better-sqlite3";
import os from "node:os";
import path from "node:path";

const arg = (k, d) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : d; };
const dbPath = arg("--db", process.env.CHRONOS_DB || path.join(os.homedir(), "chronos", "chronos.db"));
const sinceRaw = arg("--since", "7d");
const m = /^(\d+)([hd])$/.exec(sinceRaw);
const since = new Date(Date.now() - (m ? Number(m[1]) * (m[2] === "d" ? 86400000 : 3600000) : 7 * 86400000)).toISOString();

const db = new Database(dbPath, { readonly: true, fileMustExist: true });
const rows = db.prepare(
  `SELECT source, engine, voice, asked_at, first_delta_at, created_at, length(reply) AS chars
   FROM chat_messages WHERE asked_at IS NOT NULL AND asked_at >= ? AND you != '' AND source IN ('web','front')`,
).all(since);

const ms = (a, b) => (a && b ? Date.parse(b) - Date.parse(a) : null);
const q = (xs, p) => { if (!xs.length) return null; const s = [...xs].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(p * s.length))]; };
const sec = (v) => (v == null ? "   -  " : `${(v / 1000).toFixed(1).padStart(5)}s`);

const groups = new Map();
for (const r of rows) {
  const who = r.source === "front" ? "front" : r.engine === "per project" ? "robert (fan-out)" : "robert";
  const key = `${who.padEnd(17)} ${r.voice ? "spoken" : "typed "}`;
  const g = groups.get(key) ?? { first: [], done: [], chars: [], n: 0, nofirst: 0 };
  g.n++;
  const f = ms(r.asked_at, r.first_delta_at);
  if (f == null) g.nofirst++; else g.first.push(f);
  const d = ms(r.asked_at, r.created_at);
  if (d != null) g.done.push(d);
  g.chars.push(r.chars ?? 0);
  groups.set(key, g);
}

console.log(`chat_messages since ${since} (${rows.length} timed turns) — ${dbPath}`);
console.log(`${"path".padEnd(17)} ${"how".padEnd(6)}   n   first word p50   p90    whole reply p50   p90   chars p50`);
for (const [k, g] of [...groups.entries()].sort()) {
  console.log(`${k} ${String(g.n).padStart(4)}       ${sec(q(g.first, 0.5))} ${sec(q(g.first, 0.9))}         ${sec(q(g.done, 0.5))} ${sec(q(g.done, 0.9))}   ${String(q(g.chars, 0.5) ?? "-").padStart(5)}${g.nofirst ? `   (${g.nofirst} streamed nothing)` : ""}`);
}
if (!rows.length) console.log("no timed turns yet (the columns fill from the first turn after migration 155).");
