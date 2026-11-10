#!/usr/bin/env node
// Compare speech-to-text engines on a folder of clips: word error rate and latency per engine.
//
// The clips are yours — nothing here ships audio, and nothing leaves this machine unless an engine
// URL you pass points elsewhere or you name the cloud engine (below). Works on any folder of .wav files, including the one the daemon
// keeps when Settings → Voice → "Keep the last call clips" is on (`mc voice clips --dir`).
//
// Usage:
//   node scripts/stt-bench.mjs --dir <folder> --engine <name>=<url>[;field=value…] [--engine …]
//        [--lang es] [--prompt "words, to, bias"] [--pad-ms 0] [--repeat 1] [--filter <regex>] [--json]
//
//   --engine  fast=http://127.0.0.1:7778/inference
//             final=http://127.0.0.1:7781/inference;beam_size=2;temperature_inc=0
//             Every `field=value` after the URL is sent as a whisper-server form field, so one
//             server can be measured with several decoder settings. `prompt=@` = the --prompt text.
//             cloud=elevenlabs[;model_id=scribe_v2][;language_code=auto][;keyterms=@]
//             The cloud engine (src/transcribe-cloud.ts): THIS SENDS THE CLIPS to api.elevenlabs.io
//             and is billed per hour of audio. The key comes from ELEVENLABS_API_KEY in the
//             environment, else from --secrets <file> (default ./.secrets); it is never printed.
//             language_code=auto = no hint (default: --lang); keyterms=@ = the --prompt text, split
//             on commas, as keyterms (billed extra). Any other field is sent as a form field.
//   --pad-ms  append this much digital silence to each clip before sending (16-bit PCM WAV only).
//
// References (what was really said), any of:
//   <folder>/refs.tsv        one `file.wav<TAB>text` per line
//   <folder>/<clip>.txt      next to the clip
//   <folder>/index.json      the daemon's clip index: its `ref` field when you filled one in
// A clip with no reference is listed with what each engine heard, side by side, and left out of the
// error rate. Clips whose reference is one or two words are also reported on their own ("commands"):
// exact matches, because a one-word answer is either right or wrong.
import fs from "node:fs";
import path from "node:path";

