import test from "node:test";
import assert from "node:assert/strict";
import {
  parseOpenUrlArgs,
  parseScreenshotArgs,
  DEFAULT_URL,
} from "../src/mcp.ts";

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

test("parseOpenUrlArgs: defaults", () => {
  const p = parseOpenUrlArgs(undefined);
  assert.equal(p.url, DEFAULT_URL);
  assert.equal(p.match, "prefix");
  assert.equal(p.reuseIfExists, true);
  assert.equal(p.openIfMissing, true);
  assert.equal(p.focusWindow, true);
  assert.equal(p.activateTab, true);
  assert.equal(p.waitForComplete, true);
  assert.equal(p.timeoutMs, 15000);
});

test("parseOpenUrlArgs: handles exact match and disables reuse", () => {
  const p = parseOpenUrlArgs({
    match: "exact",
    reuseIfExists: false,
    openIfMissing: false,
  });

  assert.equal(p.match, "exact");
  assert.equal(p.reuseIfExists, false);
  assert.equal(p.openIfMissing, false);
});

test("parseOpenUrlArgs: clamps timeout and falls back invalid match", () => {
  const p = parseOpenUrlArgs({
    timeoutMs: 999999,
    match: "nope",
  });
  const pMin = parseOpenUrlArgs({ timeoutMs: 1 });

  assert.equal(p.match, "prefix");
  assert.equal(p.timeoutMs, 120000);
  assert.equal(pMin.timeoutMs, 1000);
});

test("parseOpenUrlArgs: boolean params - focusWindow, activateTab, waitForComplete", () => {
  const pFalse = parseOpenUrlArgs({
    focusWindow: false,
    activateTab: false,
    waitForComplete: false,
  });

  assert.equal(pFalse.focusWindow, false);
  assert.equal(pFalse.activateTab, false);
  assert.equal(pFalse.waitForComplete, false);

  const pTrue = parseOpenUrlArgs({
    focusWindow: true,
    activateTab: true,
    waitForComplete: true,
  });

  assert.equal(pTrue.focusWindow, true);
  assert.equal(pTrue.activateTab, true);
  assert.equal(pTrue.waitForComplete, true);
});

test("parseOpenUrlArgs: DEFAULT_URL fallback when url is undefined", () => {
  const p = parseOpenUrlArgs({});
  assert.equal(p.url, DEFAULT_URL);

  const pEmpty = parseOpenUrlArgs({ url: "" });
  assert.equal(pEmpty.url, DEFAULT_URL);

  const pNull = parseOpenUrlArgs({ url: null });
  assert.equal(pNull.url, DEFAULT_URL);
});

test("parseOpenUrlArgs: reuseIfExists=false with openIfMissing=false", () => {
  const p = parseOpenUrlArgs({
    reuseIfExists: false,
    openIfMissing: false,
  });
  assert.equal(p.reuseIfExists, false);
  assert.equal(p.openIfMissing, false);
});

test("parseOpenUrlArgs: valid URL passes through", () => {
  const p = parseOpenUrlArgs({ url: "https://example.com/path" });
  assert.equal(p.url, "https://example.com/path");
  assert.equal(p.match, "prefix");
});

test("parseOpenUrlArgs: invalid URL throws with helpful message", () => {
  assert.throws(
    () => parseOpenUrlArgs({ url: "not-a-valid-url" }),
    /Invalid URL format/
  );
});

test("parseScreenshotArgs: invalid URL throws with helpful message", () => {
  assert.throws(
    () => parseScreenshotArgs({ url: "invalid" }),
    /Invalid URL format/
  );
});

test("parseScreenshotArgs: empty URL uses DEFAULT_URL and passes", () => {
  const p = parseScreenshotArgs({ url: "" });
  assert.equal(p.url, DEFAULT_URL);
});
