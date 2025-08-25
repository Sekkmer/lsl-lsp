# LSL LSP

A Visual Studio Code extension providing rich support for LSL (Linden Scripting Language):

- Language Server features: diagnostics, hover, completion, go to definition, symbols, and semantic tokens.
- Preprocessor awareness: `#include`, `#if`/`#elif`/`#endif`, macros (including `__FILE__`, varargs), and disabled ranges.
- Formatter: full document, range, and on-type formatting.
- Syntax highlighting aligned with the server’s understanding.

## Features

- Contextual completions (state names, members like `.x/.y/.z/.s`, include paths)
- Macro navigation (including included macros)
- Semantic tokens (full and delta) for accurate coloring
- Robust diagnostics with suppression support
- Range and on-type formatting that respects disabled preprocessor blocks

## Configuration

- `lsl.definitionsPath`: Custom path to definitions JSON/YAML (bundled defaults if empty)
- `lsl.includePaths`: Additional search paths for `#include`
- `lsl.macros`: Project-wide predefined macros for conditionals
- `lsl.enableSemanticTokens`: Toggle semantic tokens
- `lsl.trace`: LSP protocol trace level (`off`, `messages`, `verbose`)

## Requirements

- VS Code ≥ 1.90.0
- Node.js ≥ 18 for the language server runtime

## How it works

The client bundles a TypeScript language server. On activation, it starts the server, provides the workspace settings, and wires up LSP features.

## Known limitations

- Preprocessing aims to be compatible with common LSL usage; report any edge cases.

## Release Notes

See [CHANGELOG](./CHANGELOG.md).

## License

MIT
