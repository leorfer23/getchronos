/**
 * `chronos host`'s boot environment. Imported FIRST by the host entry, before anything that reads
 * `process.env` at module load (config.ts via machine.ts) — the same reason `src/env.ts` is first in
 * the daemon.
 *
 * A host keeps its own state in `~/.chronos-host/`, never in the checkout: the checkout is just code
 * the host runs, and its `.secrets` (if any) belong to a brain that may or may not live on this Mac.
 */
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { parseEnvFile } from "../env-file.js";

export const HOST_HOME = process.env.CHRONOS_HOST_HOME || path.join(os.homedir(), ".chronos-host");
export const HOST_SECRETS = path.join(HOST_HOME, ".secrets");

try {
  for (const [k, v] of Object.entries(parseEnvFile(HOST_SECRETS))) {
    if (process.env[k] === undefined) process.env[k] = v;
  }
} catch {
  // Not joined yet (or `join` is about to write it): the ambient environment is all there is.
}

// config.ts mints and persists `.admin-token` beside the code when none is set. A host must never
// hold the brain's admin token — and must not litter a stray one into its checkout either — so the
// host process gets a throwaway value nothing will ever accept.
process.env.CHRONOS_ADMIN_TOKEN ||= "host-process-has-no-admin-" + crypto.randomBytes(12).toString("hex");
