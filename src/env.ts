import path from "node:path";
import { parseEnvFile } from "./env-file.js";

// Load ./.secrets (KEY=VALUE, optional `export ` prefix) into process.env before anything else.
// Imported first in index.ts so config.ts sees these values. Existing env wins.
const file = path.join(process.cwd(), ".secrets");
try {
  for (const [key, val] of Object.entries(parseEnvFile(file))) {
    if (process.env[key] === undefined) process.env[key] = val;
  }
  console.log("[env] loaded .secrets");
} catch {
  // no .secrets file — rely on the ambient environment
}
