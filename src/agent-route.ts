/**
 * Does the voice front (src/talker.ts) answer this POST /agent line? Only with the setting on, and
 * never a line that carries files (the front reads none). Off → exactly today's path. Pure, so a test
 * pins it.
 */
export function frontTakes(body: { attachments?: unknown[] | null }, on: boolean): boolean {
  return on && !(Array.isArray(body.attachments) && body.attachments.length);
}
