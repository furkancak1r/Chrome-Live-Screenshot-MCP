# CLAUDE.md

This repository is an MCP server that captures screenshots from already-open Chrome tabs through a Chrome extension bridge.

## Commands

```bash
npm run dev
npm run build
npm run start
npm test
```

## Architecture

1. MCP server (`src/mcp.ts`)
2. WebSocket bridge (`src/ws-bridge.ts`)
3. Extension (`chrome-extension/`)

## Screenshot Return Modes

`chrome_screenshot` supports:

- `returnMode: "artifact"` (default)
  - writes screenshot to disk
  - returns path + metadata as text JSON
- `returnMode: "image"`
  - returns base64 image content

Default is artifact to avoid context bloat in CLI agents.

## Artifact Storage

Artifact utilities are in `src/artifacts.ts`.

- default cache dir is platform-specific
- `chrome_artifact_cleanup` removes old files

## Connection Model

- fixed default WS port `8766`
- secret validation disabled
- extension default WS URL `ws://localhost:8766`

## Environment Variables

- `MCP_CHROME_WS_HOST`
- `MCP_CHROME_WS_PORT`

When host is unset:

- WSL defaults to `0.0.0.0`
- non-WSL defaults to `127.0.0.1`

