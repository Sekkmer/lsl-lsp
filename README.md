# LSL Language Server + VS Code Extension

A monorepo for LSL (Linden Scripting Language) tooling:
- A language server with parsing, diagnostics, hovers, signature help, semantic tokens, and navigation.
- A VS Code client extension that wires the server into the editor.
- Tooling that copies the official [secondlife/lsl-definitions](https://github.com/secondlife/lsl-definitions) YAML into the bundles consumed by the server/tests.

## Workspaces
- `server/` – Language Server (TypeScript, LSP). Emits diagnostics like arity/type/state checks and provides editor features.
- `client-vscode/` – VS Code extension that starts the server and contributes language configuration + grammar.
- `third_party/lsl-definitions/` – Git submodule pointing at the official LSL definitions repository.

Local schemas and override metadata live in `common/`. Runtime LSL definitions come from the upstream `third_party/lsl-definitions/lsl_definitions.yaml` submodule.

## Dev quickstart
- Build all: `pnpm build`
- Watch during dev: `pnpm watch`
- Lint/format (tabs): `pnpm lint:fix`
- Run server tests: `pnpm -C server test`

### Definitions data flow

1. Initialise submodules after cloning: `git submodule update --init --recursive`.
2. Server builds copy the upstream YAML into `server/out/`; extension packaging bundles the built server output.

Requirements: Node 22+, pnpm.

## Notes
This repo was vibe-coded with GPT-5 using GitHub Copilot in VS Code.
