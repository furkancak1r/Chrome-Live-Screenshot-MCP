import test from "node:test";
import assert from "node:assert/strict";

import {
  isWslEnvironment,
  resolveRuntimeConfig,
} from "../src/runtime-config.ts";

test("runtime-config: explicit host env wins", () => {
  const cfg = resolveRuntimeConfig({
    env: {
      MCP_CHROME_WS_HOST: "10.11.12.13",
      MCP_CHROME_WS_PORT: "7001",
    },
    platform: "linux",
    release: "6.8.0",
  });

  assert.equal(cfg.host, "10.11.12.13");
  assert.equal(cfg.port, 7001);
  assert.equal(cfg.usedDefaultPort, false);
});

test("runtime-config: WSL detected by WSL_DISTRO_NAME", () => {
  assert.equal(
    isWslEnvironment({
      env: { WSL_DISTRO_NAME: "Ubuntu" },
      platform: "linux",
      release: "6.8.0",
    }),
    true
  );
});

test("runtime-config: WSL detected by WSL_INTEROP", () => {
  assert.equal(
    isWslEnvironment({
      env: { WSL_INTEROP: "/run/WSL/123_interop" },
      platform: "linux",
      release: "6.8.0",
    }),
    true
  );
});

test("runtime-config: WSL detected by microsoft kernel release", () => {
  assert.equal(
    isWslEnvironment({
      env: {},
      platform: "linux",
      release: "5.15.167.4-microsoft-standard-WSL2",
    }),
    true
  );
});

test("runtime-config: non-linux is never treated as WSL", () => {
  assert.equal(
    isWslEnvironment({
      env: { WSL_DISTRO_NAME: "Ubuntu" },
      platform: "darwin",
      release: "microsoft",
    }),
    false
  );
});

test("runtime-config: default host is 0.0.0.0 in WSL", () => {
  const cfg = resolveRuntimeConfig({
    env: {},
    platform: "linux",
    release: "5.15.167.4-microsoft-standard-WSL2",
  });

  assert.equal(cfg.host, "0.0.0.0");
});

test("runtime-config: default host is 127.0.0.1 outside WSL", () => {
  const cfg = resolveRuntimeConfig({
    env: {},
    platform: "linux",
    release: "6.8.0-generic",
  });

  assert.equal(cfg.host, "127.0.0.1");
});

test("runtime-config: missing port uses default", () => {
  const cfg = resolveRuntimeConfig({
    env: {},
    platform: "linux",
    release: "6.8.0-generic",
  });

  assert.equal(cfg.port, 8766);
  assert.equal(cfg.usedDefaultPort, true);
});

test("runtime-config: invalid non-numeric port uses default", () => {
  const cfg = resolveRuntimeConfig({
    env: { MCP_CHROME_WS_PORT: "abc" },
    platform: "linux",
    release: "6.8.0-generic",
  });

  assert.equal(cfg.port, 8766);
  assert.equal(cfg.usedDefaultPort, true);
});

test("runtime-config: out-of-range ports use default", () => {
  const cfgLow = resolveRuntimeConfig({
    env: { MCP_CHROME_WS_PORT: "0" },
    platform: "linux",
    release: "6.8.0-generic",
  });
  const cfgHigh = resolveRuntimeConfig({
    env: { MCP_CHROME_WS_PORT: "65536" },
    platform: "linux",
    release: "6.8.0-generic",
  });

  assert.equal(cfgLow.port, 8766);
  assert.equal(cfgLow.usedDefaultPort, true);
  assert.equal(cfgHigh.port, 8766);
  assert.equal(cfgHigh.usedDefaultPort, true);
});

test("runtime-config: boundary ports are accepted", () => {
  const cfgMin = resolveRuntimeConfig({
    env: { MCP_CHROME_WS_PORT: "1" },
    platform: "linux",
    release: "6.8.0-generic",
  });
  const cfgMax = resolveRuntimeConfig({
    env: { MCP_CHROME_WS_PORT: "65535" },
    platform: "linux",
    release: "6.8.0-generic",
  });

  assert.equal(cfgMin.port, 1);
  assert.equal(cfgMin.usedDefaultPort, false);
  assert.equal(cfgMax.port, 65535);
  assert.equal(cfgMax.usedDefaultPort, false);
});

