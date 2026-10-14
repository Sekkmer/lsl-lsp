# LSL LSP

Language tooling for Second Life LSL: a VS Code extension, a standalone CLI, and an experimental simulator for cooperating scripts. The editor and CLI share the analyzer for diagnostics, navigation, formatting, preprocessing, and optimized script output.

For the editor extension, see the [VS Code guide](packages/client-vscode/README.md). For automated checks and generated scripts, see the [CLI guide](packages/cli/README.md). The experimental [linkset simulator](packages/simulator/README.md) runs cooperating scripts in local integration tests.

## VS Code extension

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

## Testing linked scripts and multiple objects

The experimental simulator runs LSL scripts in a shared local world. Use it to test linked messages between prims, chat between separate objects, shared linkset data, and script start/stop/reset behavior. It is a JavaScript/TypeScript library with a separate standalone release bundle; the CLI does not contain a `simulate` command.

Download `lsl-simulator.cjs` from [GitHub releases](https://github.com/Sekkmer/lsl-lsp/releases) and import it with `require('./lsl-simulator.cjs')`. LSL definitions are embedded, so only Node.js 22+ and your fixture files are needed. The matching `.cjs.map`, `.d.cts`, and license notices are available alongside it. Branch builds provide the same files in the `lsl-lsp-simulator` Actions artifact.

Each object has its own inventory-shaped directory. A world can contain several of these objects, including attachments and rezzed objects:

```text
message-world/
  run.cjs
  attachment/linkset/
    linkset.json              # owner and attached: true
    prims/
      root/prim.json          # link 1
      root/scripts/bridge.lsl
      worker/prim.json        # link 2
      worker/scripts/worker.lsl
  panel/linkset/
    linkset.json              # same owner, attached: false
    prims/root/
      prim.json               # link 1 in this separate object
      scripts/panel.lsl
```

Load each object with `loadLinksetProject(path, { world })` into the same `SimulatorWorld`, then start the world and inject events. `attached` and `owner` are explicit fixture settings; directory names do not determine them. Each object has its own link numbers and linkset data.

The [simulator guide](packages/simulator/README.md) covers the full file format, defaults, multiple-object setup, virtual time, and limitations. The [runnable message-world example](packages/simulator/examples/message-world) sends a request from a rezzed panel to an attachment, routes it to a child prim, and checks the reply. From a built checkout:

```sh
node packages/simulator/examples/message-world/run.cjs
```

Simulation checks supported script behavior; actual SL remains necessary for viewer behavior, physics, and runtime memory measurements.

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
