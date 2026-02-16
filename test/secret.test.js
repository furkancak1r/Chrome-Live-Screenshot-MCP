import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { loadOrCreateSecretInfo } from "../src/secret.ts";

test("loadOrCreateSecretInfo: env wins", async () => {
  const prev = process.env.MCP_CHROME_SECRET;
  process.env.MCP_CHROME_SECRET = "env-secret";
  const info = await loadOrCreateSecretInfo();
  assert.equal(info.secret, "env-secret");
  assert.equal(info.source, "env");
  assert.equal(info.path, null);
  process.env.MCP_CHROME_SECRET = prev;
});

test("loadOrCreateSecretInfo: creates and then reuses file", async () => {
  const prevSecret = process.env.MCP_CHROME_SECRET;
  const prevXdg = process.env.XDG_CONFIG_HOME;
  delete process.env.MCP_CHROME_SECRET;

  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "chrome-mcp-"));
  process.env.XDG_CONFIG_HOME = tmp;

  const first = await loadOrCreateSecretInfo();
  assert.equal(first.source, "generated");
  assert.ok(first.path && first.path.includes("chrome-live-screenshot-mcp"));
  assert.ok(first.secret.length >= 16);

  const second = await loadOrCreateSecretInfo();
  assert.equal(second.source, "file");
  assert.equal(second.secret, first.secret);
  assert.equal(second.path, first.path);

  process.env.MCP_CHROME_SECRET = prevSecret;
  process.env.XDG_CONFIG_HOME = prevXdg;
});
