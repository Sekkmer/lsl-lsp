import path from 'node:path';
import fs from 'node:fs/promises';
import { TextDocument } from 'vscode-languageserver-textdocument';
import type { Defs } from '../src/defs';
import type { PreprocResult } from '../src/core/preproc';
import { preprocessForAst } from '../src/core/pipeline';
import { lex } from '../src/lexer';
import { buildSemanticTokens } from '../src/semtok';
import type { Hover, MarkedString, MarkupContent } from 'vscode-languageserver/node';
import type { Token as LexToken } from '../src/lexer';
import type { SimpleToken } from '../src/navigation';
import { parseScriptFromText } from '../src/ast/parser';
import { analyzeAst } from '../src/ast/analyze';
import { URI } from 'vscode-uri';
import { basenameFromUri } from '../src/builtins';

export function docFrom(code: string, uri = 'file:///test.lsl') {
	return TextDocument.create(uri, 'lsl', 1, code);
}

export async function readFixture(rel: string) {
	const p = path.join(__dirname, 'fixtures', rel);
	return fs.readFile(p, 'utf8');
}

export type RunPipelineOptions = { macros?: Record<string, string | number | boolean>; includePaths?: string[] };

export function runPipeline(doc: TextDocument, defs: Defs, opts?: RunPipelineOptions) {
	// Use new tokenizer+macro pipeline for disabled ranges/macros/includes, mirroring server integration
	const fromPath = URI.parse(doc.uri).fsPath;
	const full = preprocessForAst(doc.getText(), { includePaths: opts?.includePaths ?? [], fromPath, defines: opts?.macros ?? {} });
	const pre: PreprocResult = {
		disabledRanges: full.disabledRanges,
		macros: { ...full.macros },
		funcMacros: full.funcMacros,
		includes: full.includes,
		includeTargets: full.includeTargets,
		missingIncludes: full.missingIncludes,
		preprocDiagnostics: full.preprocDiagnostics,
		diagDirectives: full.diagDirectives,
		conditionalGroups: full.conditionalGroups,
		expandedTokens: full.expandedTokens,
	};

	// Inject __FILE__ into macro table for tests that inspect pre.macros directly
	try { pre.macros.__FILE__ = basenameFromUri(doc.uri); } catch { /* ignore */ }

	// Original lexed tokens (pre-expansion) still useful for semantic tokens; however
	// tests validating macro expansion want the fully expanded stream. Expose both.
	const rawTokens = lex(doc, pre.disabledRanges);
	const expanded: LexToken[] | undefined = full.expandedTokens
		? full.expandedTokens.map(t => ({ kind: t.kind as unknown as LexToken['kind'], value: t.value, start: t.span.start, end: t.span.end }))
		: undefined;
	// Preserve original lexer tokens for existing tests; expose expandedTokens separately for targeted assertions
	const tokens = rawTokens;
	// New AST pipeline: parse to AST, then analyze
	// Reuse the macro table produced by the first preprocess pass to avoid divergence
	// (notably for synthetic built-ins like __FILE__ whose presence controls conditional branches).
	// Passing full.macros ensures #if defined(__FILE__) guarded declarations are preserved
	// consistently between the preprocessing used for analysis and the parser invocation here.
	const script = parseScriptFromText(doc.getText(), doc.uri, { macros: { ...full.macros, ...(opts?.macros || {}) }, includePaths: opts?.includePaths, pre: full });
	const analysis = analyzeAst(doc, script, defs, pre);
	const sem = buildSemanticTokens(doc, tokens, defs, pre, analysis);

	return { pre, tokens, rawTokens, expandedTokens: expanded, analysis, sem };
}

export function tokensToDebug(tokens: ReturnType<typeof lex>) {
	return tokens.map(t => ({ k: t.kind, v: t.value, s: t.start, e: t.end }));
}

export type SemSpan = { line: number; char: number; len: number; type: number; mod: number };
export function semToSpans(doc: TextDocument, sem: { data: number[] }): SemSpan[] {
	// Convert LSP delta-encoded ints into readable spans for snapshot clarity
	const out: SemSpan[] = [];
	const d = sem.data;
	let line = 0, char = 0;
	for (let i = 0; i < d.length; i += 5) {
		line += d[i];
		if (d[i] !== 0) char = 0;
		char += d[i + 1];
		out.push({ line, char, len: d[i + 2], type: d[i + 3], mod: d[i + 4] });
	}
	return out;
}

export type FakeFs = Pick<typeof import('node:fs'), 'existsSync' | 'readFileSync' | 'statSync'>;

function markedStringToString(ms: MarkedString): string {
	return typeof ms === 'string' ? ms : ms.value;
}

export function hoverToString(h: Hover): string {
	const c = h.contents;
	if (typeof c === 'string') return c;
	if (Array.isArray(c)) return c.length ? markedStringToString(c[0] as MarkedString) : '';
	const mc = c as MarkupContent;
	return mc.value;
}

export function toSimpleTokens(tokens: ReadonlyArray<LexToken>): SimpleToken[] {
	return tokens.map(t => ({ kind: t.kind, value: t.value, start: t.start, end: t.end }));
}
