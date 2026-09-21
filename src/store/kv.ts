import { db } from "./db.js";

// Tiny generic key/value store — telegram per-chat state (active workspace, resumed session id,
// linked chat id) lives here so it survives daemon restarts. Callers keep their own in-memory cache.
export const kv = {
  get(key: string): string | undefined {
    return (db.prepare("SELECT value FROM kv WHERE key = ?").get(key) as { value: string } | undefined)?.value;
  },
  set(key: string, value: string): void {
    db.prepare("INSERT INTO kv (key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(key, value);
  },
  del(key: string): void {
    db.prepare("DELETE FROM kv WHERE key = ?").run(key);
  },
};
