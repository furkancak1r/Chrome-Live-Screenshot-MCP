import test from "node:test";
import assert from "node:assert/strict";
import { parseScreenshotArgs, DEFAULT_URL } from "../src/mcp.ts";

test("parseScreenshotArgs: defaults", () => {
  const p = parseScreenshotArgs(undefined);
  assert.equal(p.url, DEFAULT_URL);
  assert.equal(p.match, "prefix");
  assert.equal(p.openIfMissing, true);
  assert.equal(p.focusWindow, true);
  assert.equal(p.activateTab, true);
  assert.equal(p.waitForComplete, true);
  assert.equal(p.timeoutMs, 15000);
  assert.equal(p.extraWaitMs, 250);
  assert.equal(p.format, "png");
  assert.equal(p.jpegQuality, 80);
  assert.equal(p.returnMode, "artifact");
  assert.equal(p.artifactDir, undefined);
});

test("parseScreenshotArgs: clamps values", () => {
  const p = parseScreenshotArgs({
    timeoutMs: 999999,
    extraWaitMs: -5,
    format: "jpeg",
    jpegQuality: 999
  });
  assert.ok(p.timeoutMs <= 120000);
  assert.equal(p.extraWaitMs, 0);
  assert.equal(p.format, "jpeg");
  assert.equal(p.jpegQuality, 100);
});

test("parseScreenshotArgs: match handling", () => {
  assert.equal(parseScreenshotArgs({ match: "exact" }).match, "exact");
  assert.equal(parseScreenshotArgs({ match: "prefix" }).match, "prefix");
  assert.equal(parseScreenshotArgs({ match: "nope" }).match, "prefix");
});

test("parseScreenshotArgs: return mode and artifact dir", () => {
  const p = parseScreenshotArgs({
    returnMode: "image",
    artifactDir: " /tmp/custom-captures ",
  });
  assert.equal(p.returnMode, "image");
  assert.equal(p.artifactDir, "/tmp/custom-captures");
});

test("parseScreenshotArgs: invalid return mode falls back to artifact", () => {
  const p = parseScreenshotArgs({ returnMode: "nope" });
  assert.equal(p.returnMode, "artifact");
});

test("parseScreenshotArgs: clamps lower bounds", () => {
  const p = parseScreenshotArgs({
    timeoutMs: 1,
    extraWaitMs: -100,
    format: "jpeg",
    jpegQuality: -20,
  });

  assert.equal(p.timeoutMs, 1000);
  assert.equal(p.extraWaitMs, 0);
  assert.equal(p.format, "jpeg");
  assert.equal(p.jpegQuality, 0);
});
