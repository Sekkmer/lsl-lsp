---
name: lsl-lsp
description: Check, preprocess, and optimize Second Life LSL scripts with the lsl-lsp CLI. Use when developing LSL or investigating generated LSL behavior and memory usage.
---

# LSL tooling

Use the existing CLI for diagnostics and generated output. It works without an
editor, an MCP server, credentials, or a running viewer.

## Find the tool and match the project

Use `lsl-lsp --help` if the executable is on PATH. Otherwise run
`node /path/to/lsl-lsp/packages/cli/out/lsl-lsp.cjs --help` from a built checkout.
To build that checkout, use `pnpm --filter @lsl-lsp/core build` followed by
`pnpm --filter @lsl-lsp/cli build`. Do not install a global tool just to run it.

Match the project's include paths, defines, dynamic macros, and enabled
extensions. A standalone script and its preprocessed build can have different
diagnostics. Relevant options are `-I`, `-D`, `--dynamic-macro name:type`, and
`--enable-extension`; discover exact syntax through `--help`.

## Check and generate

For a script under development:

```sh
lsl-lsp check --json path/to/script.lsl
lsl-lsp preprocess path/to/script.lsl
lsl-lsp measure --json --compare-optimized path/to/script.lsl
lsl-lsp optimize --json path/to/script.lsl
```

Resolve errors before relying on generated output. Warnings are not necessarily
compiler failures: for example, LSL list comparisons compare lengths, and the
tool warns when code appears to expect content equality.

Keep readable source and generated output separate unless the user requests
in-place generation. `optimize` prints output by default; `--write` replaces
inputs. `--firestorm-header` can carry original source inside generated output
for Firestorm; `--decode-firestorm-header` recovers it.

Use `dump-defs`, `hover`, and `definition` when a builtin signature or symbol
resolution is unclear. Bundled definitions keep ordinary runs offline;
`update-defs` or `--auto-update-defs` explicitly enables a network refresh.

## Interpret validation correctly

`measure` estimates static/startup Mono memory. It does not measure live heap,
garbage collection, event queues, or actual call-frame allocation. Call depth
describes a static graph; recursion remains input-dependent. A declared
`// lsl-memory-reserve: 8192 bytes` subtracts that allowance from both source
and optimized estimates; it does not prove that runtime growth stays bounded.

For changes depending on LSL execution semantics, compare original and generated
observable results in Second Life when an authorized test setup is available.
Keep local IPC configuration, probe scripts, and raw evidence in an ignored
`.local/` directory. Do not treat a simulator or static estimate as proof of
viewer behavior, no-script parcel behavior, timing, or heap safety.

The optional simulator can test cooperating scripts with deterministic events
and virtual time. Use the `@lsl-lsp/simulator` workspace package or import the
standalone `lsl-simulator.cjs` release bundle, which embeds its definitions.
It is experimental and supports a subset of LSL; unsupported behavior should
surface as an error. Use small independent fixtures rather than importing
application-specific frameworks.

Report which inputs/options were checked, what changed, and which observations
come from static checks, simulation, or actual SL execution.
