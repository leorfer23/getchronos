#!/usr/bin/env node
/**
 * Fake graphify executable for tests. Speaks just enough of the real CLI:
 *   --version → "graphify 0.9.64"
 *   extract <target> --out DIR … → writes DIR/graphify-out/graph.json
 *   query "<q>" --graph PATH … → prints a line including the absolute graph path
 *
 * Never phones home. Honors FAIL=1 / FAIL_EXTRACT=1 / BAD_OUT=1 for failure paths.
 */
import fs from "node:fs";
import path from "node:path";

const args = process.argv.slice(2);

if (args[0] === "--version" || args.includes("--version")) {
  process.stdout.write("graphify 0.9.64\n");
  process.exit(0);
}

if (args[0] === "extract") {
  if (process.env.FAIL_EXTRACT === "1" || process.env.FAIL === "1") {
    process.stderr.write("fake extract failed\n");
    process.exit(2);
  }
  const outIdx = args.indexOf("--out");
  const outDir = outIdx >= 0 ? args[outIdx + 1] : ".";
  const target = args[1];
  if (!target || !outDir) {
    process.stderr.write("usage: extract <target> --out DIR\n");
    process.exit(2);
  }
  // Prove code-only / no-cluster / force / max-workers were passed (tests assert via marker file).
  const marker = {
    target,
    codeOnly: args.includes("--code-only"),
    noCluster: args.includes("--no-cluster"),
    force: args.includes("--force"),
    maxWorkers: args.includes("--max-workers") ? args[args.indexOf("--max-workers") + 1] : null,
    // Secrets must never reach us — tests check the marker wasn't given env leaks.
    sawOpenAi: !!process.env.OPENAI_API_KEY,
    sawAnthropic: !!process.env.ANTHROPIC_API_KEY,
    sawAdmin: !!process.env.CHRONOS_ADMIN,
    queryLogDisabled: process.env.GRAPHIFY_QUERY_LOG_DISABLE === "1",
    maxGraphBytes: process.env.GRAPHIFY_MAX_GRAPH_BYTES || null,
    noBytecode: process.env.PYTHONDONTWRITEBYTECODE === "1",
  };
  const gdir = path.join(outDir, "graphify-out");
  fs.mkdirSync(gdir, { recursive: true });
  fs.writeFileSync(path.join(gdir, "marker.json"), JSON.stringify(marker));
  if (process.env.CHRONOS_GRAPHIFY_MARKER) {
    fs.writeFileSync(process.env.CHRONOS_GRAPHIFY_MARKER, JSON.stringify(marker));
  }
  if (process.env.BAD_OUT === "1") {
    // Extract "succeeds" but writes nothing useful.
    process.exit(0);
  }
  const graph = JSON.stringify({
    nodes: [{ id: "n1", label: "fake" }],
    edges: [],
    directed: true,
  });
  fs.writeFileSync(path.join(gdir, "graph.json"), graph);
  process.stdout.write(`wrote ${path.join(gdir, "graph.json")}\n`);
  process.exit(0);
}

if (args[0] === "query") {
  if (process.env.FAIL === "1") {
    process.stderr.write("fake query failed\n");
    process.exit(2);
  }
  const question = args[1] || "";
  const gIdx = args.indexOf("--graph");
  const graph = gIdx >= 0 ? args[gIdx + 1] : "";
  const bIdx = args.indexOf("--budget");
  const budget = bIdx >= 0 ? args[bIdx + 1] : "";
  // Include the absolute graph path so production redaction can be tested.
  // Scratch lands in cwd only. Tests fail if cwd is the artifact dir or the
  // parent forgets to delete the per-query temp dir. Never write --graph.
  fs.writeFileSync(path.join(process.cwd(), ".chronos-query-scratch"), "scratch\n");
  process.stdout.write(`answer for budget=${budget} graph=${graph} qlen=${question.length}\n`);
  process.exit(0);
}

process.stderr.write(`unknown fake-graphify args: ${args.join(" ")}\n`);
process.exit(2);
