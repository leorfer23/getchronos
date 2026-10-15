// "Needs you" — one ordered list of everything the fleet is waiting on the operator for, answerable
// where it is read. A row is a terminal sitting on a prompt, or an open ask; the reader
// (src/widgets/decide.ts) hands each row the exact request that answers it, so this file posts what
// it was given and never decides for itself which door to knock on.
//
// Optimistic by design: a row you just answered greys out and STAYS PUT until the next read drops
// it. Removing it on the click would make the list jump under the cursor, and the chip you meant to
// press next would be somebody else's decision.
import { el, fmtAgo, PHASE_COLOR, PHASE_SOFT } from "./lib.js";

// What has been answered since the last read that still showed it. On the module, not on the DOM:
// render() replaces its output on every refresh, and the grey has to survive that.
const sent = new Set();

const MARK = { blocked: "■", decide: "?", review: "✓", your_turn: "↩" };

export default {
  name: "decide",
  title: "Needs you",
  refreshMs: 10000,
  topics: ["session.status", "ask.created", "ask.answered", "session.ended"],

  render(body, data, ctx) {
    const items = (data && data.items) || [];
    // Anything gone from the list has been answered for real, so stop remembering it — otherwise an
    // id that comes back (a terminal that asks a second thing) would render grey on arrival.
    const live = new Set(items.map((i) => i.id));
    for (const id of [...sent]) if (!live.has(id)) sent.delete(id);

    if (!items.length) {
      body.replaceChildren(el("div", { style: { color: "var(--muted)" } }, ["nothing needs you"]));
      return;
    }
    body.replaceChildren(...items.map((it, i) => row(it, ctx, i)));
  },
};

function row(it, ctx, i) {
  const colour = it.kind === "terminal" ? PHASE_COLOR[it.phase] || "var(--muted)" : "var(--p-decide)";
  const soft = it.kind === "terminal" ? PHASE_SOFT[it.phase] || "transparent" : "var(--p-decide-soft)";
  const node = el("div", {
    style: {
      display: "grid", gridTemplateColumns: "3px 1fr auto", gap: "0 10px", alignItems: "baseline",
      // No rule above the first row: the card header already draws one there.
      padding: "8px 0", borderTop: i ? "1px solid var(--line)" : "none",
    },
  });
  // The client's colour as a stripe down the row — the same read the rail gives, in the same colours.
  node.append(el("div", { style: { background: ctx.wsColor(it.workspace_id), borderRadius: "2px", alignSelf: "stretch" } }));

  const sess = it.kind === "terminal" ? ctx.byId(it.id) : null;
  const acts = el("div", { style: { display: "flex", flexWrap: "wrap", gap: "6px", marginTop: "6px", alignItems: "center" } });
  const grey = () => { node.style.opacity = ".45"; acts.replaceChildren(el("span", { text: "answered", style: { color: "var(--faint)", fontSize: "13px" } })); };
  const restore = () => { node.style.opacity = "1"; acts.replaceChildren(); fillActions(acts, it, ctx, grey, restore); };

  node.append(el("div", { style: { minWidth: "0" } }, [
    el("span", {
      title: it.phase || "ask",
      style: { color: colour, background: soft, borderRadius: "4px", padding: "0 5px", marginRight: "6px", fontSize: "12px" },
    }, [it.kind === "terminal" ? MARK[it.phase] || "·" : "?"]),
    el("b", { text: sess ? ctx.chipLabel(sess) : it.title, style: { fontSize: "14px" } }),
    it.kind === "ask" && ctx.wsName(it.workspace_id)
      ? el("span", { text: " · " + ctx.wsName(it.workspace_id), style: { color: "var(--faint)", fontSize: "13px" } })
      : null,
    el("div", { text: it.line, style: { color: "var(--muted)", fontSize: "14px", marginTop: "1px" } }),
    it.note ? el("div", { text: "Robert: " + it.note, style: { color: "var(--faint)", fontSize: "13px" } }) : null,
    acts,
  ]));
  node.append(el("span", { title: "waiting", style: { color: "var(--faint)", fontSize: "13px" } }, [fmtAgo(it.since)]));

  if (sent.has(it.id)) grey();
  else fillActions(acts, it, ctx, grey, restore);
  return node;
}

function fillActions(bar, it, ctx, grey, restore) {
  for (const o of it.options || []) bar.append(chip(o.label, () => send(it, o.body, ctx, grey, restore)));
  if (!(it.options || []).length) {
    // Nothing to pick from (a free question, a free-form ask): a line and Enter is the whole answer.
    const box = el("input", {
      type: "text",
      placeholder: "answer…",
      onkeydown: (e) => {
        if (e.key !== "Enter") return;
        e.preventDefault();
        const text = box.value.trim();
        if (text) send(it, { ...it.answer.body, [it.answer.field]: text }, ctx, grey, restore);
      },
      style: {
        flex: "1 1 160px", minWidth: "110px", font: "inherit", fontSize: "13px", padding: "3px 7px",
        color: "var(--ink)", background: "var(--surface-2)", border: "1px solid var(--line)", borderRadius: "6px",
      },
    });
    bar.append(box, el("span", { text: "⏎", style: { color: "var(--faint)", fontSize: "13px" } }));
  }
  if (it.kind === "terminal") bar.append(chip("open", () => ctx.stage(it.id)));
}

function chip(label, onclick) {
  return el("button", {
    onclick,
    style: {
      font: "inherit", fontSize: "13px", padding: "2px 9px", cursor: "pointer",
      color: "var(--ink)", background: "var(--surface-2)", border: "1px solid var(--line)", borderRadius: "999px",
    },
  }, [label]);
}

// The one mutation this card makes, through the route its own reader named. Grey first, and put the
// row back if the daemon refused it: an answer that silently did not land is worse than one that
// visibly did not.
async function send(it, body, ctx, grey, restore) {
  sent.add(it.id);
  grey();
  try {
    await ctx.api(it.answer.route, { method: "POST", body: JSON.stringify(body) });
  } catch (e) {
    sent.delete(it.id);
    restore();
    ctx.toast(String(e && e.message).slice(0, 120));
  }
}
