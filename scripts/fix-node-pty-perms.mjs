// node-pty@1.1.0 ships prebuilds/*/spawn-helper as 644 in its npm tarball (verified against the
// published tgz, not an artifact of our install) — posix_spawnp fails without the exec bit.
// Runs as a postinstall so every `npm ci` (local + CI) self-heals before tests spawn a pty.
import { chmodSync, existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const prebuildsDir = join('node_modules', 'node-pty', 'prebuilds');
if (existsSync(prebuildsDir)) {
  for (const platformDir of readdirSync(prebuildsDir)) {
    const helper = join(prebuildsDir, platformDir, 'spawn-helper');
    if (existsSync(helper) && statSync(helper).isFile()) {
      chmodSync(helper, 0o755);
    }
  }
}
