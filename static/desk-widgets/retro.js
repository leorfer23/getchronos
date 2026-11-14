// "Weekly retro" — the client half of src/widgets/retro.ts. One block per workspace: four KPIs with
// last week beside them (lower is better for all four), the rules waiting on the operator with ✓ / ✕,
// and any approved rule that is not holding. The tap is his hand: it carries `x-mc-operator: 1`, the
// header only his own surfaces send (src/retro-routes.ts → operatorHand), and nothing else here writes.
import { el, fmtAgo } from "./lib.js";

const num = (v) => String(v ?? 0);
const KPIS = [
  ["rejection_rate", "verifier / hand-off", (v) => (v == null ? "–" : Number(v).toFixed(2))],
  ["repeat_asks", "repeat asks", num],
  ["infra", "infra interruptions", num],
  ["duplicates", "duplicate terminals", num],
];

/** "▼0.15" in the calm colour when it went down, "▲2" in the alarm colour when it went up. */
export function delta(now, prev, fmt) {
  if (now == null || prev == null) return null;
  const d = Number(now) - Number(prev);
  if (Math.abs(d) < 1e-9) return el("span", { text: " =", style: { color: "var(--faint)" } });
  return el("span", { text: ` ${d < 0 ? "▼" : "▲"}${fmt(Math.abs(d))}`, style: { color: d < 0 ? "var(--p-work)" : "var(--danger)" } });
}

function kpiLine(r) {
  const k = r.kpis || {}, p = r.last_week;
  return el("div", { style: { display: "flex", flexWrap: "wrap", gap: "4px 14px", fontSize: "13.5px" } },
    KPIS.map(([key, label, fmt]) => el("span", { title: p ? `last week ${fmt(p[key])}` : "first week on record" }, [
      el("b", { text: fmt(k[key]) }),
      delta(k[key], p ? p[key] : null, fmt),
      el("span", { text: ` ${label}`, style: { color: "var(--muted)" } }),
    ])));
}

function proposalRow(r, p, ctx) {
  const wrap = el("div", { style: { display: "flex", gap: "8px", alignItems: "baseline", padding: "3px 0", fontSize: "14px" } });
  const decide = async (decision) => {
    for (const b of wrap.querySelectorAll("button")) b.disabled = true;
    try {
      await ctx.api(`/workspaces/${encodeURIComponent(r.workspace_id)}/retro/proposals/${encodeURIComponent(p.id)}`, {
        method: "POST", headers: { "x-mc-operator": "1" }, body: JSON.stringify({ decision }),
      });
      ctx.toast(decision === "approve" ? (p.kind === "rule" ? "rule saved to this workspace's memory" : "filed as a backlog ticket") : "dismissed — it won't be proposed again");
      wrap.style.opacity = ".45";
    } catch (e) {
      ctx.toast(String(e && e.message || e).slice(0, 120));
      for (const b of wrap.querySelectorAll("button")) b.disabled = false;
    }
  };
  const btn = (label, title, decision) => el("button", {
    text: label, title, onclick: () => decide(decision),
    style: { border: "1px solid var(--line)", background: "var(--surface-2)", color: "var(--ink)", borderRadius: "6px", padding: "0 8px", cursor: "pointer", font: "inherit" },
  });
  const tag = p.kind === "product" ? "Chronos" : p.source === "verifier" ? "verifier" : `seen ${p.evidence}×`;
  wrap.append(
    el("span", { style: { flex: "1", minWidth: "0" }, title: p.detail || "" }, [p.text]),
    el("span", { text: tag, style: { color: "var(--faint)", fontSize: "12px", whiteSpace: "nowrap" } }),
    btn("✓", p.kind === "rule" ? "Approve — every agent here loads it from now on" : "Approve — file it as a backlog ticket", "approve"),
    btn("✕", "Dismiss — never proposed again", "dismiss"),
  );
  return wrap;
}

function block(r, ctx) {
  const kids = [
    el("div", { style: { display: "flex", alignItems: "baseline", gap: "8px", marginBottom: "2px" } }, [
      el("span", { text: ctx.wsName(r.workspace_id) || r.name, style: { fontSize: "12px", fontWeight: "700", letterSpacing: ".05em", textTransform: "uppercase", color: "var(--muted)" } }),
      r.run ? el("span", { text: `week to ${String(r.run.until).slice(0, 10)} · ${fmtAgo(r.run.gathered_at || r.run.created_at)} ago`, style: { color: "var(--faint)", fontSize: "12px" } }) : null,
    ]),
  ];
  if (r.kpis) kids.push(kpiLine(r));
  for (const f of r.failing || []) kids.push(el("div", { style: { color: "var(--warn)", fontSize: "13px" } }, [`⚠ not holding: "${f.text}" — asked again ${f.times}×`]));
  if ((r.pending || []).length) kids.push(...r.pending.map((p) => proposalRow(r, p, ctx)));
  if (r.run && r.run.report) {
    const d = el("details", { style: { marginTop: "2px" } }, [el("summary", { text: "report", style: { color: "var(--muted)", fontSize: "12.5px", cursor: "pointer" } })]);
    d.append(el("pre", { text: r.run.report, style: { whiteSpace: "pre-wrap", fontFamily: "inherit", fontSize: "13px", margin: "4px 0 0", color: "var(--ink)" } }));
    kids.push(d);
  }
  return el("div", { style: { borderLeft: `3px solid ${ctx.wsColor(r.workspace_id)}`, paddingLeft: "9px", margin: "4px 0 10px" } }, kids);
}

export default {
  name: "retro",
  title: "Weekly retro",
  refreshMs: 300000,
  topics: ["retro.updated"],

  render(body, data, ctx) {
    const rows = Array.isArray(data?.rows) ? data.rows : [];
    if (!rows.length) {
      body.replaceChildren(el("div", { class: "werr" }, ["no weekly retro yet — the first one runs on the next weekly slot"]));
      return;
    }
    body.replaceChildren(...rows.map((r) => block(r, ctx)));
  },
};
