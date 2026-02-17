# Repository Guidelines

## Project Structure & Module Organization
- `src/`: MCP server and bridge runtime (TypeScript).
  - `src/index.ts`: process entrypoint.
  - `src/mcp.ts`: MCP tool definitions and request handlers.
  - `src/ws-bridge.ts`: WebSocket bridge between MCP and extension.
  - `src/artifacts.ts`: screenshot artifact write/cleanup helpers.
- `chrome-extension/`: Chrome MV3 extension (service worker + offscreen page).
- `test/`: Node test suite (`*.test.js`) for parsers, bridge behavior, runtime config, and artifacts.
- `dist/`: compiled output from TypeScript build.

## Build, Test, and Development Commands
- `npm run dev`: run MCP server from source with `tsx`.
- `npm run build`: compile `src/**/*.ts` into `dist/` using `tsc`.
- `npm run start`: run compiled server from `dist/index.js`.
- `npm test`: run all tests with Node’s built-in test runner (`node --test`) via `tsx`.

Example local loop:
```bash
npm run build && npm test
```

## Coding Style & Naming Conventions
- Use 2-space indentation and semicolons; keep existing quote style in touched files.
- TypeScript in `src/` is strict (`tsconfig.json` has `"strict": true`); avoid `any`.
- Prefer explicit parser/helper names such as `parseXArgs`, `asBool`, `asNum`.
- MCP tool names follow `chrome_*` pattern (for example, `chrome_open_url`, `chrome_screenshot`).
- Keep extension wrappers prefixed with `p` for promisified Chrome APIs (for example, `pTabsQuery`).

## Testing Guidelines
- Framework: Node test runner (`node:test`) with `assert/strict`.
- Place tests under `test/` and name files `*.test.js`.
- Add/adjust tests when changing:
  - argument parsing in `src/mcp.ts`
  - bridge messaging in `src/ws-bridge.ts`
  - artifact behavior in `src/artifacts.ts`
- Run `npm test` before opening a PR; all tests must pass.

## Commit & Pull Request Guidelines
- Existing history uses short, descriptive subjects (for example, `Initial Chrome Live Screenshot MCP`).
- Keep commit titles concise and imperative; one logical change per commit.
- PRs should include:
  - purpose and behavior change summary,
  - impacted tools/APIs (MCP tool names and input/output shape),
  - test evidence (`npm test` output),
  - screenshots/gifs when extension UI (`popup/options`) changes.

## Security & Configuration Tips
- Do not commit machine-specific MCP config (`.mcp.json`); use `.mcp.example.json` as template.
- Keep WS endpoint explicit (`ws://localhost:8766` by default) and verify extension connectivity before debugging tool failures.
