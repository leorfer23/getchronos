import { searchIndex, sessions } from "./store.js";

/** Upsert a session into full-text search after deterministic or AI metadata changes. */
export function indexSession(id: string): void {
  const s = sessions.get(id);
  if (!s) return;
  const tags = s.tags
    ? (() => {
        try {
          return (JSON.parse(s.tags) as string[]).join(" ");
        } catch {
          return "";
        }
      })()
    : "";
  searchIndex.removeRef(id);
  searchIndex.add({
    kind: "session",
    ref_id: id,
    workspace: s.workspace_id ?? "",
    title: `${s.ticket_key ? `${s.ticket_key} ` : ""}${s.goal ?? s.title ?? "chat"}`,
    body: [s.spawn_goal, s.first_prompt, s.summary, tags].filter(Boolean).join(" · "),
  });
}
