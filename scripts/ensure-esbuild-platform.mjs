import { access, readFile } from "node:fs/promises";
import { constants } from "node:fs";
import { spawn } from "node:child_process";
import path from "node:path";
import process from "node:process";

function log(message) {
  process.stderr.write(`[ensure-esbuild] ${message}\n`);
}

function parseArgs(argv) {
  return {
    checkOnly: argv.includes("--check"),
  };
}

function getPlatformPackageName() {
  const platform = process.platform;
  const arch = process.arch;

  if (platform === "win32" && arch === "x64") return "@esbuild/win32-x64";
  if (platform === "win32" && arch === "arm64") return "@esbuild/win32-arm64";
  if (platform === "linux" && arch === "x64") return "@esbuild/linux-x64";
  if (platform === "linux" && arch === "arm64") return "@esbuild/linux-arm64";
  if (platform === "darwin" && arch === "x64") return "@esbuild/darwin-x64";
  if (platform === "darwin" && arch === "arm64") return "@esbuild/darwin-arm64";
  return null;
}

async function commandExists(command) {
  const exts = process.platform === "win32"
    ? ["", ".cmd", ".exe", ".bat"]
    : [""];
  const pathEntries = (process.env.PATH || "").split(path.delimiter).filter(Boolean);

  for (const dir of pathEntries) {
    for (const ext of exts) {
      const candidate = path.join(dir, `${command}${ext}`);
      try {
        await access(candidate, constants.X_OK);
        return true;
      } catch {
        // continue
      }
    }
  }
  return false;
}

async function readJson(filePath) {
  const raw = await readFile(filePath, "utf8");
  return JSON.parse(raw);
}

async function hasExpectedPlatformPackage(expectedPackage) {
  try {
    const lock = await readJson(path.join(process.cwd(), "package-lock.json"));
    const pkgSection = lock?.packages;
    if (!pkgSection || typeof pkgSection !== "object") return false;
    return Boolean(pkgSection[`node_modules/${expectedPackage}`]);
  } catch {
    return false;
  }
}

async function runNpmRebuildEsbuild() {
  const npmCmd = process.platform === "win32" ? "npm.cmd" : "npm";

  await new Promise((resolve, reject) => {
    const child = spawn(npmCmd, ["rebuild", "esbuild"], {
      stdio: "inherit",
      cwd: process.cwd(),
      env: process.env,
    });

    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) {
        resolve(true);
        return;
      }
      reject(new Error(`npm rebuild esbuild exited with code ${code ?? "unknown"}`));
    });
  });
}

async function runEsbuildSmokeCheck() {
  return await new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    const child = spawn(
      process.execPath,
      [
        "-e",
        "try { require('esbuild').transformSync('let x = 1', {}); process.stdout.write('ok'); } catch (err) { process.stderr.write(String(err?.stack ?? err)); process.exit(1); }",
      ],
      {
        stdio: ["ignore", "pipe", "pipe"],
        cwd: process.cwd(),
        env: process.env,
      }
    );

    child.stdout?.on("data", (chunk) => {
      stdout += String(chunk);
    });
    child.stderr?.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.on("error", (err) => {
      resolve({
        ok: false,
        message: String(err?.stack ?? err),
      });
    });
    child.on("exit", (code) => {
      if (code === 0 && stdout.trim() === "ok") {
        resolve({ ok: true, message: "" });
        return;
      }
      const message = stderr.trim() || stdout.trim() || `exit code ${code ?? "unknown"}`;
      resolve({ ok: false, message });
    });
  });
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const expectedPackage = getPlatformPackageName();
  log(
    `startup platform=${process.platform}/${process.arch} checkOnly=${args.checkOnly}`
  );
  if (!expectedPackage) {
    log(`No platform mapping for ${process.platform}/${process.arch}, skipping.`);
    return;
  }

  log(`expected platform package: ${expectedPackage}`);

  const hasNpm = await commandExists(process.platform === "win32" ? "npm.cmd" : "npm");
  if (!hasNpm) {
    log("npm command not found, skipping esbuild platform check.");
    return;
  }

  const matched = await hasExpectedPlatformPackage(expectedPackage);
  const smoke = await runEsbuildSmokeCheck();
  if (matched && smoke.ok) {
    log(`esbuild platform package is compatible (${expectedPackage}).`);
    return;
  }

  if (!matched) {
    log(`esbuild platform package mismatch detected (expected ${expectedPackage}).`);
  }
  if (!smoke.ok) {
    log(`esbuild runtime check failed: ${smoke.message}`);
  }

  if (args.checkOnly) {
    log(`check mode: possible mismatch detected, expected ${expectedPackage}.`);
    return;
  }

  log(`Detected possible esbuild platform mismatch. Expected ${expectedPackage}. Running npm rebuild esbuild...`);
  await runNpmRebuildEsbuild();
  const afterRebuild = await runEsbuildSmokeCheck();
  if (!afterRebuild.ok) {
    throw new Error(
      `esbuild is still not usable after rebuild: ${afterRebuild.message}`
    );
  }
  log("esbuild rebuild completed and runtime check passed.");
}

main().catch((err) => {
  log(`fatal: ${err?.message ?? String(err)}`);
  process.exitCode = 1;
});
