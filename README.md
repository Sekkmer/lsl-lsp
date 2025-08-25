# LSL Language Server + VS Code Extension

A monorepo for LSL (Linden Scripting Language) tooling:
- A language server with parsing, diagnostics, hovers, signature help, semantic tokens, and navigation.
- A VS Code client extension that wires the server into the editor.
- A crawler that collects and normalizes LSL definitions (functions, events, constants) into a shared JSON file.

## Workspaces
- `server/` – Language Server (TypeScript, LSP). Emits diagnostics like arity/type/state checks and provides editor features.
- `client-vscode/` – VS Code extension that starts the server and contributes language configuration + grammar.
- `crawler/` – CLI scraper that builds the canonical `common/lsl-defs.json` used by the server and tests.

Shared assets live in `common/` (e.g., `lsl-defs.json` + schema) and are consumed by the server and tests.

## Dev quickstart
- Build all: `pnpm build`
- Watch during dev: `pnpm watch`
- Lint/format (tabs): `pnpm lint:fix`
- Run server tests: `pnpm -C server test`

Requirements: Node 22+, pnpm.

## Notes
This repo was vibe-coded with GPT-5 using GitHub Copilot in VS Code.
