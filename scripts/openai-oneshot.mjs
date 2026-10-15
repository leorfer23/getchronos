#!/usr/bin/env node
// One-shot call to any OpenAI-compatible /chat/completions endpoint. Prints a single claude-compatible
// stream-json result line so chronos's existing parsers (verifier/summarize) read it unchanged.
// Usage: node openai-oneshot.mjs <model> <prompt> [system]   (prompt falls back to stdin if arg empty)
// Env: OPENAI_API_KEY (required), OPENAI_BASE_URL (default https://api.openai.com/v1), OPENAI_MODEL (fallback)

const [, , modelArg, promptArg, systemArg] = process.argv;

async function readStdin() {
  const chunks = [];
  for await (const c of process.stdin) chunks.push(c);
  return Buffer.concat(chunks).toString("utf8").trim();
}

function emit(obj) {
  process.stdout.write(JSON.stringify(obj) + "\n");
}

const model = modelArg || process.env.OPENAI_MODEL || "gpt-4o-mini";
const prompt = promptArg || (await readStdin());
const base = (process.env.OPENAI_BASE_URL || "https://api.openai.com/v1").replace(/\/$/, "");
const key = process.env.OPENAI_API_KEY;

if (!key) {
  emit({ type: "result", is_error: true, result: "OPENAI_API_KEY not set" });
  process.exit(1);
}

const messages = [];
if (systemArg) messages.push({ role: "system", content: systemArg });
messages.push({ role: "user", content: prompt });

try {
  const res = await fetch(`${base}/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
    body: JSON.stringify({ model, messages }),
  });
  if (!res.ok) {
    const body = await res.text();
    emit({ type: "result", is_error: true, status_code: res.status, result: `HTTP ${res.status}: ${body.slice(0, 500)}` });
    process.exit(1);
  }
  const data = await res.json();
  const text = data.choices?.[0]?.message?.content ?? "";
  emit({
    type: "result",
    result: text,
    usage: { input_tokens: data.usage?.prompt_tokens ?? null, output_tokens: data.usage?.completion_tokens ?? null },
  });
} catch (e) {
  emit({ type: "result", is_error: true, result: String(e?.message ?? e) });
  process.exit(1);
}
