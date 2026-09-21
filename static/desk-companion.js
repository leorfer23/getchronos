/* The companion rail's data, as pure functions of the Focus feed (src/focus.ts).
 *
 * The rail lives next to the raw terminal and answers "what is this, and what has happened since?"
 * without the operator reading scrollback. Everything that decides WHICH rows exist — which events
 * are rows at all, where a phase chapter falls, which files this turn touched — is here, so
 * src/desk-companion.test.ts can pin it without a browser. desk.html loads this as a plain script
 * (same road as term-links.js) and owns only the tokens and the DOM.
 *
 * Two shapes of the feed are worth remembering before changing anything here:
 *   · `result` is NOT a tool result. FocusKind "result" is the agent's own "Summary:"/"Result:"
 *     block (focus.ts phased()). The feed carries no tool exit codes or outputs at all — claudeLine
 *     drops `toolUseResult` records — so nothing in the timeline can "attach a result to its act",
 *     and the diff ticker cannot show a command's exit status.
 *   · `ts` is optional. Only the claude and codex adapters stamp events; grok and cursor do not. A
 *     row with no stamp of its own inherits the last one seen, and a feed with no stamps at all
 *     sorts every chapter to the end rather than guessing.
 */
(function (root) {
  // describeTool()'s phrasing, read back. These are the only shapes it emits for a path or a command.
  var EDIT_RE = /^(?:Edit|Write|NotebookEdit)\s+(.+)$/;
  var RUN_RE = /^run\s+([\s\S]+)$/;
  // What a CLI injects into the transcript as a "user" record but the operator never typed.
  var SYS_RE = /^\s*<(task-notification|system-reminder|command-)/;
  /** Markers are cheap but not free, and a day-long terminal would keep every one alive. */
  var MAX_MARKS = 500;

  // An agent writing to workspace memory, read back from its command: `mc remember "…"`, `mc learn "…"`,
  // `mc memo append|new|edit <slug>`. Anywhere in the command, so `cd x && mc remember …` counts.
  var MEM_RE = /(?:^|[\s;&|(])mc\s+(remember|learn|memo\s+(?:append|new|edit))\b\s*([\s\S]*)$/;

  var oneLine = function (t) { return String(t == null ? "" : t).replace(/\s+/g, " ").trim(); };

  /**
   * The agent wrote its narration as markdown for a transcript; a clipped row in a 280px column is
   * not a transcript. Same treatment term-status.ts gives a card's one-liner: links keep their text,
   * emphasis and list bullets go, and the "Understanding:"/"Summary:" label goes with them — the
   * row's own glyph already says which kind it is.
   */
  function plainText(t) {
    return oneLine(String(t == null ? "" : t)
      .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
      .replace(/(\*\*|__|`)/g, "")
      .replace(/^\s*(#+|[-*>]|\d+\.)\s+/gm, "")
      .replace(/^\s*(summary|result|understanding)\s*[:\-—]\s*/i, ""));
  }

  /**
   * The memory write a tool call made, or null: { verb, text, slug }. The feed clips a command at 90
   * chars, so the quoted text may have lost its closing quote — take what is there.
   */
  function memoryWrite(actText) {
    var m = RUN_RE.exec(oneLine(actText));
    if (!m) return null;
    var w = MEM_RE.exec(m[1]);
    if (!w) return null;
    var verb = w[1].split(/\s+/).pop();
    var rest = w[2].trim();
    var quoted = function (r) {
      var q = /^(["'])((?:(?!\1)[\s\S])*)\1?/.exec(r);
      return q ? q[2].trim() : r.replace(/\s--\S[\s\S]*$/, "").trim();
    };
    var topic = /--topic\s+(["']?)([^"'\s]+)\1/.exec(rest);
    if (verb === "remember") return { verb: verb, text: quoted(rest), topic: topic ? topic[2] : null, slug: "memory-index" };
    if (verb === "learn") return { verb: verb, text: quoted(rest), topic: null, slug: "session-learnings" };
    var slug = /^(["']?)([^"'\s]+)\1/.exec(rest);
    if (verb === "new") { var t = /--title\s+(["'])([\s\S]*?)\1/.exec(rest); return { verb: verb, text: t ? t[2] : "", topic: null, slug: null }; }
    var after = slug ? quoted(rest.slice(slug[0].length).trim()) : "";
    return { verb: verb, text: verb === "append" ? after : "", topic: null, slug: slug ? slug[2] : null };
  }

  var MEM_WORD = { remember: "Remembered", learn: "Noted", append: "Added to", "new": "New memo", edit: "Edited" };
  function memoryPhrase(w) {
    if (w.verb === "remember") return "Remembered" + (w.topic ? " (" + w.topic + ")" : "") + (w.text ? ": " + w.text : "");
    if (w.verb === "learn") return "Noted" + (w.text ? ": " + w.text : "");
    if (w.verb === "new") return "New memo" + (w.text ? ": " + w.text : "");
    return MEM_WORD[w.verb] + " " + (w.slug || "a memo") + (w.text ? ": " + w.text : "");
  }

  /** Last two segments of a path — enough to know which file, short enough for a 280px column. */
  function shortPath(p) {
    var parts = String(p || "").trim().split("/").filter(Boolean);
    return parts.length <= 2 ? String(p || "").trim() : parts.slice(-2).join("/");
  }

  var VERB = { Edit: "Editing", Write: "Writing", Read: "Reading", NotebookEdit: "Editing", run: "Running", search: "Searching", find: "Finding" };
  var PATHY = { Edit: 1, Write: 1, Read: 1, NotebookEdit: 1 };
  /** "Edit /a/b/src/api.ts" → "Editing src/api.ts". Anything unrecognised is left exactly as it came. */
  function actPhrase(text) {
    var t = oneLine(text);
    var m = /^(\S+)\s+([\s\S]+)$/.exec(t);
    if (!m || !VERB[m[1]]) return t;
    return VERB[m[1]] + " " + (PATHY[m[1]] ? shortPath(m[2]) : m[2]);
  }

  /** The file a tool call wrote to, or null. Reads are not touches — the ticker is about damage. */
  function editedFile(text) {
    var m = EDIT_RE.exec(oneLine(text));
    return m ? m[1].trim() : null;
  }

  function sorted(events) {
    return (events || []).filter(function (e) { return e && typeof e.seq === "number"; })
      .slice().sort(function (a, b) { return a.seq - b.seq; });
  }

  /**
   * One row per thing the agent said or the operator typed, oldest first, with phase changes woven in
 * as chapters. Tool calls (`act`) are not rows: the operator reads the narration, not "Running…"/
 * "Editing…" — the terminal beside the rail already shows every call. The exception is a write to
 * workspace memory (`mc remember` / `mc learn` / `mc memo …`), which is a 🧠 row.
   *
   * @param events   FocusEvent[] — the same array the Focus story renders from.
   * @param chapters [{ at, phase, line }] — phase changes as the page saw them (session.status).
   * @returns rows with a stable `k` key, so the page can append instead of rebuilding.
   */
  function companionRows(events, chapters) {
    var evs = sorted(events);
    var chs = (chapters || []).filter(function (c) { return c && c.phase; })
      .slice().sort(function (a, b) { return (a.at || 0) - (b.at || 0); });
    var rows = [];
    var ci = 0, at = 0;
    var chaptersUpTo = function (t) {
      while (ci < chs.length && (chs[ci].at || 0) <= t) {
        var c = chs[ci++];
        rows.push({ kind: "chapter", at: c.at, phase: c.phase, text: oneLine(c.line) });
      }
    };
    for (var i = 0; i < evs.length; i++) {
      var e = evs[i];
      at = e.ts || at; // no stamp of its own: it happened no earlier than the last thing that did
      chaptersUpTo(at);
      // `think` is the model talking to itself. The Focus story never shows it and neither does this:
      // "everything that happened" means everything the operator could have acted on.
      if (e.kind === "act") {
        // The one tool call that IS a row: the agent saving to workspace memory.
        var mw = memoryWrite(e.text);
        if (mw) rows.push({ kind: "memory", at: at, seq: e.seq, text: memoryPhrase(mw), slug: mw.slug });
        continue;
      }
      if (e.kind === "think") continue;
      if (e.kind === "user") {
        if (SYS_RE.test(String(e.text || ""))) continue;
        var u = oneLine(e.text);
        if (!u) continue;
        rows.push({ kind: "user", at: at, seq: e.seq, text: u });
        continue;
      }
      var kind = e.kind === "result" ? "result" : e.kind === "understanding" ? "understanding" : "say";
      var t2 = plainText(e.text);
      if (t2) rows.push({ kind: kind, at: at, seq: e.seq, text: t2 });
    }
    chaptersUpTo(Infinity);
    for (var j = 0; j < rows.length; j++) {
      var row = rows[j];
      row.k = row.kind === "chapter"
        ? "ch:" + row.at + ":" + row.phase
        : row.kind + ":" + row.seq;
    }
    return rows;
  }

  /**
   * Files this turn wrote to — since the last thing the operator said — newest first, deduped.
   * The turn boundary is the last `user` event; before there is one, the whole session is the turn.
   */
  function touchedFiles(events) {
    var evs = sorted(events);
    var from = 0;
    for (var i = evs.length - 1; i >= 0; i--) if (evs[i].kind === "user") { from = i + 1; break; }
    var out = [];
    for (var j = evs.length - 1; j >= from; j--) {
      if (evs[j].kind !== "act") continue;
      var f = editedFile(evs[j].text);
      if (f && out.indexOf(f) < 0) out.push(f);
    }
    return out;
  }

  /** The last command it ran, whole. Its exit code is not in the feed — see the header note. */
  function lastCommand(events) {
    var evs = sorted(events);
    for (var i = evs.length - 1; i >= 0; i--) {
      if (evs[i].kind !== "act") continue;
      var m = RUN_RE.exec(oneLine(evs[i].text));
      if (m) return m[1].trim();
    }
    return null;
  }

  /**
   * What it is doing right now, or null. An act is "current" while it is the newest event: the feed
   * has no tool results, so a finished call is only ever known by something else arriving after it.
   */
  function currentAct(events) {
    var evs = sorted(events);
    var last = evs[evs.length - 1];
    if (!last || last.kind !== "act") return null;
    return { text: oneLine(last.text), at: last.ts || 0, seq: last.seq };
  }

  /** Drop the oldest marks past `max`, in place; returns the dropped ones so the caller disposes them. */
  function trimMarks(list, max) {
    var n = (list ? list.length : 0) - (max || MAX_MARKS);
    return n > 0 ? list.splice(0, n) : [];
  }

  /**
   * The GitHub PR links among a pile of URLs, deduped, newest last, capped. Fed by the terminal's own
   * screen (TermLinks.scan): `gh pr create` prints the URL and the Focus feed never sees it, because
   * the feed carries no tool results.
   */
  var PIN_PR_RE = /^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/\d+$/;
  var MAX_SCREEN_PRS = 8;
  function prUrls(urls) {
    var out = [];
    for (var i = 0; i < (urls || []).length; i++) {
      var u = String(urls[i] || "").replace(/[).,;:]+$/, "");
      if (!PIN_PR_RE.test(u) || out.indexOf(u) >= 0) continue;
      out.push(u);
    }
    return out.slice(-MAX_SCREEN_PRS);
  }

  /** Local wall-clock, 24h, always two digits — the rail is a column of tabular numbers. */
  function hhmm(at) {
    if (!at) return "--:--";
    var d = new Date(at);
    var p = function (n) { return (n < 10 ? "0" : "") + n; };
    return p(d.getHours()) + ":" + p(d.getMinutes());
  }

  /** "12s" · "4m" · "1h 12m". Seconds only under a minute: past that they are noise. */
  function elapsed(ms) {
    var s = Math.max(0, Math.round((ms || 0) / 1000));
    if (s < 60) return s + "s";
    var m = Math.floor(s / 60);
    if (m < 60) return m + "m";
    return Math.floor(m / 60) + "h " + (m % 60) + "m";
  }

  root.TermCompanion = {
    MAX_MARKS: MAX_MARKS,
    companionRows: companionRows,
    touchedFiles: touchedFiles,
    lastCommand: lastCommand,
    currentAct: currentAct,
    editedFile: editedFile,
    memoryWrite: memoryWrite,
    actPhrase: actPhrase,
    shortPath: shortPath,
    plainText: plainText,
    trimMarks: trimMarks,
    prUrls: prUrls,
    hhmm: hhmm,
    elapsed: elapsed,
  };
})(typeof window !== "undefined" ? window : globalThis);
