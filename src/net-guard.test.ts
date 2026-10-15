import { test } from "node:test";
import assert from "node:assert/strict";
import { isBlockedIp } from "./net-guard.js";

test("isBlockedIp blocks loopback, RFC1918, link-local/metadata, CGNAT", () => {
  for (const ip of ["127.0.0.1", "10.1.2.3", "172.16.0.1", "192.168.1.1", "169.254.169.254", "100.64.0.1", "0.0.0.0", "224.0.0.1"])
    assert.equal(isBlockedIp(ip), true, ip);
});

test("isBlockedIp allows public IPv4", () => {
  for (const ip of ["8.8.8.8", "1.1.1.1", "93.184.216.34"]) assert.equal(isBlockedIp(ip), false, ip);
});

test("isBlockedIp blocks IPv6 loopback/link-local/unique-local and mapped-IPv4", () => {
  assert.equal(isBlockedIp("::1"), true);
  assert.equal(isBlockedIp("fe80::1"), true);
  assert.equal(isBlockedIp("fd00::1"), true);
  assert.equal(isBlockedIp("::ffff:169.254.169.254"), true);
});

test("isBlockedIp allows public IPv6", () => {
  assert.equal(isBlockedIp("2606:4700:4700::1111"), false);
});
