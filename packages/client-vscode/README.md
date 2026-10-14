# LSL LSP

LSL language support for Visual Studio Code. Get completion, documentation, diagnostics, formatting, and navigation while writing scripts for Second Life.

## Start writing

Install **LSL LSP** by **Sekkmer**, then open an `.lsl` file. The extension also recognizes `.lslp`, `.lsli`, and `.lslh` files. It includes Second Life's function, event, and constant definitions and starts its language server automatically.

Hover over `llOwnerSay` or another built-in to see its signature, documentation, and wiki link. Use **Go to Definition**, **Find All References**, or **Rename Symbol** for your own code. Format a document with VS Code's **Format Document** command.

Requires VS Code 1.90 or newer.

## Working with includes and macros

The extension understands `#include`, `#define`, conditional compilation, and common preprocessor features such as stringification, token pasting, and variadic macros. Completion also suggests include paths.

Quoted includes search the current file's directory first, followed by configured include paths and workspace folders. A project's `.vscode/settings.json` can contain:

```json
{
  "lsl.includePaths": ["includes", "shared"],
  "lsl.macros": { "DEBUG": 1 },
  "lsl.dynamicMacros": ["__AGENTID__:string"]
}
```

Dynamic macros remain in generated output with an unknown value and a known type. Use them for values that a viewer or another build step supplies later.

Optional dialect extensions are disabled by default. Enable them in settings, or in source with a directive such as `// lsl-lsp extensions: switch`:

```json
{
  "lsl.extensions": {
    "switch": true,
    "lazyLists": true,
    "constGlobalExpressions": true
  }
}
```

Optimized output converts these extensions to standard LSL before upload. Preprocessed output expands includes and macros but preserves dialect syntax.

## Inspect generated scripts

Open the command palette or right-click an LSL editor:

- **LSL: Open Preprocessed Script** expands includes and macros.
- **LSL: Open Optimized Script** opens optimized output beside the source.
- **LSL: Open Firestorm Original Source** recovers source embedded in a compatible preprocessor header.

These commands open read-only tabs and keep the source file editable. Optimization requires valid source; fix preprocessing, parsing, and semantic errors first. Set `lsl.output.firestormHeaderForOptimized` to `true` to embed the original source in optimized output.

All optimizer features are enabled by default. Individual features can be disabled through `lsl.optimize`, for example:

```json
{
  "lsl.optimize": { "inlineFunctions": false, "shrinkNames": false }
}
```

## Diagnostics and memory hints

Diagnostics check types, function arguments and returns, declarations, state changes, unreachable code, and common LSL mistakes. Hovers also show definition metadata such as deprecated functions, required privileges, and built-in delays when available. Documentation comments immediately above your own functions appear in their hovers.

Suppress a diagnostic by its friendly name or `LSL###` code:

```lsl
// lsl-disable-next-line unused-param
handleMessage(string message) { }

// lsl-disable dead-code
// ...
// lsl-enable
```

`lsl-disable-line` applies to its own line. Omitting the code list suppresses all diagnostics in that scope. To suppress selected diagnostics throughout the workspace:

```json
{
  "lsl.diagnostics.disable": ["wrong-arity", "unused-param"]
}
```

Memory inlay hints compare estimated source and optimized Mono free memory and show a calibrated error band. They are estimates, not live script measurements. Runtime lists, temporary copies, call stacks, and garbage collection can change the actual margin. A root-source comment such as `// lsl-memory-reserve: 8192 bytes` adds a fixed runtime budget to both estimates. Verify tight scripts in Second Life. Hide the hints with `"lsl.measure.inlayHints": false`.

## Definitions and troubleshooting

The extension uses bundled official [Second Life definitions](https://github.com/secondlife/lsl-definitions) and checks for validated updates by default. Use **LSL: Update Definitions**, **LSL: Show Active Definitions**, or **LSL: Use Bundled Definitions** to inspect or change that choice. Set `lsl.definitions.autoUpdate` to `false` to disable update checks, or set `lsl.definitionsPath` to a custom JSON/YAML file.

If results appear stale, try **LSL: Clear Caches** or **LSL: Restart Language Server**. **LSL: Show Client Logs** and **LSL: Show Language Server Trace** open the relevant output channels. Set `lsl.trace` to `messages` or `verbose` when diagnosing protocol issues.

Semantic highlighting depends on your theme and can be disabled with `lsl.enableSemanticTokens`. Readonly parameters and variables use semantic token modifiers, which themes may style differently.

## Limitations and feedback

The analyzer does not replace the Second Life compiler or test viewer behavior. Rename changes identifiers rather than strings or comments; ambiguous include definitions and unindexed headers can limit cross-file renames. Preprocessor and dialect compatibility can also differ from a particular viewer's implementation.

Report issues with a small script that reproduces the problem at [Sekkmer/lsl-lsp](https://github.com/Sekkmer/lsl-lsp).

## CLI and script integration tests

The project also provides tools outside the editor:

- The [standalone CLI](https://github.com/Sekkmer/lsl-lsp/tree/master/packages/cli) checks, formats, preprocesses, optimizes, and estimates memory from the terminal. Download its single Node.js bundle from [GitHub releases](https://github.com/Sekkmer/lsl-lsp/releases).
- The experimental [linkset simulator](https://github.com/Sekkmer/lsl-lsp/tree/master/packages/simulator) tests cooperating scripts in a local virtual world. Fixtures describe separate objects, linked prims, script inventory, owners, and attachment state. The [message-world example](https://github.com/Sekkmer/lsl-lsp/tree/master/packages/simulator/examples/message-world) demonstrates a rezzed controller communicating with a two-prim attachment.

The simulator is a JavaScript/TypeScript library in the source checkout. It is not an editor command or part of the CLI bundle, and it does not simulate viewer RLV behavior, physics, or heap/stack memory.

Licensed under MIT. See [release notes](CHANGELOG.md) for changes.
