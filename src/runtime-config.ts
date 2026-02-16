import os from "node:os";

type EnvLike = Record<string, string | undefined>;

export type RuntimeConfigInput = {
  env?: EnvLike;
  platform?: string;
  release?: string;
};

export type RuntimeConfig = {
  host: string;
  port: number;
  usedDefaultPort: boolean;
  isWslDetected: boolean;
};

const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_WSL_HOST = "0.0.0.0";
const DEFAULT_PORT = 8766;

function getEnv(input: RuntimeConfigInput): EnvLike {
  return input.env ?? (process.env as EnvLike);
}

function getPlatform(input: RuntimeConfigInput): string {
  return input.platform ?? process.platform;
}

function getRelease(input: RuntimeConfigInput): string {
  return input.release ?? os.release();
}

function normalizeEnvValue(value: string | undefined): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

export function isWslEnvironment(input: RuntimeConfigInput = {}): boolean {
  const platform = getPlatform(input);
  if (platform !== "linux") return false;

  const env = getEnv(input);
  if (normalizeEnvValue(env.WSL_DISTRO_NAME)) return true;
  if (normalizeEnvValue(env.WSL_INTEROP)) return true;

  return getRelease(input).toLowerCase().includes("microsoft");
}

export function resolveRuntimeConfig(input: RuntimeConfigInput = {}): RuntimeConfig {
  const env = getEnv(input);
  const isWslDetected = isWslEnvironment(input);

  const envHost = normalizeEnvValue(env.MCP_CHROME_WS_HOST);
  const host = envHost ?? (isWslDetected ? DEFAULT_WSL_HOST : DEFAULT_HOST);

  const rawPort = normalizeEnvValue(env.MCP_CHROME_WS_PORT);
  const parsedPort = rawPort ? Number.parseInt(rawPort, 10) : Number.NaN;
  const validPort =
    Number.isInteger(parsedPort) && parsedPort >= 1 && parsedPort <= 65535;

  return {
    host,
    port: validPort ? parsedPort : DEFAULT_PORT,
    usedDefaultPort: !validPort,
    isWslDetected,
  };
}

