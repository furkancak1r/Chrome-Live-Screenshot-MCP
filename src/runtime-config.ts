import os from "node:os";

type EnvLike = Record<string, string | undefined>;

export type RuntimeConfigInput = {
  env?: EnvLike;
  platform?: string;
  release?: string;
};

export type RuntimeConfig = {
  host: string;
  bindHost: string;
  endpointHost: string;
  endpointHosts: string[];
  port: number;
  portRangeStart: number;
  portRangeEndExclusive: number;
  usedDefaultPort: boolean;
  isWslDetected: boolean;
};

const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_WSL_HOST = "0.0.0.0";
const DEFAULT_ENDPOINT_HOST = "localhost";
const DEFAULT_ENDPOINT_HOSTS = ["localhost", "127.0.0.1"];
const DEFAULT_WSL_ENDPOINT_HOSTS = ["wsl.localhost", "localhost", "127.0.0.1"];
const DEFAULT_PORT = 8766;
const PORT_FALLBACK_COUNT = 10;

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

function splitCsv(value: string | undefined): string[] {
  const normalized = normalizeEnvValue(value);
  if (!normalized) return [];
  return normalized
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

function uniquePreserveOrder(values: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values) {
    if (seen.has(value)) continue;
    seen.add(value);
    out.push(value);
  }
  return out;
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
  const bindHost = envHost ?? (isWslDetected ? DEFAULT_WSL_HOST : DEFAULT_HOST);

  const rawPort = normalizeEnvValue(env.MCP_CHROME_WS_PORT);
  const parsedPort = rawPort ? Number.parseInt(rawPort, 10) : Number.NaN;
  const validPort =
    Number.isInteger(parsedPort) && parsedPort >= 1 && parsedPort <= 65535;

  const port = validPort ? parsedPort : DEFAULT_PORT;
  const envEndpointHosts = splitCsv(env.MCP_CHROME_WS_ENDPOINT_HOSTS);
  const envEndpointHost = normalizeEnvValue(env.MCP_CHROME_WS_ENDPOINT_HOST);
  const defaultEndpointHosts = isWslDetected
    ? DEFAULT_WSL_ENDPOINT_HOSTS
    : DEFAULT_ENDPOINT_HOSTS;
  const endpointHosts = uniquePreserveOrder([
    ...envEndpointHosts,
    ...(envEndpointHost ? [envEndpointHost] : []),
    ...(envHost ? [envHost] : []),
    ...defaultEndpointHosts,
  ]);
  const endpointHost = endpointHosts[0] ?? DEFAULT_ENDPOINT_HOST;

  return {
    host: bindHost,
    bindHost,
    endpointHost,
    endpointHosts,
    port,
    portRangeStart: port,
    portRangeEndExclusive: port + PORT_FALLBACK_COUNT,
    usedDefaultPort: !validPort,
    isWslDetected,
  };
}
