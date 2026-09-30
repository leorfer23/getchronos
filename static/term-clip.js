/* Copy out of a terminal that runs on another computer. Claude Code copies a selection (and /copy) two
 * ways at once: `pbcopy` on the Mac it runs on, plus an OSC 52 escape for the terminal to put on ITS
 * clipboard. A terminal on a host (m2, m5) runs claude on that host, so the pbcopy lands on the host's
 * clipboard — and without an OSC 52 handler the Desk dropped the escape, so ⌘V here pasted whatever was
 * copied before. This handles OSC 52: write-only (a "?" query is refused, a pane never reads the
 * clipboard), onto the browser clipboard, or through the daemon (`pbcopy` on the brain) when the page is
 * the brain's own Desk and WebKit refuses a clipboard write that no click started.
 * Loaded as a plain script by desk.html; src/term-clip.test.ts runs it in a vm. */
(function (root) {
  const MAX = 100_000;

  function decode(data) {
    const i = String(data).indexOf(";");
    if (i < 0) return null;
    const b64 = String(data).slice(i + 1);
    if (!b64 || b64 === "?") return null;
    try {
      const bin = atob(b64);
      const text = new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0)));
      return text && text.length <= MAX ? text : null;
    } catch { return null; }
  }

  const onBrain = (host) => /^(localhost|127\.0\.0\.1|\[::1\])$/i.test(host || "");

  async function put(text, { clipboard, host, viaDaemon }) {
    try { await clipboard.writeText(text); return "browser"; } catch {}
    if (!onBrain(host) || !viaDaemon) return null;
    try { await viaDaemon(text); return "daemon"; } catch { return null; }
  }

  function register(term, opts) {
    return term.parser.registerOscHandler(52, (data) => {
      const text = decode(data);
      if (text) put(text, opts()).then((via) => opts().done?.(via, text));
      return true;
    });
  }

  root.TermClip = { decode, put, register, onBrain };
})(globalThis);
