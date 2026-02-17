import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import type { WsBridge } from "./ws-bridge.js";
import {
  cleanupScreenshotArtifacts,
  getDefaultArtifactDir,
  writeScreenshotArtifact,
} from "./artifacts.js";

type Logger = (...args: unknown[]) => void;

type CreateMcpServerArgs = {
  bridge: WsBridge;
  log: Logger;
};

export const DEFAULT_URL = "http://localhost:5173/";

const MAX_TIMEOUT_MS = 120_000;
const MAX_EXTRA_WAIT_MS = 10_000;
const MAX_CLEANUP_HOURS = 24 * 365 * 10;

export type ScreenshotParams = {
  url: string;
  match: "prefix" | "exact";
  openIfMissing: boolean;
  focusWindow: boolean;
  activateTab: boolean;
  waitForComplete: boolean;
  timeoutMs: number;
  extraWaitMs: number;
  format: "png" | "jpeg";
  jpegQuality: number;
  returnMode: "artifact" | "image";
  artifactDir?: string;
};

export type CleanupArtifactsParams = {
  artifactDir?: string;
  maxAgeHours: number;
};

export type OpenUrlParams = {
  url: string;
  match: "prefix" | "exact";
  reuseIfExists: boolean;
  openIfMissing: boolean;
  focusWindow: boolean;
  activateTab: boolean;
  waitForComplete: boolean;
  timeoutMs: number;
};

function asBool(v: unknown, fallback: boolean): boolean {
  return typeof v === "boolean" ? v : fallback;
}

function asNum(v: unknown, fallback: number): number {
  return typeof v === "number" && Number.isFinite(v) ? v : fallback;
}

function asStr(v: unknown, fallback: string): string {
  return typeof v === "string" && v.length > 0 ? v : fallback;
}

function asOptStr(v: unknown): string | undefined {
  if (typeof v !== "string") return undefined;
  const trimmed = v.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function clamp(n: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, n));
}

export function parseScreenshotArgs(
  args: Record<string, unknown> | undefined
): ScreenshotParams {
  const a = args ?? {};

  const originalUrl = a.url;
  const url = asStr(a.url, DEFAULT_URL);

  // Validate URL format
  try {
    new URL(url);
  } catch {
    const displayUrl = originalUrl === undefined || originalUrl === "" ? DEFAULT_URL : originalUrl;
    throw new Error(`Invalid URL format: "${displayUrl}" is not a valid URL`);
  }
  const match: "prefix" | "exact" = a.match === "exact" ? "exact" : "prefix";
  const openIfMissing = asBool(a.openIfMissing, true);
  const focusWindow = asBool(a.focusWindow, true);
  const activateTab = asBool(a.activateTab, true);
  const waitForComplete = asBool(a.waitForComplete, true);
  const timeoutMs = clamp(asNum(a.timeoutMs, 15_000), 1_000, MAX_TIMEOUT_MS);
  const extraWaitMs = clamp(asNum(a.extraWaitMs, 250), 0, MAX_EXTRA_WAIT_MS);
  const format: "png" | "jpeg" = a.format === "jpeg" ? "jpeg" : "png";
  const jpegQuality = clamp(asNum(a.jpegQuality, 80), 0, 100);
  const returnMode: "artifact" | "image" =
    a.returnMode === "image" ? "image" : "artifact";
  const artifactDir = asOptStr(a.artifactDir);

  return {
    url,
    match,
    openIfMissing,
    focusWindow,
    activateTab,
    waitForComplete,
    timeoutMs,
    extraWaitMs,
    format,
    jpegQuality,
    returnMode,
    artifactDir,
  };
}

export function parseCleanupArtifactsArgs(
  args: Record<string, unknown> | undefined
): CleanupArtifactsParams {
  const a = args ?? {};
  const maxAgeHours = clamp(asNum(a.maxAgeHours, 24), 1, MAX_CLEANUP_HOURS);
  const artifactDir = asOptStr(a.artifactDir);
  return { maxAgeHours, artifactDir };
}