export function normWords(s) {
  return String(s ?? "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9]+/g, " ").trim().split(" ").filter(Boolean);
}

/** Word-level edit distance: [errors, reference words]. */
export function wordErrors(ref, hyp) {
  const r = normWords(ref), h = normWords(hyp);
  const d = Array.from({ length: h.length + 1 }, (_, i) => i);
  for (let i = 1; i <= r.length; i++) {
    let prev = d[0];
    d[0] = i;
    for (let j = 1; j <= h.length; j++) {
      const cur = d[j];
      d[j] = Math.min(d[j] + 1, d[j - 1] + 1, prev + (r[i - 1] === h[j - 1] ? 0 : 1));
      prev = cur;
    }
  }
  return [d[h.length], r.length];
}

/** `name=url;field=value;…` → { name, url, fields }. */
export function parseEngine(spec) {
  const eq = spec.indexOf("=");
  if (eq < 1) throw new Error(`--engine ${spec}: expected name=url[;field=value…]`);
  const [url, ...rest] = spec.slice(eq + 1).split(";");
  const fields = {};
  for (const kv of rest) {
    const i = kv.indexOf("=");
    if (i < 1) throw new Error(`--engine ${spec}: "${kv}" is not field=value`);
    fields[kv.slice(0, i)] = kv.slice(i + 1);
  }
  return { name: spec.slice(0, eq), url, fields };
}

/** Append silence to a 16-bit PCM WAV (the 44-byte header the phone writes). Anything else: untouched. */
export function padWav(buf, ms) {
  if (!ms || buf.length < 44 || buf.toString("latin1", 0, 4) !== "RIFF" || buf.toString("latin1", 36, 40) !== "data") return buf;
  const rate = buf.readUInt32LE(24), block = buf.readUInt16LE(32);
  const extra = Math.round((rate * ms) / 1000) * block;
  const out = Buffer.concat([buf, Buffer.alloc(extra)]);
  out.writeUInt32LE(out.length - 8, 4);
  out.writeUInt32LE(out.length - 44, 40);
  return out;
}

export function loadRefs(dir) {
  const refs = new Map();
  const tsv = path.join(dir, "refs.tsv");
  if (fs.existsSync(tsv)) {
    for (const line of fs.readFileSync(tsv, "utf8").split("\n")) {
      const i = line.indexOf("\t");
      if (i > 0) refs.set(line.slice(0, i).trim(), line.slice(i + 1).trim());
    }
  }
  const idx = path.join(dir, "index.json");
  if (fs.existsSync(idx)) {
    try {
      for (const c of JSON.parse(fs.readFileSync(idx, "utf8")).clips ?? []) if (c?.file && c.ref) refs.set(c.file, String(c.ref));
    } catch {}
  }
  for (const f of fs.readdirSync(dir)) {
    if (!f.endsWith(".wav") || refs.has(f)) continue;
    const txt = path.join(dir, f.replace(/\.wav$/, ".txt"));
    if (fs.existsSync(txt)) refs.set(f, fs.readFileSync(txt, "utf8").trim());
  }
  return refs;
}

export const CLOUD_URL = "https://api.elevenlabs.io/v1/speech-to-text";

/** ELEVENLABS_API_KEY from the environment, else from a KEY=VALUE secrets file. Never printed. */
export function cloudKey(env = process.env, secretsFile = ".secrets") {
  if (env.ELEVENLABS_API_KEY?.trim()) return env.ELEVENLABS_API_KEY.trim();
  let text = "";
  try { text = fs.readFileSync(secretsFile, "utf8"); } catch { return null; }
  for (const raw of text.split("\n")) {
    const m = raw.trim().replace(/^export\s+/, "").match(/^ELEVENLABS_API_KEY=(.*)$/);
    if (m) return m[1].trim().replace(/^(["'])(.*)\1$/, "$2") || null;
  }
  return null;
}

/** The cloud request for one clip: form fields as [name, value] pairs (the file is added by the caller). */
export function cloudFields(engine, lang, prompt) {
  const f = { model_id: "scribe_v2", tag_audio_events: "false", ...(lang ? { language_code: lang } : {}), ...engine.fields };
  const out = [];
  for (const [k, v] of Object.entries(f)) {
    if (k === "language_code" && v === "auto") continue;
    if (k === "keyterms") {
      const terms = (v === "@" ? prompt : v) || "";
      for (const t of terms.split(",").map((x) => x.trim()).filter(Boolean)) out.push(["keyterms", t]);
    } else out.push([k, v]);
  }
  return out;
}

async function askCloud(engine, buf, name, lang, prompt, key) {
  const form = new FormData();
  form.append("file", new Blob([new Uint8Array(buf)], { type: "audio/wav" }), name);
  for (const [k, v] of cloudFields(engine, lang, prompt)) form.append(k, v);
  const t = performance.now();
  let r;
  try { r = await fetch(CLOUD_URL, { method: "POST", headers: { "xi-api-key": key }, body: form, signal: AbortSignal.timeout(20_000) }); }
  catch (e) { return { text: `<<${e?.name === "TimeoutError" ? "timeout" : "network error"}>>`, ms: performance.now() - t }; }
  const j = await r.json().catch(() => ({}));
  const ms = performance.now() - t;
  if (!r.ok) return { text: `<<HTTP ${r.status}>>`, ms };
  return { text: String(j.text ?? "").replace(/\s+/g, " ").trim(), ms };
}

const median = (xs) => (xs.length ? [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)] : 0);

async function ask(engine, buf, name, lang, prompt) {
  const form = new FormData();
  form.append("file", new Blob([new Uint8Array(buf)], { type: "audio/wav" }), name);
  form.append("response_format", "verbose_json");
  if (lang) form.append("language", lang);
  for (const [k, v] of Object.entries(engine.fields)) {
    if (k === "prompt" && v === "@") { if (prompt) form.append("prompt", prompt); }
    else form.append(k, v);
  }
  const t = performance.now();
  const r = await fetch(engine.url, { method: "POST", body: form });
  const ms = performance.now() - t;
  if (!r.ok) return { text: `<<HTTP ${r.status}>>`, ms };
  const j = await r.json().catch(() => ({}));
  return { text: String(j.text ?? "").replace(/\s+/g, " ").trim(), ms };
}

async function main() {
  const argv = process.argv.slice(2);
  const many = (flag) => argv.flatMap((a, i) => (a === flag && argv[i + 1] ? [argv[i + 1]] : []));
  const one = (flag, dflt) => many(flag)[0] ?? dflt;
  const dir = one("--dir");
  const engines = many("--engine").map(parseEngine);
  if (!dir || !engines.length) {
    console.error("usage: node scripts/stt-bench.mjs --dir <folder> --engine <name>=<url>[;field=value…] [--engine cloud=elevenlabs[;keyterms=@]] [--secrets .secrets] [--lang es] [--prompt …] [--pad-ms N] [--repeat N] [--filter re] [--json]");
    process.exit(2);
  }
  const lang = one("--lang", "es"), prompt = one("--prompt", ""), padMs = Number(one("--pad-ms", 0)), repeat = Math.max(1, Number(one("--repeat", 1)));
  const filter = one("--filter") ? new RegExp(one("--filter")) : null;
  const json = argv.includes("--json");
  const key = engines.some((e) => e.url === "elevenlabs") ? cloudKey(process.env, one("--secrets", ".secrets")) : null;
  if (engines.some((e) => e.url === "elevenlabs") && !key) {
    console.error("the cloud engine needs ELEVENLABS_API_KEY (environment, or --secrets <file>)");
    process.exit(2);
  }
  const refs = loadRefs(dir);
  const files = fs.readdirSync(dir).filter((f) => f.endsWith(".wav") && (!filter || filter.test(f))).sort();
  const report = [];
  for (const e of engines) {
    const rows = [], times = [];
    let errs = 0, words = 0, cmdOk = 0, cmdN = 0;
    for (const f of files) {
      const buf = padWav(fs.readFileSync(path.join(dir, f)), padMs);
      let out = { text: "", ms: 0 };
      for (let i = 0; i < repeat; i++) { out = e.url === "elevenlabs" ? await askCloud(e, buf, f, lang, prompt, key) : await ask(e, buf, f, lang, prompt); times.push(out.ms); }
      const ref = refs.get(f) ?? null;
      let wrong = null;
      if (ref != null) {
        const [x, n] = wordErrors(ref, out.text);
        wrong = x; errs += x; words += n;
        if (n <= 2) { cmdN++; if (x === 0) cmdOk++; }
      }
      rows.push({ file: f, ref, heard: out.text, errors: wrong, ms: Math.round(out.ms) });
    }
    report.push({ engine: e.name, url: e.url, fields: e.fields, clips: files.length, wer: words ? errs / words : null, errors: errs, words, commands_ok: cmdOk, commands: cmdN, median_ms: Math.round(median(times)), max_ms: Math.round(Math.max(0, ...times)), rows });
  }
  if (json) return console.log(JSON.stringify(report, null, 2));
  for (const r of report) {
    console.log(`\n== ${r.engine}  ${r.url}${Object.keys(r.fields).length ? "  " + JSON.stringify(r.fields) : ""}`);
    for (const row of r.rows) {
      if (row.ref == null) console.log(`  ${row.file}  → ${row.heard || "(nothing)"}`);
      else if (row.errors) console.log(`  ${row.errors} wrong  ${row.file}  "${row.ref}"\n           → ${row.heard || "(nothing)"}`);
    }
    console.log(
      `  ${r.words ? `WER ${r.errors}/${r.words} = ${(100 * r.wer).toFixed(1)}%` : "no references"}` +
        (r.commands ? ` · commands ${r.commands_ok}/${r.commands} exact` : "") +
        ` · latency median ${r.median_ms} ms, max ${r.max_ms} ms · ${r.clips} clips`,
    );
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname)) {
  main().catch((e) => { console.error(String(e?.message ?? e)); process.exit(1); });
}
