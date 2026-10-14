# LSL LSP

Write and check Second Life LSL scripts in VS Code or from the command line. LSL LSP provides code completion, diagnostics, navigation, formatting, preprocessing, and optimized script output from the same analyzer.

For the editor extension, see the [VS Code guide](packages/client-vscode/README.md). For automated checks and generated scripts, see the [CLI guide](packages/cli/README.md). The experimental [linkset simulator](packages/simulator/README.md) runs cooperating scripts in local integration tests.

## Getting started

Install **LSL LSP** by **Sekkmer** in VS Code, then open an `.lsl` file. The extension also recognizes `.lslp`, `.lsli`, and `.lslh` files. It includes Second Life function, event, and constant definitions; no separate language server installation is needed.

The command palette includes:

- **LSL: Open Preprocessed Script** — inspect expanded includes and macros.
- **LSL: Open Optimized Script** — review generated output beside your source.
- **LSL: Open Firestorm Original Source** — recover source embedded in a compatible preprocessor header.

Generated editor tabs are read-only. Keep the editable source in your project and use generated output when uploading a script.

## Command-line use

The CLI is distributed as a single `lsl-lsp.cjs` file with bundled definitions. It can be downloaded from [GitHub releases](https://github.com/Sekkmer/lsl-lsp/releases) or built from this repository.

```sh
node lsl-lsp.cjs check script.lsl
node lsl-lsp.cjs preprocess -I includes script.lsl
node lsl-lsp.cjs measure --compare-optimized script.lsl
node lsl-lsp.cjs optimize script.lsl
```

`optimize` prints output by default. Add `--write` to replace input files, or `--check` to report whether they would change. Parsing, preprocessing, and semantic errors must be fixed before optimization; an invalid script prevents writes for the whole batch.

## Using a coding agent

An agent can start with `node lsl-lsp.cjs --help`, then run `check --json`, `preprocess`, and `measure --json --compare-optimized` against the project's scripts. Match its include paths and defines before interpreting the results. No MCP server is needed.

The optional [LSL tooling skill](.agents/skills/lsl-lsp/SKILL.md) explains this workflow. Codex discovers it in this repository's `.agents/skills`; copy the `lsl-lsp` skill folder to another project's `.agents/skills` to use it there. For Claude Code, copy the same folder to `.claude/skills`. No global installation or configuration is required. See the [Codex skill guide](https://learn.chatgpt.com/docs/build-skills) and [Claude Code skill guide](https://code.claude.com/docs/en/skills) for skill discovery details.

## Optimization and memory estimates

The optimizer folds constants, removes unused functions, simplifies expressions, shortens names, and inlines suitable helpers. It evaluates inlining against the Mono memory estimate; call depth can break a tie when compact output does not grow. These changes preserve LSL evaluation order and rename inlined parameters, locals, and labels to avoid collisions.

`measure` and the editor's memory hints estimate static Mono memory use using calibration from Second Life probes. They also report reachable recursion and the deepest static user-function call chain. For recursive components, the reported depth counts each function once and is a static upper bound for that summary, not a bound on runtime recursion.

Growing lists, strings, or queues can use an explicit budget in the root source:

```lsl
// lsl-memory-reserve: 8192 bytes
```

The reserve is added equally to source and optimized estimates. Used memory is capped at the script limit and free memory at zero, so comparisons lose meaning after saturation. The estimate does not model peak stack use, temporary copies, garbage collection, or actual runtime heap growth. Use Second Life measurements for release-critical memory margins; smaller startup estimates alone cannot establish that a script will avoid stack/heap collisions.

## Building and contributing

Use Node.js 22+ and pnpm. Initialize the definitions submodule before building:

```sh
git submodule update --init --recursive
pnpm install
pnpm build
pnpm test
pnpm lint
```

Run the built CLI with `node packages/cli/out/lsl-lsp.cjs`. Use `pnpm watch` while developing or `pnpm -C packages/client-vscode package` to create a VSIX.

| Directory | Purpose |
| --- | --- |
| `packages/core` | Shared preprocessing, parsing, analysis, editor features, optimization, and measurement |
| `packages/cli` | Standalone command-line bundle |
| `packages/server` | Language Server Protocol process |
| `packages/client-vscode` | VS Code client and extension package |
| `packages/simulator` | Experimental deterministic LSL integration-test runtime |
| `third_party/lsl-definitions` | Official [Second Life definitions](https://github.com/secondlife/lsl-definitions) submodule |
| `common` | Definition schema and local metadata overrides |

The core and server builds copy `third_party/lsl-definitions/lsl_definitions.yaml` into their output; the CLI embeds it, and the extension packages the built server. Definition updates are validated before use. VS Code checks for updates by default; the CLI uses bundled definitions unless you opt into its update cache.

For an LSL behavior change, add a focused regression and confirm uncertain semantics against Second Life. Local probe scripts and captured evidence belong in ignored `.local` directories; portable, original test fixtures belong with the package tests.

Release notes live in [CHANGELOG.md](packages/client-vscode/CHANGELOG.md). The project is licensed under [MIT](LICENSE).