/**
 * Parses and validates arguments for the chrome_open_url tool.
 * @param args - Raw arguments from the MCP request.
 * @returns Parsed OpenUrlParams with validated and sanitized values.
 * @throws {Error} If the URL is invalid.
 */
export function parseOpenUrlArgs(
  args: Record<string, unknown> | undefined
): OpenUrlParams {
  const a = args ?? {};

  const originalUrl = a.url;
  const url = asStr(a.url, DEFAULT_URL);
  try {
    new URL(url);
  } catch {
    const displayUrl = originalUrl === undefined || originalUrl === "" ? DEFAULT_URL : originalUrl;
    throw new Error(`Invalid URL format: "${displayUrl}" is not a valid URL`);
  }
  const matchValue = a.match;
  if (matchValue !== undefined && matchValue !== "exact" && matchValue !== "prefix") {
    console.warn(`Invalid match value "${matchValue}" - defaulting to "prefix"`);
  }
  const match: "prefix" | "exact" =
    matchValue === "exact" ? "exact" : matchValue === "prefix" ? "prefix" : "prefix";
  const reuseIfExists = asBool(a.reuseIfExists, true);
  const openIfMissing = asBool(a.openIfMissing, true);
  const focusWindow = asBool(a.focusWindow, true);
  const activateTab = asBool(a.activateTab, true);
  const waitForComplete = asBool(a.waitForComplete, true);
  const timeoutMs = clamp(asNum(a.timeoutMs, 15_000), 1_000, MAX_TIMEOUT_MS);

  return {
    url,
    match,
    reuseIfExists,
    openIfMissing,
    focusWindow,
    activateTab,
    waitForComplete,
    timeoutMs,
  };
}

