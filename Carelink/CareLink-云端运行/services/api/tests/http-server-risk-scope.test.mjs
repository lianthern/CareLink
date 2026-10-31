import test from "node:test";
import assert from "node:assert/strict";
import { deriveRiskScope } from "../src/http-server.mjs";

test("non-loopback peer ignores forged x-forwarded-for and uses the socket address", () => {
  assert.equal(deriveRiskScope("9.9.9.9", "1.2.3.4"), "ipv4:9.9.9.9");
});

test("loopback peer with a single x-forwarded-for entry trusts it", () => {
  assert.equal(deriveRiskScope("127.0.0.1", "1.2.3.4"), "ipv4:1.2.3.4");
});

test("loopback peer with a spoofed prefix trusts only the last x-forwarded-for entry", () => {
  assert.equal(deriveRiskScope("127.0.0.1", "spoofed, 1.2.3.4"), "ipv4:1.2.3.4");
});

test("loopback peer with an invalid x-forwarded-for falls back to the socket address", () => {
  assert.equal(deriveRiskScope("127.0.0.1", "not-an-ip"), "ipv4:127.0.0.1");
});

test("loopback peer with an IPv4-mapped x-forwarded-for normalizes to IPv4", () => {
  assert.equal(deriveRiskScope("127.0.0.1", "::ffff:5.6.7.8"), "ipv4:5.6.7.8");
});

test("no x-forwarded-for header uses the socket address", () => {
  assert.equal(deriveRiskScope("9.9.9.9", undefined), "ipv4:9.9.9.9");
});
