# LSL LSP

LSL (Linden Scripting Language) language tooling for VS Code.

## Repository Layout

- `packages/core/`: Reusable LSL preprocessing, parsing, analysis, diagnostics, hover, completions, signature help, semantic tokens, formatting, optimization, and navigation.
- `packages/cli/`: Standalone command-line diagnostics, formatting, preprocessing, optimization, symbol, definition, hover, definition-update, and definition-dump tool backed by core.
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
- Estimate AST/Mono memory shape after build: `node packages/cli/out/lsl-lsp.cjs measure --compare-optimized path/to/script.lsl`
- Optimize a script after build: `node packages/cli/out/lsl-lsp.cjs optimize path/to/script.lsl`
- Check whether optimizer output would change a script: `node packages/cli/out/lsl-lsp.cjs optimize --check path/to/script.lsl`
- Write optimizer output in place: `node packages/cli/out/lsl-lsp.cjs optimize --write path/to/script.lsl`
- Preserve typed dynamic macros in analysis/optimization: `node packages/cli/out/lsl-lsp.cjs optimize --dynamic-macro __AGENTID__:string path/to/script.lsl`
- Inspect a symbol after build: `node packages/cli/out/lsl-lsp.cjs hover path/to/script.lsl 10 5`
- Dump bundled definitions after build: `node packages/cli/out/lsl-lsp.cjs dump-defs llOwnerSay`
- Update the CLI definition cache: `node packages/cli/out/lsl-lsp.cjs update-defs`
- Build VS Code package: `pnpm -C packages/client-vscode package`

VS Code exposes generated-output commands in the command palette:

- `LSL: Open Preprocessed Script`
- `LSL: Open Optimized Script`

The optimizer is intended for generated review output first: VS Code opens a read-only optimized copy beside the source file, and the CLI writes only when `--write` is provided. Optimizer feature flags are enabled by default and can be disabled individually through the VS Code `lsl.optimize` setting. The `measure` command and VS Code memory inlay hints are static estimates calibrated from SL Mono probes; SL-side `.test` probe results remain the source of truth for release-critical memory margins.

## Definitions

The server accepts official YAML definitions or the older JSON/YAML shape. If no custom path is configured, VS Code can download validated official definition updates into extension global storage and otherwise resolves definitions from the built server output and the official submodule fallback. The CLI embeds bundled definitions by default; use `update-defs` or `--auto-update-defs` to opt into an OS cache. Definition metadata such as deprecated calls, god-mode requirements, must-use results, sleep/energy/experience flags, docs, links, and overrides is loaded into diagnostics and hovers where applicable.

## Release Notes

Release-facing notes live in [packages/client-vscode/CHANGELOG.md](packages/client-vscode/CHANGELOG.md).

## Notes

Developed with assistance from GPT-5.5 and GitHub Copilot in VS Code.
