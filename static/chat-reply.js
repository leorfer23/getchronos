// Reply to one bubble in Robert's chat. Hover a bubble (tap it, on touch) → ↩ → the bubble is quoted
// above the composer (✕ or ⎋ drops it) and rides the next line you send as `replyTo: {id, side}`.
// The daemon reads the quoted text back from that row and puts it above your words for him, so he
// knows which comment you are answering. The line you sent shows a one-line quote of its parent;
// clicking it scrolls to the parent. Shared by the Desk and the phone; each page says where its log,
// composer and the quote strip go, and marks its own bubbles (a bubble is a chat row + which half).
(() => {
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  // Same rules as quoteExcerpt in src/store/chat.ts: one line of plain words out of markdown.
  const excerpt = (t, max = 240) => {
    const s = String(t ?? "")
      .replace(/```[\s\S]*?```/g, " ")
      .replace(/^::ask [0-9a-f-]{8,36}::$/gm, "a question for you") // an Ask card (static/ask-card.js)
      .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
      .replace(/^[ \t]*(?:#{1,6}|>|[-*+]|\d+\.)[ \t]+/gm, "")
      .replace(/\*\*|__|~~|[*`]/g, "")
      .replace(/\s+/g, " ")
      .trim();
    return s.length > max ? s.slice(0, max - 1).trimEnd() + "…" : s;
  };
  const who = (side) => (side === "reply" ? "Robert" : "You");
  const ICON = `<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 14 4 9l5-5"/><path d="M4 9h10.5a5.5 5.5 0 0 1 0 11H11"/></svg>`;
  const css = `.bub[data-rid]{position:relative}
.bub .rp{position:absolute;top:6px;width:28px;height:28px;padding:0;border-radius:50%;border:1px solid var(--line,#333);background:var(--surface,#1b1b1f);color:var(--muted,#888);display:flex;align-items:center;justify-content:center;cursor:pointer;opacity:0;pointer-events:none;transition:opacity .12s}
.bub .rp::before{content:"";position:absolute;inset:-8px}
.bub.you .rp{right:calc(100% + 6px)}
.bub.rob .rp{left:calc(100% + 6px)}
.bub .rp:hover{color:var(--accent,#5b8cff);border-color:var(--accent,#5b8cff)}
@media (hover:hover){.bub[data-rid]:hover>.rp{opacity:1;pointer-events:auto}}
.bub.rp-on>.rp{opacity:1;pointer-events:auto}
.rq{display:flex;gap:6px;align-items:baseline;min-width:0;padding:3px 10px;border-left:3px solid var(--accent,#5b8cff);border-radius:6px;background:var(--surface-2,#222);color:var(--muted,#888);font-size:13.5px;line-height:1.4;white-space:nowrap}
.rq b{flex:none;color:var(--accent,#5b8cff);font-weight:700}
.rq span{overflow:hidden;text-overflow:ellipsis;min-width:0}
.bub .rq{max-width:min(100%,380px);margin:0 0 6px;cursor:pointer}
.bub.rob .rq{background:var(--surface,#1b1b1f)}
.bub.you .rq{background:rgba(255,255,255,.18);border-left-color:currentColor;color:inherit}
.bub.you .rq b{color:inherit}
.rbar{display:flex;align-items:center;gap:8px;padding:9px 12px 0;background:inherit}
.rbar[hidden]{display:none}
.rbar .rq{flex:1}
.rbar .rx{flex:none;border:0;background:transparent;color:var(--faint,#777);font-size:13px;line-height:1;padding:4px 6px;cursor:pointer}
.rbar .rx:hover{color:var(--danger,#e5484d)}
@keyframes rqhit{0%,40%{box-shadow:0 0 0 2px var(--accent,#5b8cff)}100%{box-shadow:0 0 0 2px transparent}}
.bub.rq-hit{animation:rqhit 1.4s ease-out}`;
  document.head.insertAdjacentHTML("beforeend", `<style>${css}</style>`);

  const quoteHtml = (q) => `<b>${esc(who(q.side))}</b><span>${esc(excerpt(q.text))}</span>`;

  // log: the scrolling list of .bub · input: the composer · before: the strip goes right above it.
  window.ChatReply = function attach({ log, input, before, onMissing }) {
    const bar = document.createElement("div");
    bar.className = "rbar"; bar.hidden = true;
    before.parentElement.insertBefore(bar, before);
    let cur = null; // {id, side, text}
    let touch = false;

    const set = (q) => {
      cur = q;
      bar.hidden = !q;
      bar.innerHTML = q ? `<div class="rq" title="${esc(excerpt(q.text, 600))}">${quoteHtml(q)}</div><button type="button" class="rx" title="Don't reply to it (⎋)" aria-label="Cancel reply">✕</button>` : "";
    };
    bar.addEventListener("click", (e) => { if (e.target.closest(".rx")) { set(null); input.focus(); } });
    input.addEventListener("keydown", (e) => {
      // ⎋ drops the quote first; only a second ⎋ does whatever the page does with it.
      if (e.key === "Escape" && cur) { e.preventDefault(); e.stopPropagation(); set(null); }
    });

    log.addEventListener("pointerdown", (e) => { touch = e.pointerType === "touch" || e.pointerType === "pen"; });
    log.addEventListener("click", (e) => {
      const rp = e.target.closest(".rp");
      if (rp) {
        const b = rp.closest(".bub");
        set({ id: Number(b.dataset.rid), side: b.dataset.rside, text: b._raw ?? b.textContent });
        b.classList.remove("rp-on");
        input.focus();
        return;
      }
      const rq = e.target.closest(".bub .rq");
      if (rq) {
        const t = log.querySelector(`.bub[data-rid="${CSS.escape(rq.dataset.to)}"][data-rside="${CSS.escape(rq.dataset.side)}"]`);
        if (!t || t.offsetParent === null) return onMissing?.();
        t.scrollIntoView({ block: "center", behavior: "smooth" });
        t.classList.remove("rq-hit"); void t.offsetWidth; t.classList.add("rq-hit");
        return;
      }
      // Touch has no hover: a tap on a bubble shows its ↩ (and hides any other).
      if (!touch || e.target.closest("a, button, input, textarea, select")) return;
      const b = e.target.closest(".bub[data-rid]");
      for (const o of log.querySelectorAll(".bub.rp-on")) if (o !== b) o.classList.remove("rp-on");
      if (b) b.classList.toggle("rp-on");
    });

    return {
      // This bubble is half `side` of chat row `id`: it can be replied to.
      mark(bub, id, side) {
        if (!bub || !id) return bub;
        bub.dataset.rid = id; bub.dataset.rside = side;
        // First, not last: after the markdown's trailing "\n" even an out-of-flow button makes a
        // pre-wrap bubble (yours) grow a blank line.
        if (!bub.querySelector(":scope > .rp")) bub.insertAdjacentHTML("afterbegin", `<button type="button" class="rp" title="Reply" aria-label="Reply">${ICON}</button>`);
        return bub;
      },
      // Draw the parent a line answers, at the top of that line's bubble.
      quote(bub, q) {
        if (!bub || !q?.text) return bub;
        bub.querySelector(":scope > .rq")?.remove();
        const d = document.createElement("div");
        d.className = "rq"; d.dataset.to = q.id; d.dataset.side = q.side; d.title = "Show the message this answers";
        d.innerHTML = quoteHtml(q);
        const chip = bub.querySelector(":scope > .wsc");
        bub.insertBefore(d, chip ? chip.nextSibling : bub.firstChild);
        return bub;
      },
      // The quote waiting in the composer, handed to the line being sent (and cleared).
      take() { const q = cur; set(null); return q; },
      get: () => cur,
    };
  };
  // A stored row's quote (GET /agent/history), or null.
  window.ChatReply.fromRow = (m) => {
    if (!m?.reply_to || !m.reply_quote) return null;
    try { const q = JSON.parse(m.reply_quote); return q?.text ? { id: m.reply_to, side: q.side, text: q.text } : null; } catch { return null; }
  };
})();
