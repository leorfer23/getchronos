import os from "node:os";
import path from "node:path";

/**
 * Where `chronos host` keeps its state: `.secrets` (the host token, Access credentials), `outbox/`
 * (queued `mc` writes, each with its workspace token), `spill/` (terminal output), `name`, and on a
 * packaged install `app/` (the code). Builtins only and no side effects, so config.ts can name it in
 * the sandbox without importing env.ts — which loads `.secrets` the moment it is imported.
 */
export function hostHomeDir(): string {
  return process.env.CHRONOS_HOST_HOME || path.join(os.homedir(), ".chronos-host");
}
