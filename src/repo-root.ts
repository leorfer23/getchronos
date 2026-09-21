import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * The daemon's own checkout — `src/` (or, once built, `dist/`) sits exactly one level under it.
 *
 * Everything Chronos keeps beside its code resolves from here: the database, the admin token, the
 * notes mirror, attachments, backups, the skills vault. It used to be a literal `~/chronos` in a
 * dozen places, which meant the repo could only ever live at that one path and every one of those
 * call sites was a separate thing to fix.
 *
 * `CHRONOS_HOME` overrides it for the case where you want the code in one place and the state in
 * another — a read-only checkout, or a state directory on a different volume.
 *
 * This is its own module rather than a field on CONFIG because `src/config.ts` and
 * `src/egress-ca.ts` both need it and already import each other; a leaf with no imports of its own
 * cannot close that cycle.
 */
export const REPO_ROOT =
  process.env.CHRONOS_HOME || path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** A path under the daemon's state directory. `inRepo("notes", slug)` → `<root>/notes/<slug>`. */
export const inRepo = (...parts: string[]): string => path.join(REPO_ROOT, ...parts);
