# MCP bundles

One JSON per bundle, named by an agent's `mcp:` frontmatter key (`mcp: playwright` →
`playwright.json`). The file is interpolated with the same `{{...}}` vars as a persona and handed to
`claude --mcp-config` as a string, so `{{repo}}` / `{{home}}` keep machine paths out of git.

Executives always spawn with `--strict-mcp-config`: an agent that declares no bundle gets **no** MCP
servers, and one that declares a bundle gets exactly that bundle — never whatever the profile dir
happens to have configured. Declaring the bundle is not enough on its own: the tools also have to be
in the agent's `tools:` allowlist, as `mcp__<server>` (e.g. `mcp__playwright`).

## playwright

Microsoft's [Playwright MCP](https://github.com/microsoft/playwright-mcp) (Apache-2.0, free) — a real
Chromium the agent drives through the accessibility tree rather than screenshots: navigate, click,
type, fill forms, read the page, take a screenshot. Installed as a normal repo dependency
(`@playwright/mcp`), so there is no `npx` download at spawn time; the browser binary comes from
`npx playwright install chromium` and lives in `~/Library/Caches/ms-playwright`.

Two choices worth knowing about, both in the args:

- `--headless` — no window opens. Drop it to watch the agent browse (useful when debugging why a
  page won't cooperate); a daemon-spawned agent popping windows during a call is why it is the default.
- `--isolated` — the profile is in memory and dies with the process, so the agent is never logged in
  as anyone. Drop it and the browser keeps a persistent profile under
  `~/Library/Caches/ms-playwright/mcp-chrome-profile`, which means whatever you log that profile into,
  the agent can act as. Deliberate default: browsing is a research tool here, not an authenticated one.

File access is already restricted to the working directory by the server itself, and the Seatbelt
profile denies the real Chrome/Firefox/Brave profile directories, so the agent cannot borrow your
day-to-day cookies either way.
