# LSL LSP CLI

Check LSL scripts, expand includes and macros, format source, and generate optimized output without an editor. The CLI uses the same analyzer as the VS Code extension.

Download `lsl-lsp.cjs` from [GitHub releases](https://github.com/Sekkmer/lsl-lsp/releases), or build it from the repository with `pnpm build`. It is a single Node.js bundle with LSL definitions included.

```sh
node lsl-lsp.cjs check script.lsl
# From a repository checkout after building:
node packages/cli/out/lsl-lsp.cjs check script.lsl
```

The examples below use `lsl-lsp` as shorthand for running that bundle.

## Common workflows

```sh
lsl-lsp check script.lsl
lsl-lsp check -I includes -D DEBUG=1 --json script.lsl
lsl-lsp format --check script.lsl
lsl-lsp format --write script.lsl
lsl-lsp preprocess -I includes script.lsl
lsl-lsp measure --compare-optimized script.lsl
lsl-lsp optimize script.lsl
lsl-lsp optimize --check script.lsl
lsl-lsp optimize --write script.lsl
```

`format` and `optimize` print one script by default. `--write` replaces files; `--check` exits with status 1 if a file would change. Formatting multiple files requires `--write` or `--check`; optimization also accepts `--json` for a batch. Optimization refuses scripts with preprocessing, parsing, or semantic errors before writing anything in the batch. Diagnostics suppressed for display still prevent invalid source from being optimized.

## Commands

| Command | Output |
| --- | --- |
| `check <file...>` | Diagnostics; exits with status 1 for any reported diagnostic, including warnings and information |
| `format <file...>` | Formatted source, or a write/check result |
| `preprocess <file...>` | Source with includes and macros expanded |
| `optimize <file...>` | Optimized standard LSL, or a write/check result |
| `measure <file...>` | Static Mono memory estimate and user-function call graph |
| `symbols <file...>` | Document symbols |
| `definition <file> <line> <column>` | Definition location |
| `hover <file> <line> <column>` | Symbol documentation |
| `dump-defs [name...]` | Bundled function, event, and constant metadata as JSON |
| `update-defs` | Download and validate official definitions into the CLI cache |

Line and column arguments are 1-based. Use `--json` with commands that support structured output. Run `lsl-lsp --help` for the full option list.

## Includes, macros, and dialect extensions

```sh
lsl-lsp check -I includes -I shared -D DEBUG=1 script.lsl
lsl-lsp check --no-default-include -I includes script.lsl
lsl-lsp optimize --dynamic-macro __AGENTID__:string script.lsl
lsl-lsp optimize --enable-extension switch script.lsl
```

The current working directory is an include search path by default. Quoted includes first search the including file's directory; `-I` adds more paths. Use `--no-default-include` for a controlled search path.

`--dynamic-macro name:type` preserves a macro whose value is only known at runtime, while giving the analyzer its type. Repeat the option for multiple macros.

The optional `switch`, `lazy-lists`, and `const-globals` extensions are disabled by default. Enable them with `--enable-extension`, or use a source directive such as `// lsl-lsp extensions: switch`. Optimized output lowers these extensions to standard LSL. `preprocess` expands includes and macros; it preserves dialect syntax.

For a Firestorm-compatible header containing the original source:

```sh
lsl-lsp optimize --firestorm-header script.lsl
lsl-lsp preprocess --firestorm-header -I includes script.lsl
lsl-lsp preprocess --decode-firestorm-header preprocessed.lsl
```

## Reading memory estimates

```sh
lsl-lsp measure --json --compare-optimized script.lsl
```

The estimate is calibrated from Second Life Mono probes. Use it to compare source changes, then verify important memory margins in Second Life. It does not simulate peak stack use, temporary copies, garbage collection, or runtime growth.

The call graph reports the deepest reachable user-function chain. Recursive components count each function once in the reported static upper bound; actual recursive depth depends on runtime input. The optimizer may inline helpers when estimated memory improves, or use lower call depth to break a tie when compact output does not grow.

Add `// lsl-memory-reserve: 8192 bytes` to the root source to budget for bounded lists, strings, or session data. The same reserve applies to both source and optimized costs. Used/free estimates are capped at the script limit/zero, so deltas lose meaning after saturation.

## Definition updates

The default definitions are bundled and need no network access. Use `--definitions path/to/definitions.yaml` for a custom JSON/YAML file, or opt into the official update cache:

```sh
lsl-lsp update-defs
lsl-lsp check --auto-update-defs script.lsl
lsl-lsp dump-defs llOwnerSay PI state_entry
```

`--definitions-cache`, `--definitions-url`, and `--force-definition-update` control the cache location and update request. Custom definitions take precedence over the cache.

## Testing a group of scripts

The CLI checks and generates individual scripts; it does not execute a virtual world. For integration tests involving linked prims, multiple objects, attachments, chat, or linkset data, use the separate experimental [simulator library](../simulator/README.md).

Download the separate `lsl-simulator.cjs` library from [GitHub releases](https://github.com/Sekkmer/lsl-lsp/releases) to use it directly from JavaScript/TypeScript tests. Its definitions are embedded; no workspace dependencies are required. A source map, type declarations, and license notices accompany the bundle.

The [message-world example](../simulator/examples/message-world) includes the required object/prim/script directories and a runnable JavaScript test. From the repository root after `pnpm build`:

```sh
node packages/simulator/examples/message-world/run.cjs
```

There is currently no `lsl-lsp simulate` command, and the simulator is not included in the standalone CLI release bundle.
