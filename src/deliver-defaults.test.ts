/**
 * Where finished work goes, as every agent is told it (the operator's standing order): a file he will
 * send or share goes in his Downloads folder for the workspace, a reply is drafted where it was asked,
 * and work that is his own with no thread to answer in reaches him as a DM to his self-DM — the one
 * message an agent may send — or, when the send tool is refused, as a draft there.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { FOCUS_CONTRACT } from "./terminal.js";
import { NO_SEND_RULE } from "./no-send.js";
import { HEADLESS_DELIVER } from "./downloads.js";

test("every terminal is told where finished work goes", () => {
  for (const re of [
    /a file he will send or share \(xlsx, csv, pdf, zip, html export, chart png\) goes in `\$MC_DOWNLOADS`/,
    /not set on another computer: `mc file put` it/,
    /A reply to someone is a draft where they asked: a Slack thread or DM → a Slack draft there; an email → an email draft in that thread/,
    /When the work came from the operator himself and has no thread to answer in, send him a Slack DM in his self-DM with the summary, paths and links\./,
    /That DM is the only message you may send/,
    /If the send tool is refused, leave the same text as a draft in his self-DM\./,
    /--change "file: <full path>"/,
    /--change "draft: <where>"/,
  ]) assert.match(FOCUS_CONTRACT, re);
  // The no-send rule still closes the contract, and the exception is stated before it.
  assert.ok(FOCUS_CONTRACT.endsWith(NO_SEND_RULE));
  assert.ok(FOCUS_CONTRACT.indexOf("DELIVER WHERE IT WAS ASKED") < FOCUS_CONTRACT.lastIndexOf(NO_SEND_RULE));
});

test("a headless run is told where its files go and to name them in its last message — no DM", () => {
  assert.match(HEADLESS_DELIVER, /\(xlsx, csv, pdf, zip, an html export, a chart png\) — go in \$MC_DOWNLOADS/);
  assert.match(HEADLESS_DELIVER, /A reply to someone is a draft where they asked/);
  assert.match(HEADLESS_DELIVER, /names each file by its full path, and each draft/);
  // Its last message already reaches him (the run's own notice); a scheduled run never DMs him.
  assert.doesNotMatch(HEADLESS_DELIVER, /DM/);
});
