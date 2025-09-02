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
import { parseIncludeSymbols } from '../src/includeSymbols';
import fsSync from 'node:fs';

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
		includeSymbols: new Map(),
		includeTargets: full.includeTargets,
		missingIncludes: full.missingIncludes,
		preprocDiagnostics: full.preprocDiagnostics,
		diagDirectives: full.diagDirectives,
		conditionalGroups: full.conditionalGroups,
	};

	// Inject __FILE__ into macro table for tests that inspect pre.macros directly
	try { pre.macros.__FILE__ = basenameFromUri(doc.uri); } catch { /* ignore */ }

	const tokens = lex(doc, pre.disabledRanges);
	// New AST pipeline: parse to AST, then analyze
	const script = parseScriptFromText(doc.getText(), doc.uri, { macros: opts?.macros, includePaths: opts?.includePaths });
	// Populate includeSymbols for tests, mirroring server getPipeline
	try {
		const sink = new Map<string, ReturnType<typeof parseIncludeSymbols>>();
		const seen = new Set<string>();
		const roots: string[] = [];
		if (pre.includeTargets && pre.includeTargets.length > 0) {
			for (const it of pre.includeTargets) { if (it.resolved) roots.push(it.resolved); }
		} else if (pre.includes && pre.includes.length > 0) {
			roots.push(...pre.includes);
		}
		for (const r of roots) loadIncludeSymbolsRecursive(r, opts?.includePaths || [], sink, seen);
		for (const [fp, info] of sink) { if (info) pre.includeSymbols!.set(fp, info); }
	} catch {/* ignore */}
	const analysis = analyzeAst(doc, script, defs, pre);
	const sem = buildSemanticTokens(doc, tokens, defs, pre, analysis);

	return { pre, tokens, analysis, sem };
}

function parseIncludesFromText(text: string): string[] {
	const out: string[] = [];
	const lines = text.split(/\r?\n/);
	for (const L of lines) {
		const m = /^\s*#\s*include\s+(["<])([^">]+)[">]/.exec(L);
		if (m) out.push(m[2]!);
	}
	return out;
}

function resolveIncludeCompat(baseDir: string, target: string, includePaths: string[]): string | null {
	const rel = path.resolve(baseDir, target);
	try { if (fsSync.existsSync(rel) && fsSync.statSync(rel).isFile()) return rel; } catch { /* ignore */ }
	for (const p of includePaths) {
		try {
			const cand = path.resolve(p, target);
			if (fsSync.existsSync(cand) && fsSync.statSync(cand).isFile()) return cand;
		} catch { /* ignore */ }
	}
	return null;
}

function loadIncludeSymbolsRecursive(rootFile: string, includePaths: string[], sink: Map<string, ReturnType<typeof parseIncludeSymbols>>, seen: Set<string>) {
	if (seen.has(rootFile)) return;
	seen.add(rootFile);
	try {
		const info = parseIncludeSymbols(rootFile);
		if (info) sink.set(rootFile, info);
		const text = fsSync.readFileSync(rootFile, 'utf8');
		const deps = parseIncludesFromText(text)
			.map(t => resolveIncludeCompat(path.dirname(rootFile), t, includePaths))
			.filter((p): p is string => !!p);
		for (const dep of deps) loadIncludeSymbolsRecursive(dep, includePaths, sink, seen);
	} catch { /* ignore */ }
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
