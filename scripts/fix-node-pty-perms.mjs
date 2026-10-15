// node-pty@1.1.0 ships prebuilds/*/spawn-helper as 644 in its npm tarball (verified against the
// published tgz, not an artifact of our install) — posix_spawnp fails without the exec bit.
// Runs as a postinstall so every `npm ci` (local + CI) self-heals before tests spawn a pty.
//
// node-pty is found through module resolution, not `./node_modules/node-pty`: installed as a
// dependency (`npx getchronos`, ~/.chronos-host/app), this package's postinstall runs inside
// node_modules/getchronos while npm hoisted node-pty next to it — the relative path found nothing,
// and every terminal on such a host would have failed to spawn.
import { chmodSync, existsSync, readdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createRequire } from 'node:module';

let ptyRoot = join('node_modules', 'node-pty');
try {
  ptyRoot = dirname(createRequire(join(process.cwd(), 'package.json')).resolve('node-pty/package.json'));
} catch {}
const prebuildsDir = join(ptyRoot, 'prebuilds');
if (existsSync(prebuildsDir)) {
  for (const platformDir of readdirSync(prebuildsDir)) {
    const helper = join(prebuildsDir, platformDir, 'spawn-helper');
    if (existsSync(helper) && statSync(helper).isFile()) {
      chmodSync(helper, 0o755);
    }
  }
}
