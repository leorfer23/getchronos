// Store-free: imported by the brain (registry.ts) and by `chronos host` (hostd/terminals.ts), which
// must never open a Chronos database. Moved out of registry.ts unchanged.

/**
 * One key per repository, whatever way it was cloned: `git@github.com:o/r.git`,
 * `ssh://git@github.com:22/o/r`, `https://user@github.com/o/r/` all become `github.com/o/r`.
 * Host is lowercased (DNS is case-insensitive); the path keeps its case except on GitHub/GitLab/
 * Bitbucket, which treat owner/repo case-insensitively. Null for anything unrecognisable, so a
 * garbage remote never matches another garbage remote.
 */
export function normalizeGitRemote(url: string | null | undefined): string | null {
  let s = String(url ?? "").trim();
  if (!s) return null;
  let host: string, p: string;
  const scp = /^(?:[^@/\s]+@)?([^:/\s]+):(?!\/)(.+)$/.exec(s);
  const full = /^(?:git\+)?(?:ssh|https?|git):\/\/(?:[^@/\s]+@)?([^/:\s]+)(?::\d+)?\/(.+)$/i.exec(s);
  if (full) [, host, p] = full;
  else if (scp && !/^[a-z]+:\/\//i.test(s)) [, host, p] = scp;
  else return null;
  p = p.replace(/[?#].*$/, "").replace(/\/+$/, "").replace(/\.git$/i, "").replace(/\/+$/, "").replace(/^\/+/, "");
  if (!p || !host) return null;
  host = host.toLowerCase();
  if (/^(www\.)?(github\.com|gitlab\.com|bitbucket\.org)$/.test(host)) { host = host.replace(/^www\./, ""); p = p.toLowerCase(); }
  return `${host}/${p}`;
}
