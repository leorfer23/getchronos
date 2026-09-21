/* Clickable URLs that a TUI broke across rows. Claude Code (like most Ink/ratatui TUIs) wraps a long URL
 * with hard newlines and indents the rest, so xterm's web-links addon, which only follows soft wraps,
 * links the first row alone. Here a URL that runs to the right edge (Claude Code stops one column short)
 * is stitched onto the next row's first word (indent dropped), and xterm gets one link spanning every row it covers.
 * Loaded as a plain script by desk.html and phone.html; src/term-links.test.ts runs it in a vm. */
(function (root) {
  const URL_RE = /https?:\/\/[^\s"'!*(){}|\\^<>`]*[^\s"':,.!?{}|\\^~\[\]`()<>]/gi;
  const WORD = /^[^\s"'{}|\\^<>`]+/;
  const MAX_ROWS = 24;
  const inUrl = (s) => /https?:\/\/[^\s"'{}|\\^<>`]*$/i.test(s) || /(^|[^a-z])(h|ht|htt|https?|https?:|https?:\/)$/i.test(s);

  function readRow(buf, y, cols) {
    const line = buf.getLine(y);
    if (!line) return null;
    let text = "";
    const xs = [];
    for (let x = 0; x < cols; x++) {
      const cell = line.getCell(x);
      if (!cell) break;
      if (cell.getWidth() === 0) continue;
      const ch = cell.getChars() || " ";
      for (let i = 0; i < ch.length; i++) { text += ch[i]; xs.push(x); }
    }
    const end = text.replace(/\s+$/, "").length;
    return { text: text.slice(0, end), xs: xs.slice(0, end), wrapped: !!line.isWrapped };
  }

  // How row b continues row a: "soft" (xterm wrapped it), "hard" (a TUI broke a word at the edge; the
  // indent is skipped), or null. `tail` is the logical text so far, when known.
  function continues(a, b, cols, tail) {
    if (!a || !b) return null;
    if (b.wrapped) return "soft";
    if (!a.text || a.xs[a.xs.length - 1] < cols - 2) return null;
    const rest = b.text.replace(/^\s+/, "");
    if (!WORD.test(rest)) return null;
    return tail === undefined || inUrl(tail) ? "hard" : null;
  }

  function block(buf, cols, from, rows) {
    const first = rows(from);
    let text = first.text;
    const at = first.xs.map((x) => [x, from]);
    let y = from;
    for (let n = 0; n < MAX_ROWS; n++) {
      const next = rows(y + 1);
      const how = continues(rows(y), next, cols, text);
      if (!how) break;
      y++;
      const skip = how === "hard" ? next.text.length - next.text.replace(/^\s+/, "").length : 0;
      text += next.text.slice(skip);
      for (let i = skip; i < next.xs.length; i++) at.push([next.xs[i], y]);
    }
    return { text, at, end: y };
  }

  function linksAt(buf, cols, y) {
    const cache = new Map();
    const rows = (i) => { if (!cache.has(i)) cache.set(i, i < 0 ? null : readRow(buf, i, cols)); return cache.get(i); };
    if (!rows(y)) return [];
    let top = y;
    while (top > 0 && y - top < MAX_ROWS && continues(rows(top - 1), rows(top), cols)) top--;
    let b = block(buf, cols, top, rows);
    while (b.end < y) b = block(buf, cols, b.end + 1, rows);
    const out = [];
    for (const m of b.text.matchAll(URL_RE)) {
      const s = b.at[m.index], e = b.at[m.index + m[0].length - 1];
      if (s[1] > y || e[1] < y) continue;
      try { new URL(m[0]); } catch { continue; }
      out.push({ text: m[0], range: { start: { x: s[0] + 1, y: s[1] + 1 }, end: { x: e[0] + 1, y: e[1] + 1 } } });
    }
    return out;
  }

  function register(term, activate) {
    return term.registerLinkProvider({
      provideLinks(bufferLineNumber, callback) {
        let links = [];
        try { links = linksAt(term.buffer.active, term.cols, bufferLineNumber - 1); } catch {}
        callback(links.length ? links.map((l) => ({ ...l, activate })) : undefined);
      },
    });
  }

  /**
   * Every URL in a range of rows, whole — the same stitching linksAt() does, walked block by block so a
   * URL a TUI broke across rows is read once, not once per row. The companion rail uses it to find the
   * PR a `gh pr create` printed: that URL is on screen and nowhere else (the Focus feed carries no tool
   * results). Bounded by the caller: reading cells is the expensive part of a Desk frame.
   */
  function scan(buf, cols, from, to) {
    const cache = new Map();
    const rows = (i) => { if (!cache.has(i)) cache.set(i, i < 0 ? null : readRow(buf, i, cols)); return cache.get(i); };
    const out = [];
    for (let y = Math.max(0, from); y <= to; ) {
      if (!rows(y)) { y++; continue; }
      const b = block(buf, cols, y, rows);
      for (const m of b.text.matchAll(URL_RE)) {
        try { new URL(m[0]); } catch { continue; }
        if (out.indexOf(m[0]) < 0) out.push(m[0]);
      }
      y = b.end + 1;
    }
    return out;
  }

  root.TermLinks = { linksAt, scan, register };
})(globalThis);
