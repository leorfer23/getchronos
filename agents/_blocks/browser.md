<!--
Injected into the system prompt (or folded into the seed) of every Desk terminal — terminal.ts composes
it (browserBlock). Why: on 2026-10-02 test runs that each launched their own Chrome left 188 headless
Chrome processes behind and took the Mac to load 30 (RESOURCES.md → Shared headless browser pool).
Keep it to a few lines: it rides every turn of every terminal.
-->
## Browsers — avoid them; borrow the shared one when you must

1. Avoid a browser: fetch the page (curl / fetch) and parse it with happy-dom, jsdom or linkedom; in tests, mock `env.BROWSER`.
2. Need real rendering or screenshots? `mc browser run -- <cmd>`. The command gets `CHRONOS_BROWSER_WS` + `CHRONOS_BROWSER_CONTEXT`: `puppeteer.connect({ browserWSEndpoint })` and use only that context (`browser.browserContexts().find((c) => c.id === …)`), or Playwright `chromium.connectOverCDP()` + `browser.newContext()`. Released when the command exits.
3. Never launch your own Chrome or Puppeteer/Playwright browser (`puppeteer.launch`, `chromium.launch`, wrangler's local Browser Rendering): each one leaks.
