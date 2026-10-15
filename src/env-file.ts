import fs from "node:fs";

// KEY=VALUE parser (optional `export ` prefix, #comments, single/double quotes). Throws if the
// file is unreadable — callers decide whether that's fatal.
// Lives alone, importing nothing but node builtins, because env.ts loads .secrets through it at
// boot *before* config.ts is allowed to evaluate. Its old home (child-env.ts) now reads the store,
// which pulls in config — importing that from env.ts would evaluate config before .secrets landed
// in process.env, i.e. the daemon would boot with half its configuration missing.
export function parseEnvFile(file: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of fs.readFileSync(file, "utf8").split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const m = line.replace(/^export\s+/, "").match(/^([A-Z0-9_]+)=(.*)$/);
    if (!m) continue;
    let val = m[2].trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'")))
      val = val.slice(1, -1);
    out[m[1]] = val;
  }
  return out;
}
