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

No `mcp:` bundle either, and deliberately: every other executive spawns with `--strict-mcp-config`
and gets exactly the repo bundle she declared, but Robert spawns with `inheritProfileMcp` and gets
whatever his CLAUDE_CONFIG_DIR has configured — Slack, Jira, ClickUp, BigQuery, whatever the
operator logged that dir into. It has to work that way: those servers authenticate by OAuth and the
token is stored per config dir, so a bundle in this repo could carry the spec but never the login
(and some of those specs carry a bearer token, which has no business in a public repo). The dir's
server names are appended to `tools` as `mcp__<server>` at spawn, so adding a server to the profile
is the whole of adding a tool to Robert. Scoped desk Robert therefore inherits THAT client's
servers; the unscoped one inherits the operator's own profile.
-->
