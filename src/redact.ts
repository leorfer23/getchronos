// Mask credential-shaped keys in a workspace's connector_config before it reaches an API response.
// connector_config is stored as a raw JSON string (clickup token, jira api_token, ...) — see
// src/store/workspaces.ts. Read routes (GET /workspaces) are open on localhost for agents, so this
// is the only thing standing between a sandboxed agent and a client's connector credentials.
export const CRED_KEY_RE = /token|key|secret|password|passwd/i;
export const CRED_MASK = "••••••••";

export function redactConnectorConfig(raw: unknown): unknown {
  if (typeof raw !== "string" || !raw) return raw;
  try {
    const obj = JSON.parse(raw);
    if (!obj || typeof obj !== "object") return raw;
    for (const k of Object.keys(obj)) if (CRED_KEY_RE.test(k)) obj[k] = CRED_MASK;
    return JSON.stringify(obj);
  } catch {
    return raw;
  }
}

// Merge patch config with stored config, preserving masked credentials. On round-trip through
// GET (which masks creds) → PATCH (which may include masked values), masked values are replaced
// with their stored originals; explicit new values overwrite. Used by workspaces.update() to avoid
// the silent credential clobber bug (PER-40).
export function mergeConnectorConfigWithSentinel(
  curConfigStr: string | null,
  patchConfig: Record<string, unknown>
): string | null {
  if (!patchConfig || typeof patchConfig !== "object") {
    return curConfigStr;
  }

  let curConfig: Record<string, unknown> = {};
  if (curConfigStr) {
    try {
      const parsed = JSON.parse(curConfigStr);
      if (parsed && typeof parsed === "object") curConfig = parsed;
    } catch {
      // unparseable stored config → start fresh
    }
  }

  const merged: Record<string, unknown> = {};
  for (const k of Object.keys(patchConfig)) {
    const patchVal = patchConfig[k];
    if (patchVal === CRED_MASK) {
      merged[k] = curConfig[k] ?? patchVal;
    } else {
      merged[k] = patchVal;
    }
  }

  return Object.keys(merged).length > 0 ? JSON.stringify(merged) : null;
}

// A trigger's `token` is a bearer credential for its hook URL (src/api.ts hook route trusts it
// alone, no other auth) — same shape as the workspace `token` PER-15 stripped. Drop both the raw
// token and the derived hook_url (which embeds it) from any response unless the caller presents
// the admin header, mirroring wsWithRepos's destructure-omit rather than masking-in-place.
export function publicTrigger<T extends { token?: string | null; hook_url?: string }>(
  t: T,
  isAdmin: boolean
): T {
  if (isAdmin) return t;
  const { token: _token, hook_url: _hookUrl, ...rest } = t;
  return rest as T;
}
