// `#` in a chat composer: the projects as you type — ↑/↓ to move, ⇥ or ⏎ (or a tap) drops `#slug `.
// Naming a project is optional (Robert reads it from what you write); this is for when you want to
// be exact. Shared by the Desk and the phone; each page passes its own workspace list.
(() => {
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const css = `.tagc{position:absolute;left:0;right:0;bottom:calc(100% + 4px);z-index:60;background:var(--surface,#1b1b1f);border:1px solid var(--line,#333);border-radius:10px;padding:4px;box-shadow:0 8px 24px rgba(0,0,0,.28);max-height:240px;overflow-y:auto}
.tagc[hidden]{display:none}
.tagc button{display:flex;width:100%;gap:8px;align-items:baseline;text-align:left;border:0;background:none;color:var(--ink,#eee);font:inherit;font-size:14.5px;padding:7px 10px;border-radius:7px;cursor:pointer}
.tagc button small{color:var(--muted,#888);font-size:12.5px}
.tagc button.on{background:var(--accent,#5b8cff);color:#fff}
.tagc button.on small{color:rgba(255,255,255,.8)}`;
  document.head.insertAdjacentHTML("beforeend", `<style>${css}</style>`);

  window.TagComplete = function attach(input, workspaces) {
    const host = input.parentElement;
    if (getComputedStyle(host).position === "static") host.style.position = "relative";
    const menu = document.createElement("div");
    menu.className = "tagc"; menu.hidden = true;
    host.appendChild(menu);
    let items = [], sel = 0, at = -1;

    const query = () => {
      const upto = input.value.slice(0, input.selectionStart);
      const m = /(^|\s)#([\w-]*)$/.exec(upto);
      return m ? { q: m[2].toLowerCase(), at: upto.length - m[2].length - 1 } : null;
    };
    const close = () => { menu.hidden = true; items = []; };
    const paint = () => {
      menu.innerHTML = items.map((it, i) => `<button type="button" class="${i === sel ? "on" : ""}" data-i="${i}">#${esc(it.slug)}<small>${esc(it.name)}</small></button>`).join("");
      menu.hidden = !items.length;
    };
    const refresh = () => {
      const hit = query();
      if (!hit) return close();
      at = hit.at;
      const all = [...workspaces().filter((w) => !w.archived).map((w) => ({ slug: w.slug, name: w.name })), { slug: "all", name: "every project" }];
      const q = hit.q;
      items = all
        .filter((w) => !q || w.slug.toLowerCase().includes(q) || w.name.toLowerCase().includes(q))
        .sort((a, b) => (b.slug.toLowerCase().startsWith(q) ? 1 : 0) - (a.slug.toLowerCase().startsWith(q) ? 1 : 0))
        .slice(0, 7);
      sel = 0; paint();
    };
    const pick = (it) => {
      const end = input.selectionStart;
      input.value = input.value.slice(0, at) + "#" + it.slug + " " + input.value.slice(end);
      const caret = at + it.slug.length + 2;
      input.setSelectionRange(caret, caret);
      close(); input.focus();
      input.dispatchEvent(new Event("input"));
    };

    input.addEventListener("input", refresh);
    input.addEventListener("click", refresh);
    input.addEventListener("blur", () => setTimeout(close, 150));
    // Capture, so an open menu owns ⏎ before the composer's own send handler sees it.
    input.addEventListener("keydown", (e) => {
      if (menu.hidden || !items.length) return;
      const own = () => { e.preventDefault(); e.stopImmediatePropagation(); };
      if (e.key === "ArrowDown") { own(); sel = (sel + 1) % items.length; paint(); }
      else if (e.key === "ArrowUp") { own(); sel = (sel - 1 + items.length) % items.length; paint(); }
      else if ((e.key === "Enter" && !e.shiftKey && !e.metaKey && !e.ctrlKey) || e.key === "Tab") { own(); pick(items[sel]); }
      else if (e.key === "Escape") { own(); close(); }
    }, true);
    // pointerdown, not click: the textarea's blur would close the menu before a click lands.
    menu.addEventListener("pointerdown", (e) => {
      const b = e.target.closest("[data-i]"); if (!b) return;
      e.preventDefault(); pick(items[+b.dataset.i]);
    });
  };
})();
