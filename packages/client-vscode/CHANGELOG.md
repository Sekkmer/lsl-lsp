# Changelog

All notable changes to this project will be documented in this file.

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
