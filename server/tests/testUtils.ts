import path from 'node:path';
import fs from 'node:fs/promises';
import { TextDocument } from 'vscode-languageserver-textdocument';
import type { Defs } from '../src/defs';
import type { PreprocResult } from '../src/core/preproc';
import { preprocessForAst } from '../src/core/pipeline';
import { lex } from '../src/lexer';
import { buildSemanticTokens } from '../src/semtok';
import { parseScriptFromText } from '../src/ast/parser';
import { analyzeAst } from '../src/ast/analyze';
import { URI } from 'vscode-uri';
import { basenameFromUri } from '../src/builtins';
import { parseIncludeSymbols } from '../src/includeSymbols';

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
	// Use new tokenizer+macro pipeline for disabled ranges/macros/includes, mirroring server integration
	const fromPath = URI.parse(doc.uri).fsPath;
	const full = preprocessForAst(doc.getText(), { includePaths: opts?.includePaths ?? [], fromPath, defines: opts?.macros ?? {} });
	const pre: PreprocResult = {
		disabledRanges: full.disabledRanges,
		macros: { ...full.macros },
		funcMacros: full.funcMacros,
		includes: full.includes,
		includeSymbols: new Map(),
		includeTargets: full.includeTargets,
		missingIncludes: full.missingIncludes,
		preprocDiagnostics: full.preprocDiagnostics,
		diagDirectives: full.diagDirectives,
		conditionalGroups: full.conditionalGroups,
	} as any;

	// Inject __FILE__ into macro table for tests that inspect pre.macros directly
	try { (pre.macros as any).__FILE__ = basenameFromUri(doc.uri); } catch { /* ignore */ }

	const tokens = lex(doc, pre.disabledRanges);
	// New AST pipeline: parse to AST, then analyze
	const script = parseScriptFromText(doc.getText(), doc.uri, { macros: opts?.macros, includePaths: opts?.includePaths });
	// Populate includeSymbols for tests, mirroring server getPipeline
	try {
		if (pre.includeTargets && pre.includeTargets.length > 0) {
			for (const it of pre.includeTargets) {
				if (!it.resolved) continue;
				const info = parseIncludeSymbols(it.resolved);
				if (info) pre.includeSymbols!.set(it.resolved, info as any);
			}
		} else if (pre.includes && pre.includes.length > 0) {
			for (const file of pre.includes) {
				const info = parseIncludeSymbols(file);
				if (info) pre.includeSymbols!.set(file, info as any);
			}
		}
	} catch {/* ignore */}
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
