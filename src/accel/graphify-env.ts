/**
 * Minimal env for a graphify child. Deliberately does NOT use childEnv(ws) — that injects the
 * workspace's secrets_file and shared vars. Build/query must never see API keys or client secrets:
 * code-only extract needs none, and a leaked key in a sandboxed child is an egress/exfil risk even
 * with the network locked.
 */
const ALLOW = [
  "PATH", "HOME", "USER", "LOGNAME", "SHELL", "TMPDIR", "TERM", "LANG", "LC_ALL", "TZ", "COLORTERM",
];

export const GRAPHIFY_MAX_GRAPH_BYTES = 64 * 1024 * 1024;

export function graphifyChildEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const k of ALLOW) {
    if (process.env[k] !== undefined) env[k] = process.env[k];
  }
  if (!env.LANG && !env.LC_ALL) env.LANG = "en_US.UTF-8";
  env.GRAPHIFY_QUERY_LOG_DISABLE = "1";
  env.GRAPHIFY_MAX_GRAPH_BYTES = String(GRAPHIFY_MAX_GRAPH_BYTES);
  env.PYTHONDONTWRITEBYTECODE = "1";
  // Test-only seams for the fake executable. Never secrets.
  if (process.env.CHRONOS_TEST === "1") {
    for (const k of ["CHRONOS_GRAPHIFY_MARKER", "FAIL", "FAIL_EXTRACT", "BAD_OUT"]) {
      if (process.env[k] !== undefined) env[k] = process.env[k];
    }
  }
  // Belt-and-suspenders: never forward common secret names even if they somehow landed in ALLOW.
  for (const k of Object.keys(env)) {
    if (/API[_-]?KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|OPENAI|ANTHROPIC|GEMINI|AWS_|CHRONOS_ADMIN/i.test(k)) {
      delete env[k];
    }
  }
  return env;
}
