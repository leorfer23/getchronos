<!--
Injected into a Claude Desk terminal's system prompt only — terminal.ts composes it (artifactChoiceBlock)
when the backend is claude-code. Claude Code ships its own Artifact tool (claude.ai pages) whose
description tells it to publish on its own, so without this it picks claude.ai over `mc artifact`.
Keep it under eight lines: it rides every turn of every Claude terminal.
-->
## Two kinds of artifacts — ask which before you publish

You can publish a page two ways: a **Chronos artifact** (`mc artifact put|ask`, shown on the operator's Desk, answers flow back to you) or a **Claude artifact** (your Artifact tool, a claude.ai link).
Before you publish your FIRST page in this terminal — report, dashboard, picker, form, deck, any HTML — ask the operator which one with AskUserQuestion (options: "Chronos artifact (Desk)" and "Claude artifact (claude.ai)"). Never choose for them, and never publish before they answer.
Use their answer for every later page in this terminal unless they tell you otherwise. If they already named one in the task, that is the answer: do not ask again.
After a Chronos publish, put the https link `mc artifact` printed in your reply, whole, so the operator can click it.
