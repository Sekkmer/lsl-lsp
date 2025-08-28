# LSL LSP

 A Visual Studio Code extension providing rich support for LSL (Linden Scripting Language):

- Language Server features: diagnostics, hover, completion, go to definition, find all references, rename symbol, document symbols, and semantic tokens.
- Preprocessor awareness: `#include`, `#if`/`#elif`/`#endif`, macros (including built-ins like `__FILE__` and varargs), and disabled ranges.
- Formatter: full document, range, and on-type formatting.
- Syntax highlighting (semantic tokens) aligned with the parser’s understanding.

## Features

- Type‑aware completions
	- Learns from your code: variables, parameters, and return types
	- Contextual hints for state names and member access (e.g., `.x/.y/.z/.s`)
	- `#include` path suggestions from configured include paths
- Rich hovers with documentation
	- Functions and events show signatures, parameter docs, and a direct "Wiki" link
	- Constants show inferred value (with hex for integers) and docs
	- Includes show resolution info and a summary of available symbols
- Navigation
	- Go to definition for functions, variables, and macros (object‑like and function‑like)
	- Find all references (scope‑aware and include‑aware)
	- Rename symbol (scope/shadow aware, works across includes when uniquely resolvable)
	- Document symbols for quick outline
- Preprocessor support
	- `#include`, conditional compilation, macros (including `__FILE__`, varargs)
	- Diagnostics for common preprocessor issues and disabled code ranges
	- Works across included files; external symbols are indexed for hover/defs
- Formatting
	- Full document, range, and on‑type formatting
	- Respects disabled preprocessor blocks
	- Consistent brace/semicolon/newline handling
- Diagnostics (server‑side analysis)
	- Common LSL issues such as arity/return mismatches, unused/duplicate declarations, dead code, and operator/semicolon problems
	- Diagnostics can be selectively suppressed where needed
	- Includes checks for invalid state declarations/changes and for empty event/function bodies or empty if/else branches
	- Advisory for list equality/inequality: `list == list` compares only length in LSL (and `!=` yields a length difference). A hint is shown when comparing two non‑empty lists; comparisons to `[]` are treated as emptiness checks and not flagged.
- Semantic tokens
	- Accurate coloring driven by the language server (full and delta updates)
	- Readonly and modification modifiers for variables/parameters when applicable

## Configuration

- `lsl.definitionsPath`: Custom path to definitions JSON/YAML (bundled defaults if empty)
- `lsl.includePaths`: Additional search paths for `#include`
- `lsl.macros`: Project-wide predefined macros for conditionals
- `lsl.enableSemanticTokens`: Toggle semantic tokens
- `lsl.trace`: LSP protocol trace level (`off`, `messages`, `verbose`)

### Customize readonly colors (semantic tokens)

The server marks parameters as readonly and variables as readonly when they’re effectively immutable. Whether this shows as a different color depends on your theme. You can enforce or tweak colors via VS Code settings:

Workspace or User Settings (JSON):

```
{
	"editor.semanticHighlighting.enabled": true,
	"editor.semanticTokenColorCustomizations": {
		"enabled": true,
		"rules": {
			// Darken readonly variables and parameters
			"variable.readonly": { "foreground": "#4FC1FF" },
			"parameter.readonly": { "foreground": "#4FC1FF" }
		}
	}
}
```

Notes:
- Themes may override semantic tokens. If your theme doesn’t pick up these rules, set:

```
{
	"editor.semanticTokenColorCustomizations": {
		"allSemanticTokens": true,
		"rules": { /* as above */ }
	}
}
```
- The examples above use a darker gray for readonly variables and the Default Dark+ blue for readonly parameters. Adjust to taste.

## Requirements

- VS Code ≥ 1.90.0
- Node.js ≥ 18 for the language server runtime

## How it works

The client bundles a TypeScript language server. On activation, it starts the server, provides the workspace settings, and wires up LSP features, including scope‑aware rename and references.

Data powering function/event/constant docs is built from a merged dataset:
- Second Life Viewer LLSD (keywords_lsl_default.xml): signatures, parameter names, return types
- SL Wiki pages: human‑friendly descriptions and wiki links for quick reference

Hovers display a "Wiki" link when available; a sensible fallback link is provided otherwise.

## Known limitations

- Preprocessing aims to be compatible with common LSL usage; report any edge cases.
- Rename does not refactor strings or comments; only identifiers.
- Rename for include‑defined symbols occurs when a unique definition is found in indexed includes; ambiguous names are intentionally blocked.
- Macro rename works for the current file and indexed includes, but cannot follow unindexed or generated headers.

## Release Notes

See [CHANGELOG](./CHANGELOG.md).

## Repository

- GitHub: https://github.com/Sekkmer/lsl-lsp

## License

MIT
