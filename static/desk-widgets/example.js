// The client half of the test fixture (src/widgets/example.ts). It is NOT in ./index.js, so it
// never reaches the board — src/desk-widgets.test.ts loads it to prove the loader's contract still
// holds, and it doubles as the shortest complete widget anyone can copy.
import { el, fmtClock } from "./lib.js";

export default {
  name: "example",
  title: "Example",
  refreshMs: 30000,
  topics: ["session.started"],
  // Idempotent: called again with fresh data on every refresh, so it replaces its output rather
  // than appending to it. That is the one rule render() has.
  render(elBody, data, ctx) {
    elBody.replaceChildren(
      el("div", {}, ["hello ", el("b", { text: String(data?.hello ?? "") }), " · ", fmtClock(new Date().toISOString())]),
      el("div", { class: "werr" }, [ctx.S.sessions.length + " terminals on the desk"]),
    );
  },
};
