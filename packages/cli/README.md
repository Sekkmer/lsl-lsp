# LSL LSP CLI

Single-file command-line diagnostics, formatting, preprocessing, symbol, definition, and hover tool backed by `@lsl-lsp/core`.

The release bundle is `out/lsl-lsp.cjs`. It embeds the default LSL definitions; pass `--definitions <path>` to use a custom JSON/YAML definition file.

## Usage

```sh
lsl-lsp check [options] <file...>
lsl-lsp format [options] [--write|--check] <file...>
```

Examples:

```sh
lsl-lsp check script.lsl
lsl-lsp check -I includes -D DEBUG=1 --json script.lsl
lsl-lsp check --no-default-include -I includes script.lsl
lsl-lsp preprocess -I includes script.lsl
lsl-lsp preprocess --json -I includes script.lsl
lsl-lsp symbols script.lsl
lsl-lsp definition script.lsl 12 18
lsl-lsp hover script.lsl 13 9
lsl-lsp dump-defs llOwnerSay PI state_entry
lsl-lsp format --check script.lsl
lsl-lsp format --write script.lsl
```

Line and column arguments are 1-based.

Run `lsl-lsp --help` for all options.
