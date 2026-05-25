# LSL LSP

A Visual Studio Code extension providing rich, AST‑based support for LSL (Linden Scripting Language):

- Language Server features: diagnostics, hover, completion, go to definition, find all references, rename symbol, document symbols, and semantic tokens.
- Preprocessor awareness: `#include`, `#if`/`#elif`/`#endif`, macros (built‑ins like `__LINE__`, `__FILE__`, `__DATE__`, `__TIME__`, varargs with `__VA_ARGS__`/`__VA_OPT__`, `#` stringification and `##` token pasting), and disabled ranges.
- Formatter: full document, range, and on-type formatting.
- Syntax highlighting and semantic tokens aligned with the parser’s understanding.
- A shared core analyzer also powers the repository's standalone `lsl-lsp` CLI for non-VS Code workflows.

## Features

- Type‑aware completions
	- Learns from your code: variables, parameters, and return types
	- Contextual hints for state names and member access (e.g., `.x/.y/.z/.s`)
	- `#include` path suggestions from workspace folder(s) and configured include paths
- Rich hovers with documentation
	- Functions and events show signatures, parameter docs, and a direct "Wiki" link
	- Deprecated calls, god-mode requirements, sleep/energy/experience metadata, and must-use return values are surfaced from the bundled definitions when available
	- User‑defined functions show JSDoc‑style comments (`/** ... */`) placed immediately above the declaration
	- Constants show inferred value (with hex for integers) and docs
	- Includes show resolution info and a summary of available symbols
- Navigation
	- Go to definition for functions, variables, and macros (object‑like and function‑like)
	- Find all references (scope‑aware and include‑aware)
	- Rename symbol (scope/shadow aware, works across includes when uniquely resolvable)
	- Document symbols for quick outline
- Preprocessor support
	- `#include`, conditional compilation, and macros
	- Built‑ins: `__LINE__`, `__FILE__`, `__DATE__`, `__TIME__`
	- Varargs: `__VA_ARGS__` and `__VA_OPT__`
	- Operators: `#` (stringify) and `##` (token pasting)
	- Configurable typed dynamic macros, such as Firestorm runtime values that should be preserved instead of expanded
	- Commands to open generated preprocessed and optimized script output in read-only editor tabs
	- Diagnostics for common preprocessor issues and disabled code ranges
	- Works across included files; external symbols are indexed for hover/defs
- Formatting
	- Full document, range, and on‑type formatting
	- Respects disabled preprocessor blocks
	- Consistent brace/semicolon/newline handling
- Generated script output
	- `LSL: Open Preprocessed Script` opens the include/macro-expanded output in a read-only editor tab
	- `LSL: Open Optimized Script` opens a readable optimized copy beside the source file without modifying the source
	- Both commands are available from the command palette and from the editor context menu in LSL files
- Memory estimate
	- Inlay hints show estimated Mono free memory at the script state, the optimized free-memory estimate, and the calibrated error band
- Diagnostics (server‑side analysis)
	- AST‑based checks for common LSL issues: arity/return mismatches, unused/duplicate declarations, dead code, and precise operator/type rules
	- Constant conditions are evaluated with bounded folding for literals, local constants, LSL truthiness, assignment-valued `if` conditions, and known vector/rotation equality
	- Unary operators: numeric `+`/`-`; integer `!`/`~`
	- Postfix `++/--`: require assignable integer variables
	- Bitwise and shifts: integer operands
	- Casts: redundant cast hints; `integer`⇄`float` allowed; everything→`string`/`list` allowed; extra guidance for string→number/vector/rotation/key
	- Vectors/rotations: components must be numeric; `.x/.y/.z/.s` member access validated
	- Conditions: warns on suspicious assignment inside `if/while/for` conditions
	- Indexing operator `[]`: flagged as unsupported in LSL
	- List equality advisory: `list == list` compares length only (comparisons to `[]` treated as emptiness checks)
	- Function calls: parameter types validated (string parameters accept integer/float/key; key parameters accept UUID-like strings and the empty string as `NULL_KEY`-style shorthand)
	- Definition metadata: deprecated calls, god-mode-required calls, and must-use result checks
	- Diagnostics can be selectively suppressed where needed
	- Includes checks for invalid state declarations/changes and for empty event/function bodies or empty if/else branches
- Semantic tokens
	- Accurate coloring driven by the language server (full and delta updates)
	- Readonly and modification modifiers for variables/parameters when applicable

## Configuration

- `lsl.definitionsPath`: Custom path to definitions JSON/YAML. Leave empty to use the bundled official definitions.
- `lsl.definitions.autoUpdate`: Download and use validated official definition updates when no custom definitions path is configured.
- `lsl.definitions.updateUrl`: Source URL for automatic official definition updates.
- `lsl.definitions.updateIntervalHours`: Minimum time between automatic update checks.
- `lsl.includePaths`: Additional search paths for `#include`.
	- The workspace folder(s) are always searched by default. In multi-root workspaces, all roots are included.
	- Resolution order: the current file’s directory, then workspace roots, then any paths listed in `lsl.includePaths`.
- `lsl.macros`: Project-wide predefined macros for conditionals
- `lsl.dynamicMacros`: Macros to preserve as unknown typed values instead of expanding, written as `name:type` entries such as `__AGENTID__:string` or `__UNIXTIME__:integer`
- `lsl.optimize`: Optimizer feature switches used by `LSL: Open Optimized Script`. All optimizer features are enabled by default; set individual flags to `false` to disable them.
- `lsl.measure.inlayHints`: Show or hide Mono memory estimate inlay hints.
- `lsl.enableSemanticTokens`: Toggle semantic tokens
- `lsl.diagnostics.disable`: Diagnostic codes or friendly names to disable globally
- `lsl.trace`: LSP protocol trace level (`off`, `messages`, `verbose`)

### Diagnostics and suppression

- Identifiers: use either the friendly dash-separated name (e.g., `wrong-arity`, `dead-code`, `unused-param`) or the numeric `LSL###` code. Hover shows both; either form works for suppression.
- Inline suppression directives (omit list to disable all diagnostics for that scope):
	- `// lsl-disable-line wrong-arity`
	- `// lsl-disable-next-line unused-param, duplicate-decl`
	- `// lsl-disable dead-code` (opens a block until `// lsl-enable`)
	- `// lsl-enable` (ends a block)
- Global disable list: set `lsl.diagnostics.disable` in settings (string or array). Examples:

```json
{
	"lsl.diagnostics.disable": ["wrong-arity", "unused-param"],
	"lsl.diagnostics.disable": "LSL010, LSL102"
}
```

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

The client bundles a TypeScript language server. On activation, it starts the server, provides the workspace settings, and wires up LSP features (hover, completion, diagnostics, rename, references, symbols).

Under the hood, the server uses an AST‑based pipeline (preprocess → parse → analyze) to understand your code and perform precise type and operator checks.

Data powering function/event/constant docs comes from the official `secondlife/lsl-definitions` YAML bundled with the server/extension.

Hovers display documentation and links from the bundled definitions when available. JSDoc comments above your own functions are shown inline.

## Known limitations

- Preprocessing aims to be compatible with common LSL usage; report any edge cases.
- Rename does not refactor strings or comments; only identifiers.
- Rename for include‑defined symbols occurs when a unique definition is found in indexed includes; ambiguous names are intentionally blocked.
- Macro rename works for the current file and indexed includes, but cannot follow unindexed or generated headers.

## Repository

- GitHub: https://github.com/Sekkmer/lsl-lsp

## License

MIT
