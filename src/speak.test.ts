import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { pickVoice, sayable, sayArgs, speak } from "./speak.js";

const v = (name: string, lang: string) => ({ name, lang, premium: /\((Premium|Enhanced)\)/.test(name) });

test("Robert speaks with the best installed male voice, env pins a name per language", () => {
  const mac = [v("Zoe (Premium)", "en_US"), v("Daniel", "en_GB"), v("Evan (Enhanced)", "en_US"), v("Nathan (Premium)", "en_US"), v("Marisol (Premium)", "es_ES"), v("Jorge", "es_ES")];
  assert.equal(pickVoice("en", mac, {}), "Nathan (Premium)");
  assert.equal(pickVoice("es", mac, {}), "Jorge");
  assert.equal(pickVoice("en", [v("Zoe (Premium)", "en_US"), v("Daniel", "en_GB")], {}), "Daniel");
  assert.equal(pickVoice("es", [v("Marisol (Premium)", "es_ES"), v("Daniel", "en_GB")], {}), "Marisol (Premium)");
  assert.equal(pickVoice("en", [], {}), "Zoe (Premium)");
  assert.equal(pickVoice("en", mac, { CHRONOS_VOICE_EN: "Ava (Premium)" }), "Ava (Premium)");
  assert.equal(pickVoice("es", mac, { CHRONOS_VOICE_EN: "Ava (Premium)" }), "Jorge");
});

test("directive lines, control characters and runaway length never reach the synthesizer", () => {
  assert.equal(sayable('Opened it.\nUI {"op":"select","id":"abcd1234"}\n{"op":"refresh"}'), "Opened it.");
  assert.equal(sayable("a" + String.fromCharCode(7) + "b\r\nc"), "a b c");
  assert.equal(sayable("x".repeat(5000)).length, 1200);
});

test("text goes in on stdin, so it can never be read as a flag", () => {
  const args = sayArgs("Zoe (Premium)", "/tmp/o.m4a");
  assert.deepEqual(args.slice(-2), ["-f", "-"]);
  assert.ok(args.includes("--file-format=m4af"));
  assert.ok(!sayArgs("v", "o", 1000).includes("-r"));
  assert.deepEqual(sayArgs("v", "o", 200).slice(-2), ["-r", "200"]);
});

const hasSay = (() => {
  try { execFileSync("which", ["say"]); return process.platform === "darwin"; } catch { return false; }
})();
test("renders real AAC audio on a Mac", { skip: !hasSay }, async () => {
  const buf = await speak("-v Nope --help. Done.", "en");
  assert.ok(buf.length > 2000);
  assert.equal(buf.subarray(4, 8).toString(), "ftyp");
});
