# LSL LSP

LSL (Linden Scripting Language) language tooling for VS Code.

## Repository Layout

- `packages/core/`: Reusable LSL preprocessing, parsing, analysis, diagnostics, hover, completions, signature help, semantic tokens, formatting, and navigation.
- `packages/cli/`: Single-file command-line diagnostics, formatting, preprocessing, symbol, definition, and hover tool backed by core.
- `packages/server/`: Language Server Protocol process that wires core analysis into VS Code/editor LSP requests.
- `packages/client-vscode/`: VS Code extension that bundles and starts the server.
- `third_party/lsl-definitions/`: Git submodule for the official [secondlife/lsl-definitions](https://github.com/secondlife/lsl-definitions) YAML used by the server, tests, and extension bundle.
- `common/`: Local schema and override metadata used while loading official definitions.

The runtime definition source is `third_party/lsl-definitions/lsl_definitions.yaml`. Core builds copy it to `packages/core/out/lsl_definitions.yaml`, server builds copy it to `packages/server/out/lsl_definitions.yaml`, and extension packaging includes the built server output.

## Requirements

- Node 22+
- pnpm
- Git submodules initialized with `git submodule update --init --recursive`

## Dev quickstart

- Install dependencies: `pnpm install`
- Build all: `pnpm build`
- Watch during dev: `pnpm watch`
- Lint: `pnpm lint`
- Format/lint fix: `pnpm lint:fix`
- Run core tests: `pnpm -C packages/core test`
- Run CLI diagnostics after build: `node packages/cli/out/lsl-lsp.cjs check path/to/script.lsl`
- Inspect preprocessing after build: `node packages/cli/out/lsl-lsp.cjs preprocess --json path/to/script.lsl`
- Inspect a symbol after build: `node packages/cli/out/lsl-lsp.cjs hover path/to/script.lsl 10 5`
- Build VS Code package: `pnpm -C packages/client-vscode package`

## Definitions

The server accepts official YAML definitions or the older JSON/YAML shape. If no custom path is configured, it resolves definitions from the built server output and then falls back to the official submodule. Definition metadata such as deprecated calls, god-mode requirements, must-use results, sleep/energy/experience flags, docs, links, and overrides is loaded into diagnostics and hovers where applicable.

## Release Notes

Release-facing notes live in [packages/client-vscode/CHANGELOG.md](packages/client-vscode/CHANGELOG.md).

## Notes

Developed with assistance from GPT-5.5 and GitHub Copilot in VS Code.
