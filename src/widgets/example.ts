/**
 * A widget that exists only so the contract has something to run against: src/desk-widgets.test.ts
 * registers it, reads it, and unregisters it. It is deliberately NOT in `WIDGETS` and NOT in
 * `static/desk-widgets/index.js` — nothing the operator has asked for should appear on his board
 * because a test needed a fixture.
 *
 * It is also the shortest complete example of the shape: a name that matches the client module's
 * file name, a title in his words, the topics that should wake it, and a `data()` that reads.
 */
import type { Widget } from "./index.js";

const example: Widget = {
  name: "example",
  title: "Example",
  topics: ["session.started"],
  data: (q) => ({ hello: q.who || "desk", at: Date.now() }),
};

export default example;
