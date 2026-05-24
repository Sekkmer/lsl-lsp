# Changelog

All notable changes to this project will be documented in this file.

## 0.1.10
- Split the implementation into reusable `core`, `server`, `client-vscode`, and `cli` packages.
- Added a standalone bundled `lsl-lsp` CLI for diagnostics, formatting, preprocessing, symbols, definitions, hovers, and definition dumps.
- Removed VS Code dependencies from core so the analyzer can be reused by the CLI and other tooling.
- Improved include and macro handling, including transitive include definitions, inactive include filtering, repeated textual includes, cache invalidation, and macro argument/source metadata preservation.
- Tightened parser and diagnostics for state declaration order, duplicate declarations, invalid state bodies, trailing commas, control-transfer semicolons, invalid global initializers, top-level name collisions, and scoped locals.
- Aligned operator, member-access, assignment, return, list, vector, rotation, key/string, and numeric literal behavior more closely with Second Life and lslint comparisons.
- Expanded bounded constant folding for LSL truthiness, vector/rotation equality, assignment-valued conditions, and non-short-circuit `&&`/`||` side effects.
- Added warnings for nested list literal flattening and improved empty-body diagnostics while preserving valid empty functions/events as warnings.
- Fixed diagnostic suppression, inactive code handling, hover/definition resolution, rename behavior, semantic tokens, and formatting around preprocessor directives.

## 0.1.9
- Fixed global diagnostic disable settings so updates apply reliably after configuration changes.
- Added diagnostics and hover support for official definition metadata, including deprecated calls, god-mode requirements, and must-use results.
- Added LSL-compatible key handling for UUID-like string literals and empty string key arguments.
- Aligned operator, member-access, list-comparison, and type-compatibility diagnostics with Second Life compiler behavior.
- Added bounded evaluator-backed constant folding for constant-condition diagnostics.
- Improved macro-expanded argument handling.
- Updated bundled official LSL definitions and TypeScript/ESLint/Vitest tooling.
- Removed the legacy wiki crawler and obsolete generated common-definition flow.
- Refreshed project and extension documentation.

## 0.1.0
- Initial release of LSL LSP
- Language Server: diagnostics, hover, completion, definition, symbols
- Preprocessor support: `#if/#elif/#endif`, `#include`, macros (incl. `__FILE__`, varargs)
- Formatter: full, range, and on-type formatting
- Semantic tokens (full + delta)
- TextMate grammar aligned with preprocessor constructs
