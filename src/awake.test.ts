import { test } from "node:test";
import assert from "node:assert/strict";
import { onAcPower } from "./awake.js";

test("onAcPower reads pmset -g ps", () => {
  assert.equal(onAcPower("Now drawing from 'AC Power'\n -InternalBattery-0 (id=1)\t41%; charging;"), true);
  assert.equal(onAcPower("Now drawing from 'Battery Power'\n -InternalBattery-0 (id=1)\t80%; discharging;"), false);
  assert.equal(onAcPower("Now drawing from 'AC Power'\n"), true);
});
