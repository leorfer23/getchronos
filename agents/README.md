# `agents/` — the named executives

One directory per agent. **The directory name is the id** — there is no `id:` field to keep in sync,
and nothing else in the codebase decides who an agent is.

```
agents/
  _blocks/<name>.md    prose several agents share, included verbatim
  <id>/AGENT.md        frontmatter (the knobs) + body (the "default" surface prompt)
  <id>/<surface>.md    an additional named surface — Robert's telegram / web
```

Loaded by [`src/agent-defs.ts`](../src/agent-defs.ts). Files are re-read when their mtime moves, so
**editing a persona takes effect on the next manager recycle without a rebuild** — `dist/` never
holds a copy of the prompt. Everything else in `src/` still needs `npm run deploy`.

## Frontmatter

| key | meaning |
|---|---|
| `name` | display name (required) |
| `description` | one line, what this agent is for (required) |
| `memory` | key of the durable memory file; defaults to the id |
| `model` | model id; omitted → `CONFIG.agent.voiceModel` |
| `tools` | `--allowed-tools` string; omitted → the WarmManager default |
| `cwd` | working directory |
| `sandbox` | `off` \| `guard` \| `strict` |
| `env` | indented `KEY: value` pairs passed to the process |

Values may use `{{placeholders}}`, and so may the body: `{{port}}`, `{{year}}`, `{{home}}`,
`{{panel_min_difficulty}}`, `{{admin_token}}`, `{{env.PATH}}`. The list is closed
on purpose — a persona file that could name any env var would be a way to read the daemon's secrets
into a model's context. An unknown placeholder throws at load rather than shipping literal `{{…}}`
to a live agent. Exception: digit-led forms like `{{0.id}}` are left literal — they document
Telegram PROPOSE batch prior-item refs, not persona vars.

## Shared prose

A line that is exactly `{{> block-name}}` is replaced by `_blocks/block-name.md`, verbatim. This is
what keeps the API catalog Robert reads on Telegram identical to the one he reads on the desk, and
what keeps two executives' shared prose from drifting apart — which it did, once, and is the whole
reason the blocks exist. Blocks carry their own trailing blank lines; the composed prompt is a
plain concatenation.

HTML comments are stripped before the prompt reaches the model, so a file can explain itself.

## Adding an executive

Robert ships as the only one. Add your own beside him — a QA gate, a researcher, an assistant for
whatever you do that is not code. The loader skips any `_`-prefixed directory, so `agents/_parked/`
is where an executive goes when you want the persona kept but not loadable.

1. `mkdir agents/<id>` and write `AGENT.md`.
2. Wire the entry points in `src/telegram/agent.ts` — `warmExecWeb` / `askExecWeb` are generic and
   take the id, so there is nothing to add unless the agent needs a named wrapper.
3. Add the handle to `EXEC_HANDLES` in `src/board.ts` so a board `@mention` wakes it, add it to
   `EXEC_ASK` in `src/api.ts` so its /app chat pane answers, to `EXEC_NAME` / `EXEC_LINE` /
   `EXEC_SLASH` in `src/telegram/active-exec.ts`, to `FleetAgent` + `AGENTS` + `ROTATION` +
   `CHECKLIST` + `LABEL` + `agentDigest` in `src/heartbeat.ts` if it should get a heartbeat slot,
   and to the /app chat roster in `static/app.html`.

`src/agent-defs.test.ts` covers the loader; it will fail if a prompt loses a shared block, if a
placeholder goes unresolved, or if an `_`-prefixed directory starts loading again.
