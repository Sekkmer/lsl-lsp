# Preprocessor internals

This directory contains the active token and macro pipeline used by the shared core. It is not a separate parser or an unfinished replacement for the server's preprocessor.

`preprocessForAst` in `pipeline.ts` is the main entry point:

1. `Tokenizer` reads the root source and records token spans and file identities.
2. `buildIncludeResolver` resolves included files relative to the including file and configured search paths, caching tokenized content.
3. `preprocessAndExpandNew` processes includes, conditional branches, and macros in source order. Inactive branches are removed from the active stream.
4. The pipeline collects include information, diagnostic directives, dialect extension settings, and expanded tokens for the AST parser and editor features.

| File | Role |
| --- | --- |
| `tokens.ts` | Token and source-span types |
| `tokenizer.ts` | Source tokenizer, including comments and directives |
| `macro.ts` | Macro expansion, conditional processing, and include traversal |
| `preproc.ts` | Shared preprocessing types and helpers |
| `pipeline.ts` | Include resolution and preprocessing entry points |

The AST parser lives in `../ast/parser.ts`. `preprocessTokens` is a compatibility wrapper around `preprocessForAst` used by tests and consumers that only need tokens and macro tables.

When changing preprocessing, preserve each token's source file and span: navigation, diagnostics, and semantic highlighting depend on them. Regression tests should cover macro changes across includes, repeated guarded includes, inactive branches, and source-order effects. Test cases live in `packages/core/tests`.
