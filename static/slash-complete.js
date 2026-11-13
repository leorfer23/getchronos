// `/` in a terminal's composer: what THAT terminal's CLI offers — its own commands first, then the
// skills, custom commands and plugin commands its session loads (GET /api/sessions/:id/commands,
// src/session-commands.ts) — filtered as you type. ↑/↓ move, ⏎ or ⇥ (or a tap) drops the exact
// invocation in, ⎋ closes; the active row says what it does. Shared by the Desk and the phone, and so
// is the panel behind the composer's model chip (panelHtml): the same answer, browsed instead of typed.
//
// Same keyboard rules as `#` (static/tag-complete.js), and the two never open on the same caret: `/`
// counts only as the input's very first character with nothing but the word before the caret, `#` only
// at the start or after a space — `/review #acme` is a command, then a project after the space.
(() => {
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const GROUPS = [["builtin", "Built-in"], ["skill", "Skills"], ["command", "Commands"], ["plugin", "Plugins"]];
  const LABEL = Object.fromEntries(GROUPS);
  const ROWS_MAX = 200;
  const TTL_MS = 60000, ERR_TTL_MS = 5000;
  // Theme tokens only, no motion: the Desk and the phone define the same names (static/desk.html, phone.html).
  const css = `.slashc{position:absolute;left:0;right:0;bottom:calc(100% + 6px);z-index:60;background:var(--surface);border:1px solid var(--line);border-radius:12px;padding:4px;box-shadow:var(--shadow,0 8px 28px rgba(0,0,0,.28));max-height:min(340px,46vh);overflow-y:auto;overscroll-behavior:contain;text-align:left}
.slashc[hidden]{display:none}
.slashc .h{padding:7px 10px 3px;font-size:11px;font-weight:700;letter-spacing:.07em;text-transform:uppercase;color:var(--faint)}
.slashc button{display:block;width:100%;text-align:left;border:0;background:none;color:var(--ink);font:inherit;font-size:14.5px;line-height:1.35;padding:6px 10px;border-radius:8px;cursor:pointer;min-height:0}
.slashc button .n{font-weight:600}
.slashc button .a{color:var(--faint);margin-left:7px;font-size:13px}
.slashc button .w{float:right;color:var(--faint);font-size:12px;margin-left:10px}
.slashc button .d{display:none;color:var(--muted);font-size:13px;margin-top:2px;white-space:normal}
.slashc button.on{background:var(--accent-soft)}
.slashc button.on .n{color:var(--accent)}
.slashc button.on .d{display:block}
.slashc .msg{padding:9px 10px;color:var(--muted);font-size:13.5px}
@media (pointer:coarse){.slashc button{font-size:16px;padding:10px 12px}.slashc button .d{font-size:14px}}
.slashp{color:var(--ink);font-size:14.5px;line-height:1.4;text-align:left}
.slashp .top{display:flex;align-items:baseline;flex-wrap:wrap;gap:4px 10px;padding:2px 4px 10px}
.slashp .top b{font-size:16px;font-weight:700}
.slashp .top span{color:var(--muted);font-size:13px}
.slashp .models{display:flex;flex-wrap:wrap;gap:6px;padding:0 4px 12px}
.slashp .models button{border:1px solid var(--line);background:var(--bg);color:var(--ink);border-radius:999px;padding:3px 12px;font:inherit;font-size:13.5px;cursor:pointer;min-height:0}
.slashp .models button.cur{border-color:var(--accent);background:var(--accent-soft);color:var(--accent);cursor:default;opacity:1}
.slashp .models button:disabled:not(.cur){opacity:.45;cursor:default}
.slashp details{border-top:1px solid var(--line)}
.slashp summary{list-style:none;display:flex;align-items:center;gap:8px;padding:9px 4px;cursor:pointer;font-weight:600}
.slashp summary::-webkit-details-marker{display:none}
.slashp summary .c{color:var(--faint);font-weight:500;font-variant-numeric:tabular-nums}
.slashp summary .s{color:var(--muted);font-weight:400;font-size:13px;overflow:hidden;white-space:nowrap;text-overflow:ellipsis;min-width:0}
.slashp summary::after{content:"▸";margin-left:auto;color:var(--faint);flex:none}
.slashp details[open] summary::after{content:"▾"}
.slashp .rows{padding:0 0 8px}
.slashp .rows button{display:block;width:100%;text-align:left;border:0;background:none;color:var(--ink);font:inherit;padding:5px 8px;border-radius:8px;cursor:pointer;min-height:0}
.slashp .rows button:hover{background:var(--surface-2)}
.slashp .rows small{display:block;color:var(--muted);font-size:12.5px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.slashp .line{border-top:1px solid var(--line);padding:9px 4px;color:var(--muted);font-size:13.5px}
.slashp .line b{color:var(--ink);font-weight:600}
.slashp .foot{padding:8px 4px 2px;color:var(--faint);font-size:12.5px}
@media (pointer:coarse){.slashp .rows button{padding:9px 8px}.slashp .models button{padding:6px 14px;font-size:15px}}`;
  if (typeof document !== "undefined" && document.head) document.head.insertAdjacentHTML("beforeend", `<style>${css}</style>`);

  // ── the logic: plain functions, run as they are by src/slash-complete.test.ts ──────────────

  /** The `/word` the caret sits in, or null: the input's first character, nothing but the word before the caret. */
  function slashQuery(value, caret) {
    const v = String(value ?? "");
    const at = caret == null ? v.length : caret;
    const m = /^\/(\S*)$/.exec(v.slice(0, at));
    if (!m) return null;
    return { q: m[1].toLowerCase(), end: at + /^\S*/.exec(v.slice(at))[0].length };
  }

  /** How well `q` names an item: exact, prefix, a word of it (`brain` → `superpowers:brainstorm`), inside it, or not. */
  function score(name, q) {
    if (!q) return 1;
    const n = String(name).toLowerCase();
    if (n === q) return 5;
    if (n.startsWith(q)) return 4;
    if (n.split(/[:_.-]/).some((p) => p.startsWith(q))) return 3;
    return n.includes(q) ? 2 : 0;
  }

  /** The matches in menu order: groups by their best match (ties: Built-in · Skills · Commands · Plugins), best rows first. */
  function rank(items, q) {
    const by = new Map(GROUPS.map(([g]) => [g, []]));
    for (const it of items || []) {
      if (!it || !by.has(it.group)) continue;
      const s = score(it.name, q || "");
      if (s) by.get(it.group).push([s, it]);
    }
    return GROUPS.map(([g], gi) => {
      const rows = by.get(g).sort((a, b) => b[0] - a[0] || String(a[1].name).localeCompare(String(b[1].name)));
      return { gi, best: rows.length ? rows[0][0] : 0, rows };
    })
      .filter((x) => x.rows.length)
      .sort((a, b) => b.best - a.best || a.gi - b.gi)
      .flatMap((x) => x.rows.map(([, it]) => it));
  }

  /** What a key does while the list is open: "down" · "up" · "pick" · "close", or null — not the list's. */
  function keyAction(e) {
    if (e.isComposing || e.keyCode === 229) return null; // an IME is still composing
    const bare = !e.shiftKey && !e.metaKey && !e.ctrlKey && !e.altKey;
    if (e.key === "ArrowDown" && bare) return "down";
    if (e.key === "ArrowUp" && bare) return "up";
    if ((e.key === "Enter" || e.key === "Tab") && bare) return "pick";
    if (e.key === "Escape") return "close";
    return null;
  }

  /** The composer after picking `insert` for the `/word` ending at `end`: the word replaced, what followed kept. */
  function applyPick(value, end, insert) {
    const rest = String(value ?? "").slice(end).replace(/^\s+/, "");
    return { value: insert + rest, caret: insert.length };
  }

  // A command already at the front of the composer — `/name` or `$name`, not a path like /Users/x/a.png.
  const LEAD = /^\s*[/$][\w.:@+-]*(?=\s|$)\s*/;

  /** From the panel: `insert` goes first, replacing a command already there; a draft stays as its words. */
  function placeAtStart(value, insert) {
    const v = String(value ?? "");
    const m = LEAD.exec(v);
    const rest = m ? v.slice(m[0].length) : v.replace(/^\s+/, "");
    const out = insert + rest;
    return { value: out, caret: out.length };
  }

  /** A model switch is a line of its own: only into an empty composer or over another command. Null = there is a draft. */
  function placeModel(value, line) {
    const v = String(value ?? "").trim();
    if (v && !LEAD.test(v)) return null;
    return { value: line, caret: line.length };
  }

  /** `/model {model}` → `/model sonnet`; a switch with no argument (it opens the CLI's own picker) is used as is. */
  const modelLine = (tpl, m) => (String(tpl).includes("{model}") ? String(tpl).replace("{model}", m) : String(tpl));

  const label = (it) => String(it.insert || "/" + it.name).trim();

  function rowsHtml(list, sel) {
    let out = "", g = null;
    list.forEach((it, i) => {
      if (it.group !== g) { g = it.group; out += `<div class="h">${esc(LABEL[g] || g)}</div>`; }
      // Where to look for the answer, or where it came from — only when that is not the obvious place.
      const where = it.opens === "terminal" ? "in terminal" : it.group !== "plugin" && it.from === "project" ? "project" : "";
      out += `<button type="button" role="option" data-i="${i}"${i === sel ? ' class="on" aria-selected="true"' : ""}>`
        + (where ? `<span class="w">${esc(where)}</span>` : "")
        + `<span class="n">${esc(label(it))}</span>${it.hint ? `<span class="a">${esc(it.hint)}</span>` : ""}`
        + (it.desc ? `<span class="d">${esc(it.desc)}</span>` : "")
        + `</button>`;
    });
    return out;
  }

  /**
   * The panel behind the composer's chip: this terminal's model (and how its CLI switches it), its account,
   * then skills, commands, plugins and MCP servers. A row carries `data-ins` (what it puts in the composer),
   * a model chip `data-model` (the whole line); the page does the putting. `o.draft` = the composer holds
   * words of its own, so a model switch, which needs its own line, waits for them.
   */
  function panelHtml(d, o = {}) {
    if (!d) return `<div class="slashp"><div class="line">${esc(o.error || "Loading…")}</div></div>`;
    const items = d.items || [];
    const of = (g) => items.filter((it) => it.group === g);
    const row = (it) => `<button type="button" data-ins="${esc(it.insert)}"><span>${esc(label(it))}</span>${it.desc ? `<small>${esc(it.desc)}</small>` : ""}</button>`;
    const section = (title, list, sub) => list.length
      ? `<details${list.length <= 5 ? " open" : ""}><summary>${esc(title)} <span class="c">${list.length}</span>${sub ? `<span class="s">${esc(sub)}</span>` : ""}</summary><div class="rows">${list.map(row).join("")}</div></details>`
      : "";
    const cli = d.cli ? d.cli.label : d.backend;
    let out = `<div class="slashp"><div class="top"><b>${esc(d.model || "default model")}</b><span>${esc(cli || "")}</span>${d.profile ? `<span>account ${esc(d.profile)}</span>` : ""}</div>`;
    const models = (d.models || []).filter(Boolean);
    if (d.switch_model && models.length) {
      const cur = String(d.model || "").toLowerCase();
      out += `<div class="models">` + (String(d.switch_model).includes("{model}")
        ? models.map((m) => {
          const on = m.toLowerCase() === cur;
          const line = modelLine(d.switch_model, m);
          return `<button type="button" data-model="${esc(line)}"${on ? ' class="cur" disabled' : o.draft ? ' disabled title="Send or clear what is in the composer first — a model switch goes on its own line"' : ` title="Puts ${esc(line)} in the composer — send it to switch"`}>${esc(m)}</button>`;
        }).join("")
        : `<button type="button" data-model="${esc(d.switch_model)}"${o.draft ? " disabled" : ` title="Puts ${esc(d.switch_model)} in the composer — its picker opens in the terminal"`}>Pick a model in the terminal</button>`) + `</div>`;
    }
    out += section("Skills", of("skill"));
    out += section("Commands", of("command"));
    const plugins = d.plugins || [];
    out += of("plugin").length
      ? section("Plugins", of("plugin"), plugins.join(" · "))
      : plugins.length ? `<div class="line"><b>Plugins</b> ${esc(plugins.join(" · "))}</div>` : "";
    if ((d.mcp || []).length) out += `<div class="line"><b>MCP</b> ${esc(d.mcp.join(" · "))}</div>`;
    for (const n of d.notes || []) out += `<div class="line">${esc(n)}</div>`;
    if (!items.length && !plugins.length && !(d.mcp || []).length) out += `<div class="line">Nothing to list for this terminal's CLI.</div>`;
    else out += `<div class="foot">Type / in the composer to search all of these.</div>`;
    return out + `</div>`;
  }

  // ── one answer per terminal, shared by the list and the panel ─────────────────────────────
  // An answer older than a minute is fetched again in the background while the old one keeps showing;
  // a failure is retried after a few seconds rather than remembered.
  const cache = new Map(); // session id → { at, data?, err?, wait? }
  const stale = (c) => !c || (!c.wait && Date.now() - c.at >= (c.err ? ERR_TTL_MS : TTL_MS));
  function load(id, fetcher, fresh = false) {
    const c = cache.get(id);
    if (c?.wait) return c.wait;
    if (!fresh && !stale(c)) return c.err ? Promise.reject(new Error(c.err)) : Promise.resolve(c.data);
    const prev = c?.data;
    const wait = Promise.resolve()
      .then(() => fetcher(id))
      .then(
        (data) => { cache.set(id, { at: Date.now(), data }); return data; },
        (e) => { cache.set(id, { at: Date.now(), err: String(e?.message || e), data: prev }); throw e; },
      );
    cache.set(id, { at: c?.at ?? 0, data: prev, wait });
    return wait;
  }
  /** What is known for a terminal right now, without asking: its answer (possibly stale), or null. */
  const cached = (id) => cache.get(id)?.data ?? null;

  /**
   * Attach the list to a composer. `opts.session()` is the terminal on screen (null = none), `opts.fetch(id)`
   * resolves its commands, `opts.enabled()` (optional) says whether the list may open at all right now.
   */
  function attach(input, opts) {
    const host = input.parentElement;
    if (getComputedStyle(host).position === "static") host.style.position = "relative";
    const menu = document.createElement("div");
    menu.className = "slashc"; menu.hidden = true; menu.setAttribute("role", "listbox");
    host.appendChild(menu);
    const st = { items: [], sel: 0, end: 0, key: "", dismissed: null, loadingT: 0 };

    const close = () => { menu.hidden = true; st.items = []; clearTimeout(st.loadingT); };
    const say = (msg) => { st.items = []; menu.innerHTML = `<div class="msg">${esc(msg)}</div>`; menu.hidden = false; };
    const paint = () => {
      menu.innerHTML = rowsHtml(st.items, st.sel);
      menu.hidden = !st.items.length;
      menu.querySelector(".on")?.scrollIntoView?.({ block: "nearest" });
    };
    const again = () => { if (document.activeElement === input) refresh(); };
    const refresh = () => {
      const id = opts.session();
      const hit = id && (!opts.enabled || opts.enabled()) ? slashQuery(input.value, input.selectionStart) : null;
      if (!hit || st.dismissed === input.value) return close();
      st.end = hit.end;
      const c = cache.get(id);
      if (stale(c)) load(id, opts.fetch).then(again, again);
      const data = cache.get(id)?.data;
      if (!data) {
        const now = cache.get(id);
        if (now?.err && !now.wait) return say("Couldn't load this terminal's commands — " + now.err);
        st.items = [];
        // A local daemon answers in milliseconds: say "loading" only when it does not.
        clearTimeout(st.loadingT);
        st.loadingT = setTimeout(() => { if (cache.get(id)?.wait && !cache.get(id)?.data && slashQuery(input.value, input.selectionStart)) say("Loading this terminal's commands…"); }, 160);
        return;
      }
      clearTimeout(st.loadingT);
      const key = id + "\0" + hit.q;
      st.items = rank(data.items, hit.q).slice(0, ROWS_MAX);
      if (key !== st.key) { st.sel = 0; st.key = key; }
      st.sel = Math.min(st.sel, Math.max(0, st.items.length - 1));
      paint();
    };
    const pick = (it) => {
      const r = applyPick(input.value, st.end, it.insert);
      input.value = r.value;
      input.setSelectionRange(r.caret, r.caret);
      close(); input.focus();
      input.dispatchEvent(new Event("input"));
    };

    // Typing opens it; the page putting words in the box (a draft brought back on a walk to another
    // terminal, a refused line returned) is not typing and only closes it.
    input.addEventListener("input", (e) => { st.dismissed = null; if (e.isTrusted) refresh(); else close(); });
    input.addEventListener("click", refresh);
    input.addEventListener("blur", () => setTimeout(close, 150));
    // Capture, so an open list owns ⏎ ⇥ ↑ ↓ ⎋ before the composer's own handlers (send, or a key passed
    // through to the terminal) see them. Closed — or showing only a message — it owns nothing but ⎋.
    input.addEventListener("keydown", (e) => {
      if (menu.hidden) return;
      const a = keyAction(e);
      if (!a || (!st.items.length && a !== "close")) return;
      e.preventDefault(); e.stopImmediatePropagation();
      if (a === "down") { st.sel = (st.sel + 1) % st.items.length; paint(); }
      else if (a === "up") { st.sel = (st.sel - 1 + st.items.length) % st.items.length; paint(); }
      else if (a === "pick") pick(st.items[st.sel]);
      else { st.dismissed = input.value; close(); }
    }, true);
    // pointerdown, not click: the textarea's blur would close the list before a click lands.
    menu.addEventListener("pointerdown", (e) => {
      const b = e.target.closest("[data-i]");
      e.preventDefault();
      if (b) pick(st.items[+b.dataset.i]);
    });
    return { refresh, close, isOpen: () => !menu.hidden };
  }

  const logic = { slashQuery, score, rank, keyAction, applyPick, placeAtStart, placeModel, modelLine, rowsHtml, panelHtml };
  (typeof window !== "undefined" ? window : globalThis).SlashComplete = { attach, load, cached, panelHtml, placeAtStart, placeModel, modelLine, logic };
})();
