import { bus } from "./bus.js";
import { notify, notifyInfo } from "./telegram/api.js";

// Content guard (inspired by Hermes "Skills Guard"): static-scan agent-AUTHORED text before it is
// injected into another agent's system prompt or persisted as standing context. Agents can write
// notes/memos/tickets — some sourced from untrusted input (e.g. a Slack DM a triage agent read) —
// and that text can later be auto-injected (contextBlock) into EVERY agent in the workspace. This
// is a prompt-injection + exfiltration surface. The egress firewall caps WHERE data can go; this
// caps WHAT instructions can ride back in. Flagged spans are redacted to ⟦BLOCKED:rule⟧ and the
// operator is alerted. Heuristic regex (not a sandbox) — defense-in-depth, not a hard boundary.

export interface GuardFinding { rule: string; match: string; }
export interface GuardResult { clean: string; findings: GuardFinding[]; }

const RULES: Array<{ name: string; re: RegExp }> = [
  // Reaching for credential / secret stores.
  { name: "secret-store", re: /(~\/\.ssh\b|~\/\.aws\b|\.aws\/credentials|\bid_rsa\b|\.kube\/config|\.admin-token\b|\.config\/gws\b|\bgws\s+auth\s+export\b|CLAUDE_CONFIG_DIR|security\s+find-(generic|internet)-password|login\.keychain)/gi },
  // Exfiltrating env/tokens over the network (curl/wget/nc … $SOMETHING_KEY/TOKEN/SECRET).
  { name: "env-exfil", re: /\b(curl|wget|nc|ncat|fetch)\b[^\n]{0,80}\$\{?\w*(API|KEY|TOKEN|SECRET|PASSWORD|PASSWD|CRED)\w*/gi },
  // Dumping the environment / reading dotenv.
  { name: "env-dump", re: /\b(printenv\b|env\s*\||cat\s+[^\n]{0,40}\.env\b|process\.env\b)/gi },
  // Classic prompt-injection / instruction-override phrasing.
  // Branch 1 — verb→quantifier→noun: "ignore all previous instructions", "disregard the above system prompt".
  //   'system' is NOT a quantifier (it is the lead word of the noun "system prompt"); listing it as one
  //   made the lazy gap consume it and leave bare "prompt", which is not in the noun set.
  // Branch 2 — verb→optional determiner/adjective→system prompt: "ignore system prompt",
  //   "ignore the system prompt", "override the current system prompt". Closed word list only (no free
  //   {0,N} gap) so product copy like "override via system prompt" / "disregard in the system prompt
  //   reference" does not match.
  { name: "prompt-injection", re: /((ignore|disregard|forget|bypass|override)\b[^.\n]{0,40}?\b(all|previous|above|prior|any\s+of\s+the|these|your|the\s+following)\b[^.\n]{0,40}\b(instructions|rules|system\s*prompt|guardrails?|guidelines)|(ignore|disregard|forget|bypass|override)\b(?:\s+(?:the|this|that|your|our|my|a|an))?(?:\s+(?:current|actual|default|existing|new))?\s*system\s*prompt\b|you\s+are\s+now\b|new\s+(system\s+)?(instructions|prompt)\b|reveal\s+[^.\n]{0,30}\b(system\s*prompt|instructions)|exfiltrat\w*|send\s+(the|your|all)\b[^.\n]{0,30}\b(secrets|tokens|api\s*keys?|credentials|env(ironment)?))/gi },
  // Beacons to raw IPs / known exfil sinks.
  { name: "beacon", re: /\b(curl|wget|fetch|nc|ncat)\b[^\n]{0,80}\b(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}|webhook\.site|requestbin\.\w+|pipedream\.net|ngrok\.io|burpcollaborator\.\w+|interactsh\.\w+|oast\.\w+|\.onion\b)/gi },
];

// Scan text; return a redacted copy + the findings. Idempotent and cheap.
export function scan(text: string): GuardResult {
  if (!text) return { clean: text ?? "", findings: [] };
  const findings: GuardFinding[] = [];
  let clean = text;
  for (const r of RULES) {
    clean = clean.replace(r.re, (m) => {
      findings.push({ rule: r.name, match: m.replace(/\s+/g, " ").slice(0, 120) });
      return `⟦BLOCKED:${r.name}⟧`;
    });
  }
  return { clean, findings };
}

const alertAt = new Map<string, number>(); // per-context debounce for the operator alert

// Scan + (if anything tripped) alert the operator. `where` labels the source for the alert/log.
// Returns the redacted text — callers should use this in place of the raw text.
export function guard(text: string, where: string, workspaceId?: string | null): string {
  const { clean, findings } = scan(text);
  if (!findings.length) return clean;
  const key = `${workspaceId ?? ""}:${where}`;
  const last = alertAt.get(key) ?? 0;
  const t = Date.now();
  const rules = [...new Set(findings.map((f) => f.rule))].join(", ");
  console.warn(`[guard] redacted ${findings.length} span(s) in ${where} (${rules})`);
  try { bus.publish({ topic: "guard.flagged", workspace_id: workspaceId ?? "", where, rules }); } catch {}
  if (t - last > 60_000) {
    alertAt.set(key, t);
    const sample = findings.slice(0, 3).map((f) => `• <code>${f.rule}</code>: ${f.match.replace(/[<>]/g, "")}`).join("\n");
    notifyInfo(`🚧 <b>content guard</b> redacted ${findings.length} span(s) in <b>${where}</b> (${rules})\n${sample}`).catch(() => {});
  }
  return clean;
}
