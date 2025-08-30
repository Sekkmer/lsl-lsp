import path from 'node:path';
import fs from 'node:fs/promises';
import { TextDocument } from 'vscode-languageserver-textdocument';
import type { Defs } from '../src/defs';
import { preprocess } from '../src/preproc';
import { lex } from '../src/lexer';
import { buildSemanticTokens } from '../src/semtok';
import { parseScriptFromText } from '../src/ast/parser';
import { analyzeAst } from '../src/ast/analyze';

export function docFrom(code: string, uri = 'file:///test.lsl') {
	return TextDocument.create(uri, 'lsl', 1, code);
}

export async function readFixture(rel: string) {
	const p = path.join(__dirname, 'fixtures', rel);
	return fs.readFile(p, 'utf8');
}

export function runPipeline(doc: TextDocument, defs: Defs, opts?: {
	macros?: Record<string, any>, includePaths?: string[]
}) {
	const pre = preprocess(doc, opts?.macros ?? {}, opts?.includePaths ?? [], /*connection*/ {
		window: { showWarningMessage: (_m: string) => void 0 }
		// the rest of Connection is unused in tests
	} as any);

	const tokens = lex(doc, pre.disabledRanges);
	// New AST pipeline: parse to AST, then analyze
	const script = parseScriptFromText(doc.getText(), doc.uri, { macros: opts?.macros, includePaths: opts?.includePaths });
	const analysis = analyzeAst(doc, script, defs, pre);
	const sem = buildSemanticTokens(doc, tokens, defs, pre, analysis);

	return { pre, tokens, analysis, sem };
}

export function tokensToDebug(tokens: ReturnType<typeof lex>) {
	return tokens.map(t => ({ k: t.kind, v: t.value, s: t.start, e: t.end }));
}

export function semToSpans(doc: TextDocument, sem: { data: number[] }) {
	// Convert LSP delta-encoded ints into readable spans for snapshot clarity
	const out: { line: number; char: number; len: number; type: number; mod: number }[] = [];
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
