# New lex/macro pipeline (work-in-progress)

Goal: separate concerns so the flow is:

1) Tokenize raw text into a stream of tokens.
   - Consume whitespace and CRLF/line splices.
   - Emit comments and whole preprocessor directives as tokens.
   - No macro expansion.

2) Chunk the token stream by conditionals (#if/#elif/#else/#endif).
   - Build a tree of chunks with branches.
   - Given a defines table, evaluate and produce an active token stream.

3) Downstream lexers/parsers operate on clean tokens with no directives, no whitespace handling, and no inactive code.

Files:
- tokens.ts         — basic Token model used by the pipeline.
- tokenizer.ts      — standalone tokenizer for step (1).
- macroConditional.ts — conditional chunker and evaluator for step (2).

Integration TBD: the existing server parser still uses its own lexer. We'll gradually wire this in behind feature flags and tests.
