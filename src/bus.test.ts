import { describe, it, before, after } from "node:test";
import assert from "node:assert";
import { bus } from "./bus.js";

describe("bus listener isolation", () => {
  const logs: unknown[] = [];
  const originalError = console.error;
  const listeners: Array<(...args: any[]) => any> = [];

  before(() => {
    console.error = (...args: unknown[]) => logs.push(args);
  });

  after(() => {
    console.error = originalError;
    // Clean up all test listeners
    listeners.forEach((l) => bus.removeListener("event", l));
    listeners.length = 0;
  });

  it("isolates throwing sync listeners from publisher", () => {
    logs.length = 0;
    const results: string[] = [];

    const thrower = () => {
      throw new Error("sync error");
    };
    const runner = () => {
      results.push("ran");
    };

    bus.on("event", thrower);
    bus.on("event", runner);
    listeners.push(thrower, runner);

    // Should not throw
    bus.publish({ topic: "workspace.changed" });

    assert.deepEqual(results, ["ran"]);
    assert(logs.some((l) => Array.isArray(l) && l[0] === "[bus]"));
  });

  it("isolates rejected async listeners from publisher", async () => {
    logs.length = 0;
    const results: string[] = [];

    const asyncThrower = async () => {
      throw new Error("async error");
    };
    const asyncRunner = async () => {
      results.push("ran");
    };

    bus.on("event", asyncThrower);
    bus.on("event", asyncRunner);
    listeners.push(asyncThrower, asyncRunner);

    // Should not throw
    bus.publish({ topic: "workspace.changed" });

    // Give promises time to reject
    await new Promise((resolve) => setTimeout(resolve, 50));

    assert(results.includes("ran"));
    assert(logs.some((l) => Array.isArray(l) && l[0] === "[bus]"));
  });

  it("allows first listener's sync throw to not block later listeners", () => {
    logs.length = 0;
    const results: string[] = [];

    const thrower1 = () => {
      throw new Error("first error");
    };
    const runner = () => {
      results.push("middle");
    };
    const thrower2 = () => {
      throw new Error("second error");
    };

    bus.on("event", thrower1);
    bus.on("event", runner);
    bus.on("event", thrower2);
    listeners.push(thrower1, runner, thrower2);

    bus.publish({ topic: "workspace.changed" });

    assert.deepEqual(results, ["middle"]);
  });
});