export function createMcpServer({ bridge, log }: CreateMcpServerArgs) {
  const server = new Server(
    { name: "chrome-live-screenshot-mcp", version: "0.1.0" },
    { capabilities: { tools: {} } }
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    return {
      tools: [
        {
          name: "chrome_list_tabs",
          description: "List currently open Chrome tabs (via installed extension).",
          inputSchema: {
            type: "object",
            properties: {},
            additionalProperties: false,
          },
        },
        {
          name: "chrome_screenshot",
          description:
            "Capture a viewport screenshot from an already-open Chrome tab matching a URL (default http://localhost:5173/). Default returnMode='artifact' to keep context light.",
          inputSchema: {
            type: "object",
            properties: {
              url: { type: "string", description: "Target URL to match." },
              match: {
                type: "string",
                enum: ["prefix", "exact"],
                description: "How to match the URL against open tabs.",
              },
              openIfMissing: {
                type: "boolean",
                description: "Open a new tab if no match is found.",
              },
              focusWindow: {
                type: "boolean",
                description: "Focus the window before capturing.",
              },
              activateTab: {
                type: "boolean",
                description: "Activate the tab before capturing.",
              },
              waitForComplete: {
                type: "boolean",
                description:
                  "Wait for tab load status to be 'complete' before capturing.",
              },
              timeoutMs: {
                type: "number",
                description: "Max time to wait for load/operations.",
              },
              extraWaitMs: {
                type: "number",
                description: "Extra settle wait before capture.",
              },
              format: {
                type: "string",
                enum: ["png", "jpeg"],
                description: "Image format to capture.",
              },
              jpegQuality: {
                type: "number",
                description: "JPEG quality (0-100). Only used when format=jpeg.",
              },
              returnMode: {
                type: "string",
                enum: ["artifact", "image"],
                description:
                  "artifact (default): save to disk and return path+metadata; image: return base64 image content.",
              },
              artifactDir: {
                type: "string",
                description:
                  "Optional directory for artifact files. Default is platform cache directory.",
              },
            },
            additionalProperties: false,
          },
        },
        {
          name: "chrome_open_url",
          description:
            "Open or focus a URL in the already-open Chrome session via extension. This does not launch a new Chrome process.",
          inputSchema: {
            type: "object",
            properties: {
              url: { type: "string", description: "Target URL to open." },
              match: {
                type: "string",
                enum: ["prefix", "exact"],
                description: "How to match existing tabs before opening.",
              },
              reuseIfExists: {
                type: "boolean",
                description:
                  "Reuse an already-open matching tab when available.",
              },
              openIfMissing: {
                type: "boolean",
                description: "Open a new tab when no match is found.",
              },
              focusWindow: {
                type: "boolean",
                description: "Focus the window containing the target tab.",
              },
              activateTab: {
                type: "boolean",
                description: "Activate the target tab.",
              },
              waitForComplete: {
                type: "boolean",
                description: "Wait for tab load status to be 'complete'.",
              },
              timeoutMs: {
                type: "number",
                description: "Max wait time for tab load and operations.",
              },
            },
            additionalProperties: false,
          },
        },
        {
          name: "chrome_artifact_cleanup",
          description:
            "Clean up old screenshot artifacts from disk to keep cache size under control.",
          inputSchema: {
            type: "object",
            properties: {
              maxAgeHours: {
                type: "number",
                description: "Delete files older than this many hours (default 24).",
              },
              artifactDir: {
                type: "string",
                description:
                  "Optional artifact directory to clean. Default is platform cache directory.",
              },
            },
            additionalProperties: false,
          },
        },
      ],
    };
  });

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const name = request.params.name;
    const args = (request.params.arguments ?? {}) as Record<string, unknown>;

    if (name === "chrome_list_tabs") {
      const result = await bridge.call("listTabs", {}, 15_000);
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
      };
    }

    if (name === "chrome_screenshot") {
      const p = parseScreenshotArgs(args);

      const result = (await bridge.call(
        "screenshot",
        {
          url: p.url,
          match: p.match,
          openIfMissing: p.openIfMissing,
          focusWindow: p.focusWindow,
          activateTab: p.activateTab,
          waitForComplete: p.waitForComplete,
          timeoutMs: p.timeoutMs,
          extraWaitMs: p.extraWaitMs,
          format: p.format,
          jpegQuality: p.jpegQuality,
        },
        p.timeoutMs + 10_000
      )) as { mimeType: string; data: string };

      if (!result?.mimeType || !result?.data) {
        log("screenshot result missing fields", JSON.stringify(result));
        throw new Error("Extension returned an invalid screenshot response.");
      }

      if (p.returnMode === "image") {
        return {
          content: [
            {
              type: "image",
              mimeType: result.mimeType,
              data: result.data,
            },
          ],
        };
      }

      const artifact = await writeScreenshotArtifact({
        base64Data: result.data,
        mimeType: result.mimeType,
        artifactDir: p.artifactDir,
      });

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                success: true,
                returnMode: "artifact",
                artifactPath: artifact.artifactPath,
                mimeType: artifact.mimeType,
                byteSize: artifact.byteSize,
                width: artifact.width,
                height: artifact.height,
                defaultArtifactDir: getDefaultArtifactDir(),
                attachHints: {
                  codex: `codex exec --image "${artifact.artifactPath}" "<prompt>"`,
                  opencode: `opencode run --file "${artifact.artifactPath}" "<prompt>"`,
                },
              },
              null,
              2
            ),
          },
        ],
      };
    }

    if (name === "chrome_open_url") {
      const p = parseOpenUrlArgs(args);
      const result = await bridge.call(
        "openUrl",
        {
          url: p.url,
          match: p.match,
          reuseIfExists: p.reuseIfExists,
          openIfMissing: p.openIfMissing,
          focusWindow: p.focusWindow,
          activateTab: p.activateTab,
          waitForComplete: p.waitForComplete,
          timeoutMs: p.timeoutMs,
        },
        p.timeoutMs + 10_000
      );
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
      };
    }

    if (name === "chrome_artifact_cleanup") {
      const p = parseCleanupArtifactsArgs(args);
      const result = await cleanupScreenshotArtifacts({
        artifactDir: p.artifactDir,
        maxAgeHours: p.maxAgeHours,
      });
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
      };
    }

    throw new Error(`Unknown tool: ${name}`);
  });

  return {
    async start() {
      const transport = new StdioServerTransport();
      await server.connect(transport);
      log("MCP server started (stdio).");
    },
  };
}
