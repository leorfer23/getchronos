/* The artifact viewer — an agent's HTML page, open on the Desk, answered in place.
 *
 * Shared by desk.html and phone.html (no build step, so a plain script on window, like ask-card.js).
 *   - in the chat: a `::artifact <id>::` line in a row (src/artifacts.ts writes it) becomes the page's
 *     card — who made it, the title, the question if it asks one, Open;
 *   - Open (or /desk#artifact=<id>) shows the page full-size in a sandboxed iframe.
 *
 * The frame is `sandbox="allow-scripts allow-forms allow-popups"` WITHOUT allow-same-origin: an opaque
 * origin that cannot read this page's token, storage or DOM. Its document is the daemon's frameHtml()
 * (CSP first, then the SDK, then the page) put in `srcdoc`. The page's only way out is postMessage;
 * this file answers a message only when it comes from the open frame's own window, and makes the API
 * call itself — the page never holds a credential.
 *
 * ctx = { api, toast }.
 */
(function (root) {
  var MARK = /^::artifact ([0-9a-f-]{8,36})::$/;
  var TOPICS = ["artifact.created", "artifact.updated", "artifact.event"];
  var C = null;
  var rows = new Map(); // id → last row read
  var V = { dlg: null, frame: null, id: null, version: 0, head: null };

  var CSS =
    ".afc-host{display:block}" +
    ".bub .afc-host + p,.bub p + .afc-host{margin-top:8px}" +
    ".afc{border:1px solid var(--line);border-left:3px solid var(--accent);border-radius:10px;background:var(--surface);padding:10px 12px;white-space:normal;font-size:15px;line-height:1.45}" +
    ".afc.ask{border-left-color:var(--warn)}" +
    ".afc.done{border-left-color:var(--line)}" +
    ".af-h{display:flex;align-items:baseline;gap:7px;font-size:13px;color:var(--muted)}" +
    ".af-who{flex:1;min-width:0;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}" +
    ".af-age{flex:none;color:var(--faint);font-variant-numeric:tabular-nums}" +
    ".af-t{margin-top:4px;font-size:16px;font-weight:600;color:var(--ink);overflow-wrap:anywhere}" +
    ".af-q{margin-top:3px;font-size:14.5px;color:var(--muted);overflow-wrap:anywhere}" +
    ".af-row{display:flex;align-items:center;gap:8px;margin-top:9px}" +
    ".af-open{padding:4px 14px;border-radius:999px;border:1px solid var(--accent);background:var(--accent);color:var(--accent-ink);font:inherit;font-size:14px;font-weight:600;cursor:pointer}" +
    ".afc.done .af-open{background:var(--bg);color:var(--ink);border-color:var(--line)}" +
    ".af-st{font-size:13px;color:var(--faint);min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}" +
    ".afc.done .af-st b{color:var(--ok)}" +
    "dialog.afdlg{width:min(1180px,96vw);height:min(92vh,1400px);max-width:none;max-height:none;padding:0;display:none;flex-direction:column;overflow:hidden}" +
    "dialog.afdlg[open]{display:flex}" +
    ".afdlg-h{flex:none;display:flex;align-items:center;gap:10px;padding:9px 12px;border-bottom:1px solid var(--line)}" +
    ".afdlg-t{flex:1;min-width:0;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}" +
    ".afdlg-m{flex:none;font-size:13px;color:var(--faint);font-variant-numeric:tabular-nums}" +
    ".afdlg-new{flex:none;padding:2px 10px;border-radius:999px;border:1px solid var(--accent);background:var(--accent-soft);color:var(--accent);font:inherit;font-size:13px;cursor:pointer}" +
    ".afdlg-new[hidden]{display:none}" +
    ".afdlg-x{flex:none;border:none;background:transparent;color:var(--muted);font-size:20px;line-height:1;padding:2px 6px;border-radius:6px;cursor:pointer}" +
    ".afdlg-x:hover{background:var(--surface-2);color:var(--ink)}" +
    ".afdlg iframe{flex:1;width:100%;border:0;background:var(--bg)}" +
    "@media (max-width:700px){dialog.afdlg{width:100vw;height:100dvh;border-radius:0;border:0}}";

  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }
  function ago(iso) {
    var s = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 1000));
    if (!isFinite(s)) return "";
    if (s < 60) return "now";
    if (s < 3600) return Math.floor(s / 60) + "m";
    if (s < 86400) return Math.floor(s / 3600) + "h";
    return Math.floor(s / 86400) + "d";
  }
  function short(v) {
    if (v == null) return "";
    var t = typeof v === "string" ? v : JSON.stringify(v);
    return t.length > 80 ? t.slice(0, 79) + "…" : t;
  }

  // ── the card ───────────────────────────────────────────────────────────────────────────────────
  function cardHtml(r) {
    if (!r) return '<div class="afc"><div class="af-h"><span class="af-who">…</span></div></div>';
    var asks = !!r.ask_id;
    var done = r.status !== "open";
    var st = done
      ? (asks || r.answer != null ? "<b>✓</b> " + esc(short(r.answer) || "answered") : "")
      : asks ? "waiting on you" : "";
    if (r.version > 1) st = (st ? st + " · " : "") + "v" + r.version;
    return (
      '<div class="afc' + (asks ? " ask" : "") + (done ? " done" : "") + '">' +
      '<div class="af-h"><span class="af-who">' + esc(r.created_by || "An agent") + '</span><span class="af-age">' + esc(ago(r.created_at)) + "</span></div>" +
      '<div class="af-t">' + esc(r.title) + "</div>" +
      (r.question ? '<div class="af-q">' + esc(r.question) + "</div>" : "") +
      '<div class="af-row"><button type="button" class="af-open" data-afopen="' + esc(r.id) + '">' + (asks && !done ? "Open & answer" : "Open") + '</button><span class="af-st">' + st + "</span></div>" +
      "</div>"
    );
  }
  function paint(id) {
    var r = rows.get(id);
    document.querySelectorAll('.afc-host[data-afid="' + id + '"]').forEach(function (h) { h.innerHTML = cardHtml(r); });
  }
  async function refresh(id) {
    try {
      var r = await C.api("/artifacts/" + id);
      rows.set(r.id, r);
      // A card written with an id8 (Robert typing it) is keyed by the full id from here on.
      document.querySelectorAll('.afc-host[data-afid="' + id + '"]').forEach(function (h) { h.dataset.afid = r.id; });
      paint(r.id);
    } catch (e) {
      if (e && e.status === 404) document.querySelectorAll('.afc-host[data-afid="' + id + '"]').forEach(function (h) { h.remove(); });
    }
  }
  function embed(bub) {
    if (!C || !bub) return;
    var hit = false, other = false;
    Array.prototype.slice.call(bub.querySelectorAll("p")).forEach(function (p) {
      var m = MARK.exec((p.textContent || "").trim());
      if (!m) { if ((p.textContent || "").trim()) other = true; return; }
      hit = true;
      var h = document.createElement("div");
      h.className = "afc-host";
      h.dataset.afid = m[1];
      h.innerHTML = cardHtml(rows.get(m[1]));
      p.replaceWith(h);
      refresh(m[1]);
    });
    if (hit && !other) bub.classList.add("ak-only");
  }

  // ── the viewer ─────────────────────────────────────────────────────────────────────────────────
  function dialog() {
    if (V.dlg) return V.dlg;
    var d = document.createElement("dialog");
    d.className = "afdlg";
    d.innerHTML =
      '<div class="afdlg-h"><span class="afdlg-t"></span><button type="button" class="afdlg-new" hidden>new version ↻</button>' +
      '<span class="afdlg-m"></span><button type="button" class="afdlg-x" aria-label="Close">✕</button></div>';
    d.querySelector(".afdlg-x").addEventListener("click", function () { d.close(); });
    d.querySelector(".afdlg-new").addEventListener("click", function () { if (V.id) open(V.id); });
    d.addEventListener("close", function () {
      if (V.frame) V.frame.remove();
      V.frame = null; V.id = null;
      if (location.hash.indexOf("#artifact=") === 0) history.replaceState(null, "", location.pathname + location.search);
    });
    // Keys typed into the page must not reach the Desk's own shortcuts.
    d.addEventListener("keydown", function (e) { if (e.key !== "Escape") e.stopPropagation(); });
    document.body.appendChild(d);
    V.dlg = d;
    return d;
  }
  function head(r) {
    var d = dialog();
    d.querySelector(".afdlg-t").textContent = r.title || "Artifact";
    var bits = [];
    if (r.latest > 1) bits.push("v" + r.version + "/" + r.latest);
    if (r.status !== "open") bits.push("answered");
    d.querySelector(".afdlg-m").textContent = bits.join(" · ");
  }
  async function open(id) {
    if (!C) return;
    var d = dialog();
    var r;
    try { r = await C.api("/artifacts/" + id + "/frame"); } catch (e) { C.toast(e && e.status === 404 ? "that page is gone" : "could not open the page"); return; }
    if (V.frame) V.frame.remove();
    var f = document.createElement("iframe");
    f.setAttribute("sandbox", "allow-scripts allow-forms allow-popups");
    f.setAttribute("referrerpolicy", "no-referrer");
    f.setAttribute("title", r.title || "Artifact");
    f.srcdoc = r.html;
    d.appendChild(f);
    V.frame = f; V.id = r.id; V.version = r.version;
    d.querySelector(".afdlg-new").hidden = true;
    head(r);
    if (!d.open) d.showModal();
    f.focus();
  }

  function reply(m, ok, payload) {
    if (!V.frame || !V.frame.contentWindow) return;
    var msg = { __chronos: 1, re: m.id, ok: ok };
    if (ok) msg.result = payload; else msg.error = payload;
    V.frame.contentWindow.postMessage(msg, "*");
  }
  function errText(e) {
    try { return JSON.parse(e.message).error || e.message; } catch (x) { return (e && e.message) || "failed"; }
  }
  async function onMessage(e) {
    // Only the frame we opened, and only while it is open. Everything else on the page is ignored.
    if (!V.frame || e.source !== V.frame.contentWindow) return;
    var m = e.data;
    if (!m || m.__chronos !== 1 || typeof m.id !== "number") return;
    var id = V.id;
    try {
      if (m.type === "submit" || m.type === "send") {
        var out = await C.api("/artifacts/" + id + "/events", { method: "POST", body: JSON.stringify({ kind: m.type, data: m.data, by: "operator" }) });
        reply(m, true, { event: out.event ? out.event.id : null });
        if (m.type === "submit") {
          var r = rows.get(id);
          C.toast("✓ sent to " + ((r && r.created_by) || "the agent"));
          refresh(id);
          var meta = V.dlg && V.dlg.querySelector(".afdlg-m");
          if (meta && meta.textContent.indexOf("answered") < 0) meta.textContent = (meta.textContent ? meta.textContent + " · " : "") + "answered";
        }
      } else if (m.type === "state") {
        await C.api("/artifacts/" + id + "/state", { method: "PUT", body: JSON.stringify({ state: m.data }) });
        reply(m, true, null);
      } else if (m.type === "close") {
        reply(m, true, null);
        if (V.dlg) V.dlg.close();
      } else {
        reply(m, false, "unknown call " + String(m.type));
      }
    } catch (err) {
      reply(m, false, errText(err));
      C.toast(errText(err));
    }
  }

  function onEvent(e) {
    if (!C || !e || !e.artifact_id) return;
    if (TOPICS.indexOf(e.topic) < 0) return;
    if (document.querySelector('.afc-host[data-afid="' + e.artifact_id + '"]')) refresh(e.artifact_id);
    // A new version while the page is open: offer it — never swap the page out from under a click.
    if (e.topic === "artifact.updated" && V.id === e.artifact_id && e.version > V.version && V.dlg) V.dlg.querySelector(".afdlg-new").hidden = false;
  }

  function fromHash() {
    var m = /^#artifact=([0-9a-f-]{8,36})$/.exec(location.hash);
    if (m) open(m[1]);
  }

  function init(ctx) {
    C = ctx;
    var s = document.createElement("style");
    s.textContent = CSS;
    document.head.appendChild(s);
    window.addEventListener("message", onMessage);
    document.addEventListener("click", function (e) {
      var b = e.target && e.target.closest ? e.target.closest("[data-afopen]") : null;
      if (!b) return;
      e.preventDefault();
      open(b.getAttribute("data-afopen"));
    });
    window.addEventListener("hashchange", fromHash);
    fromHash();
  }

  root.ArtifactView = { MARK: MARK, TOPICS: TOPICS, init: init, embed: embed, open: open, onEvent: onEvent };
})(typeof window !== "undefined" ? window : globalThis);
