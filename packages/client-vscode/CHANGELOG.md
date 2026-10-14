# Changelog

All notable changes to this project will be documented in this file.

## 0.1.23

- Fixed `optimize --check` to compare the same newline-normalized output used by printing and `--write`, avoiding repeated change reports caused only by a trailing newline.
- Improved helper inlining with multiple call sites, collision-free names, and memory/call-depth comparisons. Preserved parameter copies, numeric conversions, lexical scope, snapshots, and LSL evaluation order.
- Fixed unsafe optimizer rewrites involving overflowing integer arithmetic, list construction and append grouping, shadowed variables, and computations that can fail or never return. Added boundary-value differential tests and fresh Second Life probes.
- Added static call-graph and reachable-recursion reporting to CLI measurements and editor hints. Shared helper graphs no longer cause exponential measurement time. A `lsl-memory-reserve` source comment can include an explicit runtime allowance; estimates still do not measure live heap peaks or stack frames.
- Fixed preprocessing source order, redefinitions, included `#undef`, nested conditions, include diagnostics, quoted macro arguments, token boundaries, stringification, and `__VA_OPT__`.
- Fixed switch lowering to evaluate its expression once with the correct type. Aligned numeric literal validation with SL, including decimal `f/F` suffixes and rejection of direct hexadecimal float literals.
- Corrected SL-backed evaluator behavior for integer overflow, operand order, string/list ranges, Unicode indexing, list conversions/sorting/strides, and Base64 padding. Source-sensitive JSON and Unicode cases remain unfolded when equivalence is uncertain.
- Fixed completion scope, shadowed parameter analysis, loop/jump diagnostics, and return/type checking. Fixed semantic-token deltas, quick fixes, and analysis refresh after configuration or definition changes.
- Protected CLI optimization from overwriting invalid or incomplete inputs. Packaged extensions use their bundled server; workspace server discovery is limited to extension development. Definition updates now serialize overlapping writes and respect source changes.
- Added an experimental workspace-only simulator with generic, original communication fixtures, deterministic events, linked messages/chat, linkset data, script lifecycle, and virtual timers/delays. It supports a subset of LSL and does not replace SL validation.
- Rewrote the main, Marketplace, CLI, and simulator guides, including object/prim/script manifests and a runnable communication example between an attachment and a rezzed panel. Added an optional CLI skill for Codex and Claude Code.
- Added CLI/server protocol tests and all-package release gates. Missing mandatory bundled definitions now fail the build.

## 0.1.22
- Fixed global diagnostic disable settings so empty or unrelated LSP configuration-change notifications cannot clear the active disable list.

## 0.1.21
- Fixed hover on nested builtin, user-defined, and macro-backed calls so the symbol under the cursor wins over the enclosing call context.
- Fixed signature help at nested first-argument boundaries so parent calls remain selected where appropriate.
- Fixed empty `if`/`else` body suppression UX by anchoring those diagnostics to the `if`/`else` keyword lines.
- Hardened global diagnostic disable settings so comma- or space-separated entries inside VS Code array settings are parsed consistently.

## 0.1.20
- Fixed parser recovery so missing commas in list literals, call arguments, and function parameters are reported as syntax errors.
- Fixed Mono memory inlay hints refreshing after edits so stale estimate overlays are cleared by clients that support inlay hint refresh.
- Fixed false-positive `LSL050` diagnostics for Second Life-valid prefix unary assignment conditions such as `while(~i = llListFindList(...))`, while keeping the assignment-in-condition warning.
- Changed GitHub release publishing to use the client changelog entry as the release notes source.
- Improved VSIX prepublish scripts to invoke pnpm through Corepack when run by npm-based packaging tools.

## 0.1.19
- Fixed optimizer list-length handling so numeric `llGetListLength` uses stay numeric instead of becoming boolean list checks.
- Fixed key constant folding and default initializer handling so `NULL_KEY` remains distinct from the empty key and folded key literals keep their key type.
- Fixed local value propagation around jump barriers, conditional writes, and loop dependency writes, with added regression coverage.
- Fixed statement-function inlining cleanup so safe redundant blocks are flattened after inlining.
- Fixed macro expansion so parenthesized compound macros preserve grouping in optimized expressions.

## 0.1.18
- Fixed optimized control-flow output so inverted `if`/`else if` chains cannot attach `else` clauses to the wrong nested branch.
- Fixed optimized `&&`/`||` emission to preserve Second Life operator grouping.
- Added optimizer semantic regression coverage backed by local Second Life probes for branch shape, operator precedence, and evaluation order.

## 0.1.17
- Added official definition auto-update support so bundled LSL definitions can be refreshed from upstream instead of going stale.
- Added opt-in Firestorm-style LSL extension support, including constant global expressions, lazy list access lowering, switch lowering, and extension detection.
- Added Firestorm preprocessor header support so generated files can carry and recover original source text.
- Added measured optimizer flow passes for demand/use cleanup, local value propagation, constant-argument specialization, branch simplification, and local slot reuse, with safeguards for escaped builtin sentinel constants, stable memory comparison, assignment targets, and self-update liveness.

## 0.1.16
- Added static Mono memory estimates through the `lsl-lsp measure` CLI command and VS Code inlay hints, including optimized-output comparison and a calibrated error band.
- Improved optimizer inlining decisions using the AST memory estimator so generated scripts can reduce Mono memory more reliably.
- Added tracked AST measurement regression tests and documentation for the new memory estimate workflow.

## 0.1.15
- Fixed optimizer output for constant globals, member access, prefix/postfix operators, unary expressions, macro-expanded booleans, and empty-state preservation so generated scripts stay valid LSL.
- Added diagnostics for empty states without event handlers, matching Second Life compiler behavior while keeping empty event/function bodies as warnings.
- Added optimizer regression tests for previously invalid generated output patterns.

## 0.1.14
- Fixed optimized output so nested casts are emitted with parentheses and remain valid LSL.
- Fixed formatting of optimized `for` headers so `!=` is not split into invalid `! =` syntax.
- Added diagnostics for direct chained C-style casts that Second Life rejects.

## 0.1.13
- Added a bundled `lsl-lsp optimize` CLI command and exposed generated preprocessed/optimized script output from VS Code.
- Added typed dynamic macro support for preserving runtime-provided macro values during preprocessing and optimization.
- Added optimizer support for constant folding, pure function folding, unused-code removal, name shrinking, readable stable output, and LSL-aware list/runtime semantics.
- Fixed false-positive modulus operator diagnostics when one operand type is temporarily unknown.

## 0.1.12
- Fixed the bundled CLI `--version` output so it is injected from the CLI package version during release builds.

## 0.1.11
- Fixed include preprocessing so inactive conditional spans are tracked per source file instead of suppressing unrelated included tokens at matching offsets.
- Fixed angle-bracket include resolution so include paths take precedence over the including file's directory, preventing self-include skips in shared module layouts.
- Improved diagnostics around macro-heavy ARES scripts by preserving valid expanded token streams across nested includes.

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
