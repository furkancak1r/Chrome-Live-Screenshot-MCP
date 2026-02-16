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
  const wsHost = runtimeConfig.host;
  const wsPort = runtimeConfig.port;

  if (wsPortEnv && runtimeConfig.usedDefaultPort) {
    log(`Invalid MCP_CHROME_WS_PORT: ${wsPortEnv}, using default 8766`);
  }

  const bridge = new WsBridge({ host: wsHost, port: wsPort, log });

  try {
    await bridge.start();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (message.includes("EADDRINUSE")) {
      throw new Error(
        `WS port ${wsPort} is already in use. Stop the previous MCP bridge process and start again.`
      );
    }
    throw err;
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

  log(`WS listening on ws://${wsHost}:${wsPort}`);
  log("Secret validation: disabled (auto-connect mode).");

  const server = createMcpServer({ bridge, log });
  await server.start();
}

main().catch((err) => {
  process.stderr.write(`[chrome-mcp] fatal: ${err?.stack ?? String(err)}\n`);
  process.exitCode = 1;
});
