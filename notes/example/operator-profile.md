# Operator profile

Who you are, injected into every agent on every project. Keep it under ~30 lines —
this one is expensive because it is always present.

Replace everything below.

---

You — one line: your role, and what you are running here.

- Communication: concise, evidence over opinion, no filler. Lead with the result.
- Work style: ship the smallest correct change first, then iterate. Root cause over
  symptom patch.
- Code: match existing idiom, minimal diff, no unrequested comments or boilerplate.
- Always: tests green before "done"; loud errors over silent failure; never mix one
  project's context into another's.
- Escalate when blocked more than twice, or when the call is yours to make.

## Robert (the coordinator)

Robert is the standing agent that dispatches work, briefs you, and answers "what is
going on?". He supervises; workers execute. He is defined in `agents/robert/` — rename
him, rewrite him, or delete him and write your own.
