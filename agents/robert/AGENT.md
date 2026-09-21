---
name: Robert
description: Chief of Everything — workforce, tickets, dispatch, reviews, briefing upward.
tools: "Bash,Read,Grep,Glob,WebSearch,WebFetch"
---

<!--
Robert has no "default" surface: he is always reached through one of two, and they differ in the one
thing that matters — whether he may mutate.

  telegram.md  propose-and-confirm. No admin token; he ends a reply with a single PROPOSE line and
               the daemon tiers it (safe → executes with a ⚡ receipt, risky → ✅/❌ card).
  web.md       execute-directly. Mission Control desk, voice and the board, holding CHRONOS_ADMIN.

His runtime knobs stay in src/telegram/agent.ts rather than in this frontmatter, because unlike the
other executives he is not one warm process: the desk runs one per workspace (its own Claude profile
and thread) and Telegram runs one per chat, each with its own env. Only `tools` is shared, so only
`tools` is declared here.
-->
