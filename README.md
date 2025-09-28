# LSL Language Server + VS Code Extension

A monorepo for LSL (Linden Scripting Language) tooling:
- A language server with parsing, diagnostics, hovers, signature help, semantic tokens, and navigation.
- A VS Code client extension that wires the server into the editor.
- Tooling that copies the official [secondlife/lsl-definitions](https://github.com/secondlife/lsl-definitions) YAML into the bundles consumed by the server/tests (the legacy crawler still lives in `crawler/`).

## Workspaces
- `server/` – Language Server (TypeScript, LSP). Emits diagnostics like arity/type/state checks and provides editor features.
- `client-vscode/` – VS Code extension that starts the server and contributes language configuration + grammar.
- `crawler/` – Historical wiki scraper. Most pipelines now rely on the upstream YAML directly, but the crawler is retained for diagnostics and one-off data pulls.
- `third_party/lsl-definitions/` – Git submodule pointing at the official LSL definitions repository.

Shared assets live in `common/` (e.g., `lsl_definitions.yaml` + schema) and are consumed by the server and tests.

## Dev quickstart
- Build all: `pnpm build`
- Watch during dev: `pnpm watch`
- Lint/format (tabs): `pnpm lint:fix`
- Run server tests: `pnpm -C server test`
- (Re)build shared definitions bundle: `pnpm defs:build`

### Definitions data flow

1. Initialise submodules after cloning: `git submodule update --init --recursive`.
2. Run `pnpm defs:build` to copy the upstream YAML into `common/` and the VS Code client's bundle.
3. Server + extension builds automatically bundle the copied YAML.

Requirements: Node 22+, pnpm.

## Notes
This repo was vibe-coded with GPT-5 using GitHub Copilot in VS Code.
