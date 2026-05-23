# LSL LSP

LSL (Linden Scripting Language) language tooling for VS Code.

## Repository Layout

- `packages/server/`: TypeScript language server with preprocessing, parsing, analysis, diagnostics, hover, completions, signature help, semantic tokens, formatting, and navigation.
- `packages/client-vscode/`: VS Code extension that bundles and starts the server.
- `third_party/lsl-definitions/`: Git submodule for the official [secondlife/lsl-definitions](https://github.com/secondlife/lsl-definitions) YAML used by the server, tests, and extension bundle.
- `common/`: Local schema and override metadata used while loading official definitions.

The runtime definition source is `third_party/lsl-definitions/lsl_definitions.yaml`. Server builds copy it to `packages/server/out/lsl_definitions.yaml`; extension packaging includes the built server output.

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
- Run server tests: `pnpm -C packages/server test`
- Build VS Code package: `pnpm -C packages/client-vscode package`

## Definitions

The server accepts official YAML definitions or the older JSON/YAML shape. If no custom path is configured, it resolves definitions from the built server output and then falls back to the official submodule. Definition metadata such as deprecated calls, god-mode requirements, must-use results, sleep/energy/experience flags, docs, links, and overrides is loaded into diagnostics and hovers where applicable.

## Release Notes

Release-facing notes live in [packages/client-vscode/CHANGELOG.md](packages/client-vscode/CHANGELOG.md).

## Notes

Developed with assistance from GPT-5.5 and GitHub Copilot in VS Code.
