import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

function getConfigDir(): string {
  const xdg = process.env.XDG_CONFIG_HOME;
  if (xdg && xdg.length > 0) return xdg;

  if (process.platform === "win32") {
    const appData = process.env.APPDATA;
    if (appData && appData.length > 0) return appData;
    return path.join(os.homedir(), "AppData", "Roaming");
  }

  if (process.platform === "darwin") {
    return path.join(os.homedir(), "Library", "Application Support");
  }

  return path.join(os.homedir(), ".config");
}

export async function loadOrCreateSecret(): Promise<string> {
  const info = await loadOrCreateSecretInfo();
  return info.secret;
}

export type SecretInfo = {
  secret: string;
  path: string | null;
  source: "env" | "file" | "generated";
};

export async function loadOrCreateSecretInfo(): Promise<SecretInfo> {
  const envSecret = process.env.MCP_CHROME_SECRET;
  if (envSecret && envSecret.trim().length > 0) {
    return { secret: envSecret.trim(), path: null, source: "env" };
  }

  const configDir = path.join(getConfigDir(), "chrome-live-screenshot-mcp");
  const secretPath = path.join(configDir, "secret");

  try {
    const existing = await fs.readFile(secretPath, "utf8");
    const secret = existing.trim();
    if (secret.length > 0) {
      return { secret, path: secretPath, source: "file" };
    }
  } catch (err) {
    console.error("[secret] Could not read secret file:", err);
  }

  await fs.mkdir(configDir, { recursive: true });
  const secret = crypto.randomBytes(24).toString("base64url"); // ~32 chars
  await fs.writeFile(secretPath, `${secret}\n`, { encoding: "utf8", mode: 0o600 });
  console.error("[secret] Generated new secret and saved to:", secretPath);
  return { secret, path: secretPath, source: "generated" };
}
