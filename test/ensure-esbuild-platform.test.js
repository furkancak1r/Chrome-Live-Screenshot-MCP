import test from "node:test";
import assert from "node:assert/strict";

import { spawnSync } from "node:child_process";

test("ensure-esbuild-platform script supports --check mode", () => {
  const result = spawnSync(
    process.execPath,
    ["scripts/ensure-esbuild-platform.mjs", "--check"],
    {
      cwd: process.cwd(),
      env: process.env,
      encoding: "utf8",
    }
  );

  assert.equal(result.status, 0);
});
