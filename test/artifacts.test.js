import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  cleanupScreenshotArtifacts,
  writeScreenshotArtifact,
} from "../src/artifacts.ts";

const PNG_1X1_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+lm5QAAAAASUVORK5CYII=";

test("artifacts: writes screenshot to disk with metadata", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "chrome-mcp-artifact-"));

  const written = await writeScreenshotArtifact({
    base64Data: PNG_1X1_BASE64,
    mimeType: "image/png",
    artifactDir: dir,
  });

  assert.equal(written.mimeType, "image/png");
  assert.equal(written.width, 1);
  assert.equal(written.height, 1);
  assert.ok(written.byteSize > 0);
  assert.ok(written.artifactPath.startsWith(dir));

  const st = await fs.stat(written.artifactPath);
  assert.ok(st.size > 0);
});

test("artifacts: cleanup removes old files only", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "chrome-mcp-cleanup-"));
  const oldFile = path.join(dir, "old.txt");
  const freshFile = path.join(dir, "fresh.txt");
  await fs.writeFile(oldFile, "old");
  await fs.writeFile(freshFile, "fresh");

  const oldDate = new Date(Date.now() - 48 * 60 * 60 * 1000);
  await fs.utimes(oldFile, oldDate, oldDate);

  const result = await cleanupScreenshotArtifacts({
    artifactDir: dir,
    maxAgeHours: 24,
  });

  assert.equal(result.deletedCount, 1);
  assert.ok(result.deletedBytes >= 3);
  assert.equal(result.keptCount, 1);
  assert.equal(result.errorCount, 0);

  await assert.rejects(() => fs.stat(oldFile));
  const freshStat = await fs.stat(freshFile);
  assert.ok(freshStat.size > 0);
});

