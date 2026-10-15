import test from "node:test";
import assert from "node:assert/strict";
import {
  daysBetween,
  defaultTierFor,
  entryHash,
  parseMarker,
  parseMemory,
  perishableLacksCondition,
  renderEntry,
  serializeMarker,
  serializeMemory,
  staleness,
} from "./memory-tiers.js";

const at = (d: string) => new Date(`${d}T12:00:00Z`);

test("every marker shape parses and serializes back to itself", () => {
  const lines = [
    "- branch before editing a pool slot <!--a:2026-08-03-->",
    "- the sync is broken, daemon owns triage (MC-91) <!--p:2026-09-01-->",
    "- never restart the daemon while runs are active <!--P-->",
    "- codex writes its trust prompt to stderr <!--a:2026-07-28/6-->",
    "- an unconfirmed legacy fact <!--g-->",
    "- a plain unmarked fact",
  ];
  const parsed = parseMemory(lines.join("\n"));
  assert.equal(parsed.entries.length, 6);
  for (const e of parsed.entries) assert.equal(renderEntry(e), e.raw);
  assert.equal(serializeMemory(parsed), lines.join("\n"));

  const [aging, perishable, pinned, counted, graced, plain] = parsed.entries;
  assert.equal(aging.tier, "aging");
  assert.equal(aging.reinforced, "2026-08-03");
  assert.equal(perishable.tier, "perishable");
  assert.equal(pinned.tier, "pinned");
  assert.equal(counted.passes, 6);
  assert.equal(graced.grace, true);
  assert.equal(graced.reinforced, null);
  assert.equal(plain.marked, false);
});

test("a pass counter of zero costs no marker bytes", () => {
  assert.equal(serializeMarker({ tier: "aging", reinforced: "2026-09-01", passes: 0, grace: false }), "<!--a:2026-09-01-->");
  assert.equal(serializeMarker({ tier: "aging", reinforced: "2026-09-01", passes: 3, grace: false }), "<!--a:2026-09-01/3-->");
  assert.equal(serializeMarker({ tier: "pinned", reinforced: null, passes: 0, grace: false }), "<!--P-->");
  assert.equal(serializeMarker({ tier: "aging", reinforced: null, passes: 0, grace: true }), "<!--g-->");
  // An unmarked entry that was never stamped stays unmarked: the file default is not re-spelled.
  assert.equal(serializeMarker({ tier: "aging", reinforced: null, passes: 0, grace: false }), "");
});

test("an entry's identity survives reformatting but not rewording", () => {
  assert.equal(entryHash("Branch   before\nediting."), entryHash("branch before editing."));
  assert.notEqual(entryHash("branch before editing."), entryHash("branch after editing."));
  // The marker is bookkeeping, not content — an entry keeps its identity when its clock is stamped.
  assert.equal(entryHash("a fact <!--a:2026-01-01-->"), entryHash("a fact"));
});

test("unmarked entries take the file default, and a Pinned section overrides it", () => {
  assert.equal(defaultTierFor("/notes/personal/memory-robert.md"), "aging");
  assert.equal(defaultTierFor("lessons.md"), "aging");
  assert.equal(defaultTierFor("/notes/personal/operator-profile.md"), "pinned");

  const body = [
    "# Memory — robert",
    "",
    "## Facts",
    "- an operational fact",
    "",
    "## Pinned",
    "- the operator's daughter is called Uma",
    "",
    "## Facts again",
    "- another operational fact",
    "- but this one says otherwise <!--p:2026-09-01-->",
  ].join("\n");
  const e = parseMemory(body, "aging").entries;
  assert.deepEqual(e.map((x) => x.tier), ["aging", "pinned", "aging", "perishable"]);
});

test("clocks are stale AT the boundary, and pinned has no clock at all", () => {
  const [aging, perishable, pinned] = parseMemory(
    [
      "- a <!--a:2026-08-01-->",
      "- b <!--p:2026-08-01-->",
      "- c <!--P-->",
    ].join("\n"),
  ).entries;

  assert.equal(staleness(aging, at("2026-08-30")).stale, false); // 29 days
  assert.equal(staleness(aging, at("2026-08-31")).stale, true); // 30 days
  assert.equal(staleness(aging, at("2026-08-31")).reason, "unreinforced 30d");
  assert.equal(staleness(perishable, at("2026-08-07")).stale, false); // 6 days
  assert.equal(staleness(perishable, at("2026-08-08")).stale, true); // 7 days
  assert.equal(staleness(pinned, at("2030-01-01")).stale, false);
  assert.equal(daysBetween("2026-08-01", at("2026-08-31")), 30);
});

test("the pass horizon is off unless asked for, and never mislabels a wall-clock expiry", () => {
  const [fresh, old] = parseMemory(["- a <!--a:2026-08-25/10-->", "- b <!--a:2026-07-01/12-->"].join("\n")).entries;
  const now = at("2026-08-31");
  assert.equal(staleness(fresh, now).stale, false); // 6 days old, counter ignored while opted out
  assert.equal(staleness(fresh, now, true).stale, true);
  assert.equal(staleness(fresh, now, true).reason, "unreinforced 10p");
  // Both horizons blown: the wall clock is what is reported, since the counter did not cause it.
  assert.equal(staleness(old, now, true).reason, "unreinforced 61d");
});

test("a perishable with nothing checkable in its prose is reported, not judged", () => {
  const [vague, dated, keyed] = parseMemory(
    [
      "- the migration is still running <!--p:2026-09-01-->",
      "- freeze until 2026-10-01 <!--p:2026-09-01-->",
      "- blocked on MC-91 <!--p:2026-09-01-->",
    ].join("\n"),
  ).entries;
  assert.equal(perishableLacksCondition(vague), true);
  assert.equal(perishableLacksCondition(dated), false);
  assert.equal(perishableLacksCondition(keyed), false);
});

test("a stray marker mid-line is prose, not a clock", () => {
  const [e] = parseMemory("- explain <!--a:2026-01-01--> markers to the operator").entries;
  assert.equal(e.marked, false);
  assert.equal(renderEntry(e), e.raw);
});

test("parseMarker ignores a malformed date", () => {
  assert.equal(parseMarker("a fact <!--a:2026-8-3-->"), null);
});
