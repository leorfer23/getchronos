#!/usr/bin/env node
// Replace a workspace's tracker credential (ClickUp personal token, Jira API token, …) without it
// ever touching argv — so it stays out of shell history, out of `ps`, and out of any transcript.
//
//   node scripts/set-connector-token.mjs acme              # prompts; input is not echoed
//   pbpaste | node scripts/set-connector-token.mjs acme    # or pipe it
//   node scripts/set-connector-token.mjs globex --key api_token
//   node scripts/set-connector-token.mjs acme --dry-run    # show the patch, write nothing
//
// The PATCH goes through the local API, whose connector_config merge reads the redaction mask as
// "keep what is stored" — so every OTHER secret in that config survives a one-key rotation. It then
// runs one real sync, because a credential you haven't used is a credential you haven't fixed.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";

const CRED_MASK = "••••••••"; // keep in sync with src/redact.ts
const VALUE_FLAGS = new Set(["--key", "--port"]);
const argv = process.argv.slice(2);
const flag = (name, def) => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : def;
};
const positional = argv.filter((a, i) => !a.startsWith("--") && !VALUE_FLAGS.has(argv[i - 1]));
const slug = positional[0];
const key = flag("--key", "token");
const port = flag("--port", process.env.CHRONOS_PORT || "7777");
const dryRun = argv.includes("--dry-run");
const base = `http://localhost:${port}/api`;

const die = (msg, code = 2) => { console.error(msg); process.exit(code); };
if (!slug) die("usage: node scripts/set-connector-token.mjs <workspace-slug> [--key token] [--port 7777] [--dry-run]");

// Same file the native overlay reads. Never passed as an argument for the same reason as the token.
const adminToken =
  process.env.CHRONOS_ADMIN_TOKEN ||
  (() => {
    try {
      return fs.readFileSync(path.join(os.homedir(), "chronos", ".admin-token"), "utf8").trim();
    } catch {
      die("no admin token: set CHRONOS_ADMIN_TOKEN, or run this on the daemon host");
    }
  })();
const H = { "content-type": "application/json", "x-mc-admin": adminToken };

const call = async (method, p, body) => {
  const r = await fetch(base + p, { method, headers: H, body: body ? JSON.stringify(body) : undefined });
  const text = await r.text();
  if (!r.ok) throw new Error(`${method} ${p} → ${r.status}: ${text.slice(0, 300)}`);
  return text ? JSON.parse(text) : null;
};

// No echo: readline prints the prompt and nothing else, so the token never lands on screen either.
const askHidden = (prompt) =>
  new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    rl._writeToOutput = (s) => { if (s.includes(prompt)) rl.output.write(prompt); };
    rl.question(prompt, (a) => { rl.close(); process.stdout.write("\n"); resolve(a); });
  });
const readStdin = async () => {
  let buf = "";
  for await (const chunk of process.stdin) buf += chunk;
  return buf;
};

const list = await call("GET", "/workspaces");
const ws = list.find((w) => w.slug === slug || w.id === slug);
if (!ws) die(`no workspace '${slug}' — have: ${list.map((w) => w.slug).join(", ")}`);
if (!ws.ticket_connector || ws.ticket_connector === "native")
  die(`workspace '${ws.slug}' has no external tracker (ticket_connector=${ws.ticket_connector})`);

const secret = (process.stdin.isTTY ? await askHidden(`${ws.slug} ${ws.ticket_connector} ${key}: `) : await readStdin()).trim();
if (!secret) die("empty credential — nothing written");
if (secret === CRED_MASK) die("that is the redaction mask, not a credential — nothing written");

// The whole config goes back, masked values included: the API restores each masked key from what it
// already holds, so only `key` actually changes.
//
// GET returns connector_config as a JSON STRING (redacted in place), not an object — spreading it
// raw turns the config into a map of single characters and wipes list_id / status_map / jql with it.
const current = (() => {
  const raw = ws.connector_config;
  if (!raw) return {};
  if (typeof raw === "object") return raw;
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    die(`workspace '${ws.slug}' has an unparseable connector_config — fix it in the DB first, not from here`);
  }
})();
const cfg = { ...current, [key]: secret };
if (dryRun) {
  console.log(`[dry run] PATCH /workspaces/${ws.id}`, JSON.stringify({ connector_config: { ...cfg, [key]: `<${secret.length} chars>` } }));
  process.exit(0);
}
await call("PATCH", `/workspaces/${ws.id}`, { connector_config: cfg });
console.log(`${ws.slug}: ${ws.ticket_connector} ${key} updated (${secret.length} chars) — syncing…`);

try {
  const r = await call("POST", `/workspaces/${ws.id}/sync`);
  console.log(`sync ok: pulled ${r.pulled}, created ${r.created}, updated ${r.updated}${r.errors?.length ? `, errors: ${r.errors.join("; ")}` : ""}`);
} catch (e) {
  die(`sync FAILED with the new credential: ${e.message}`, 1);
}
