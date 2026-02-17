import { createMcpServer } from "./mcp.js";
import { WsBridge } from "./ws-bridge.js";
import { resolveRuntimeConfig } from "./runtime-config.js";

const log = (...args: unknown[]) => {
  // Never write to stdout; MCP uses stdout for protocol traffic.
  process.stderr.write(`[chrome-mcp] ${args.map(String).join(" ")}\n`);
};

async function main() {
  const wsPortEnv = process.env.MCP_CHROME_WS_PORT;
  const runtimeConfig = resolveRuntimeConfig();
  const wsHost = runtimeConfig.bindHost;
  const wsEndpointHosts = runtimeConfig.endpointHosts;
  const wsPort = runtimeConfig.port;

  if (wsPortEnv && runtimeConfig.usedDefaultPort) {
    log(`Invalid MCP_CHROME_WS_PORT: ${wsPortEnv}, using default 8766`);
  }

  log(
    `startup runtime platform=${process.platform}/${process.arch} bind=${wsHost} endpointHost=${wsEndpointHosts[0]} portRange=${runtimeConfig.portRangeStart}-${runtimeConfig.portRangeEndExclusive - 1}`
  );

  const bridge = new WsBridge({ host: wsHost, endpointHost: wsEndpointHosts[0], port: wsPort, log });
  const basePort = runtimeConfig.portRangeStart;
  const maxRetries = Math.max(1, runtimeConfig.portRangeEndExclusive - runtimeConfig.portRangeStart);
  let currentPort = basePort;
  let started = false;

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      bridge.setPort(currentPort);
      await bridge.start();
      started = true;
      break;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const netErr = err as {
        code?: string;
        errno?: number | string;
        syscall?: string;
        address?: string;
        port?: number;
      };
      log(
        `bind attempt failed host=${wsHost} port=${currentPort} code=${netErr?.code ?? "n/a"} errno=${netErr?.errno ?? "n/a"} syscall=${netErr?.syscall ?? "n/a"} address=${netErr?.address ?? "n/a"} errPort=${netErr?.port ?? "n/a"} message=${message}`
      );
      if (message.includes("EADDRINUSE")) {
        currentPort = basePort + attempt + 1;
        log(`Port ${basePort + attempt} in use on ${wsHost}, trying ${currentPort}...`);
        continue;
      }
      throw err;
    }
  }

  if (!started) {
    throw new Error(`Could not find available port after ${maxRetries} attempts.`);
  }

  let shuttingDown = false;
  const shutdown = async (reason: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    log(`received ${reason}, shutting down`);
    await bridge.stop();
    process.exit(0);
  };

  process.once("SIGINT", () => void shutdown("SIGINT"));
  process.once("SIGTERM", () => void shutdown("SIGTERM"));
  process.once("disconnect", () => void shutdown("disconnect"));
  process.stdin.on("end", () => void shutdown("stdin end"));
  process.stdin.on("close", () => void shutdown("stdin close"));

  const endpointSummary = wsEndpointHosts
    .map((host) => `ws://${host}:${currentPort}`)
    .join(", ");
  log(`WS listening bind=${wsHost}:${currentPort} endpoints=${endpointSummary}`);
  log("Secret validation: disabled (auto-connect mode).");

  const server = createMcpServer({ bridge, log });
  await server.start();
}

main().catch((err) => {
  process.stderr.write(`[chrome-mcp] fatal: ${err?.stack ?? String(err)}\n`);
  process.exitCode = 1;
});
