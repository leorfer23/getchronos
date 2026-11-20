/* Run-asks on the Desk — a command a terminal asked the operator to run (`mc ask-run`, src/run-asks.ts).
 *
 * Its card sits in the dock, beside the hand-off's approve card: the agent's why, the command in an
 * editable monospace box, Run (off while a {{placeholder}} is left in it) and Don't. After Run it reads
 * "running…", then the exit code and a short tail of the output, until he hides it.
 *
 * Plain functions on window (no build step, like ask-card.js): desk.html owns the state, the requests
 * (POST /run-asks/:id/run and …/decline, with x-mc-operator: 1) and the events; this file owns what the
 * card says. src/run-asks.test.ts runs it in a vm.
 */
(function (root) {
  /** How long a finished run's result stays in the dock (unless hidden). */
  var RECENT_MS = 15 * 60 * 1000;
  /** Lines of the output the result card shows (the row keeps more). */
  var TAIL_LINES = 8;

  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }
  /** The {{…}} placeholders still in a command, each once. */
  function placeholders(cmd) {
    var out = [];
    String(cmd == null ? "" : cmd).replace(/\{\{[^{}]*\}\}/g, function (m) { if (out.indexOf(m) < 0) out.push(m); return m; });
    return out;
  }
  /** Run is on only for a command with something in it and no `{{` left — the daemon refuses it too. */
  function canRun(cmd) {
    var c = String(cmd == null ? "" : cmd);
    return !!c.trim() && c.indexOf("{{") < 0;
  }
  function took(ms) {
    var v = Math.max(0, Number(ms) || 0);
    if (v < 1000) return v + "ms";
    if (v < 60000) return (v / 1000).toFixed(1) + "s";
    var m = Math.floor(v / 60000), s = Math.round((v % 60000) / 1000);
    return s ? m + "m " + s + "s" : m + "m";
  }
  function lastLines(text, n) {
    var lines = String(text == null ? "" : text).replace(/\s+$/, "").split("\n");
    return lines.slice(-(n || TAIL_LINES)).join("\n");
  }
  /** What the note under the box says: what is left to fill in, else how it runs. */
  function noteOf(cmd) {
    var left = placeholders(cmd);
    if (left.length) return { left: true, text: "Fill in " + left.join(", ") + " to run it." };
    if (String(cmd == null ? "" : cmd).indexOf("{{") >= 0) return { left: true, text: "Take out the {{ to run it." };
    return { left: false, text: "Behind this terminal's own sandbox, up to 10 minutes; the output goes back to it." };
  }

  /** The open ask's card. `draft` = what is in the box now (null = untouched, so the command as asked). */
  function cardHtml(a, draft) {
    var cmd = draft == null ? a.command : draft;
    var ok = canRun(cmd), note = noteOf(cmd);
    var rows = Math.max(2, Math.min(10, String(cmd).split("\n").length + 1));
    var id = esc(a.id);
    return '<div class="fx-q runask" data-runask="' + id + '">'
      + '<div class="who"><b>Run this for it?</b> · it was refused a command only you can allow</div>'
      + '<div class="q">' + esc(a.why) + '</div>'
      + '<textarea data-rcmd="' + id + '" rows="' + rows + '" spellcheck="false" autocomplete="off" autocapitalize="off" aria-label="the command it will run">' + esc(cmd) + '</textarea>'
      // Where it runs — a relative path means something different in every folder.
      + '<div class="ra-note ra-where">in <code>' + esc(a.cwd || "the terminal's own folder") + '</code></div>'
      + '<div class="ra-note' + (note.left ? " left" : "") + '" data-rnote>' + esc(note.text) + '</div>'
      + '<div class="fx-opts">'
      + '<button type="button" class="go" data-rrun="' + id + '"' + (ok ? "" : ' disabled title="fill in every {{…}} first"') + '>▶ Run</button>'
      + '<button type="button" class="no" data-rno="' + id + '">Don’t</button>'
      + '</div></div>';
  }

  /** A run he started: "running…" while it runs; then its exit code and the end of its output. Null = nothing to show. */
  function resultHtml(a, now) {
    if (!a) return null;
    var id = esc(a.id);
    var cmd = esc((a.command_run || a.command || "").replace(/\s+/g, " ").trim());
    if (a.status === "running") {
      var at = Date.parse(a.decided_at || a.created_at) || 0;
      return '<div class="fx-q runask running" data-runask="' + id + '">'
        + '<div class="who"><b>Running</b> · you started it <time data-clock="ago" data-at="' + at + '" data-suffix=" ago">just now</time></div>'
        + '<div class="q"><i class="spin" data-spin>◐</i>' + cmd + '</div>'
        + '<div class="ra-note">The output goes back to the terminal when it ends.</div></div>';
    }
    if (a.status !== "ran" && a.status !== "failed") return null;
    var fin = Date.parse(a.finished_at || "") || 0;
    if ((now || Date.now()) - fin > RECENT_MS) return null;
    var ok = a.status === "ran";
    var head = ok ? "✓ Ran" : "✕ Failed";
    var words = a.exit_code != null ? "exit " + a.exit_code : a.note ? a.note : "no exit code";
    var tail = a.tail ? lastLines(a.tail, TAIL_LINES) : "";
    return '<div class="fx-q runask ' + (ok ? "done" : "failed") + '" data-runask="' + id + '">'
      + '<div class="who"><b>' + head + '</b> · ' + esc(words) + ' · ' + esc(took(a.duration_ms)) + (a.edited ? " · you edited it" : "") + '</div>'
      + '<div class="q">' + cmd + '</div>'
      + (tail ? '<pre class="ra-tail">' + esc(tail) + '</pre>' : '<div class="ra-note">It printed nothing.</div>')
      + (a.note && a.exit_code != null ? '<div class="ra-note">' + esc(a.note) + '</div>' : "")
      + '<div class="fx-opts"><button type="button" data-fterm>Open the terminal (⌘E)</button><button type="button" data-rhide="' + id + '">Hide</button></div></div>';
  }

  root.RunAsk = { RECENT_MS: RECENT_MS, placeholders: placeholders, canRun: canRun, noteOf: noteOf, cardHtml: cardHtml, resultHtml: resultHtml, lastLines: lastLines, took: took };
})(typeof window !== "undefined" ? window : globalThis);
