// A composer's height follows its text — the Desk's (#say) and the phone's (#f-composer): one line at
// rest, growing with what is written, up to `max`, then it scrolls.
//
// Measured only while the box is on screen. Hidden (display:none: no live terminal yet, the board), its
// scrollHeight is 0, and writing "0px" left the Desk's composer a 20px sliver with the placeholder cut in
// half until the next keystroke — 2026-11-13, when a draft put back on page load ran this before the
// composer showed. Hidden, the inline height is dropped instead, so the CSS one-line height holds.
//
// Both pages are box-sizing:border-box, where a height counts the borders but scrollHeight does not:
// height = scrollHeight alone clipped the text by the two borders. src/fit-box.test.ts runs this as
// shipped; src/composer-size.integration.test.ts measures it in a real browser with the pages' own CSS.
(() => {
  function fitBox(el, max) {
    if (!el) return;
    el.style.height = "auto";
    const sh = el.scrollHeight;
    if (!sh) { el.style.height = ""; return; }
    const cs = getComputedStyle(el);
    const edge = cs.boxSizing === "border-box"
      ? el.offsetHeight - el.clientHeight
      : -((parseFloat(cs.paddingTop) || 0) + (parseFloat(cs.paddingBottom) || 0));
    const want = sh + edge;
    el.style.height = (max > 0 ? Math.min(want, max) : want) + "px";
  }
  (typeof window !== "undefined" ? window : globalThis).fitBox = fitBox;
})();
