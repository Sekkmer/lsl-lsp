import {
	CompletionItem, CompletionItemKind,
	Position, CompletionParams, SignatureHelp, SignatureInformation, ParameterInformation
} from 'vscode-languageserver/node';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { Defs, normalizeType } from './defs';
import { Token } from './lexer';
import type { Analysis } from './parser';
import type { PreprocResult } from './preproc';
import path from 'node:path';
import fs from 'node:fs';

export function lslCompletions(
	doc: TextDocument,
	params: CompletionParams,
	defs: Defs,
	tokens: Token[],
	analysis: Analysis,
	pre: PreprocResult,
	opts?: { includePaths?: string[] }
): CompletionItem[] {
	const items: CompletionItem[] = [];
	const pos = params.position;
	const text = doc.getText();
	const offset = doc.offsetAt(pos);
	const lineStart = text.lastIndexOf('\n', offset - 1) + 1;
	const lineText = text.slice(lineStart, offset);
	const wordPrefix = extractWordPrefix(text, offset);

	// Keywords
	for (const k of defs.keywords) items.push(scored({ label: k, kind: CompletionItemKind.Keyword }));
	// Types
	for (const t of defs.types) items.push(scored({ label: t, kind: CompletionItemKind.Class, detail: 'type' }));
	// Constants
	for (const c of defs.consts.values()) items.push(typeScored({ label: c.name, kind: CompletionItemKind.EnumMember, detail: c.type, documentation: c.doc }, c.type));
	// Events
	for (const e of defs.events.values()) items.push(scored({ label: e.name, kind: CompletionItemKind.Event, documentation: e.doc }));
	// Contextual: include path after #include "
	const mInc = lineText.match(/^\s*#\s*include\s+"([^"\n]*)$/);
	if (mInc) {
		const typed = mInc[1] || '';
		const baseDir = dirnameOfDoc(doc);
		const includeRoots = [baseDir, ...(opts?.includePaths || [])];
		const seen = new Set<string>();
		// split typed into dir part + leaf
		const slash = typed.lastIndexOf('/');
		const typedDir = slash >= 0 ? typed.slice(0, slash) : '';
		const typedLeaf = slash >= 0 ? typed.slice(slash + 1) : typed;
		for (const root of includeRoots) {
			const dir = path.resolve(root, typedDir);
			try {
				const ents = fs.readdirSync(dir, { withFileTypes: true });
				for (const e of ents) {
					const labelPath = typedDir ? `${typedDir}/${e.name}` : e.name;
					if (e.isDirectory()) {
						// offer folder to continue navigation
						if (e.name.startsWith(typedLeaf) && !seen.has(labelPath + '/')) {
							items.push({ label: labelPath + '/', kind: CompletionItemKind.Folder });
							seen.add(labelPath + '/');
						}
						continue;
					}
					if (!/\.(lsl|lsli|lslp|lsl[hH])$/.test(e.name)) continue;
					if (typedLeaf && !e.name.startsWith(typedLeaf)) continue;
					if (!seen.has(labelPath)) {
						items.push({ label: labelPath, kind: CompletionItemKind.File });
						seen.add(labelPath);
					}
				}
			} catch { /* ignore */ }
		}
		return items;
	}

	// Contextual: after 'state ' suggest known state names from this document
	if (/\bstate\s+$/.test(lineText)) {
		// naive scan of doc for 'state <id>'
		const re = /\bstate\s+([A-Za-z_]\w*)/g;
		const seen = new Set<string>();
		let m: RegExpExecArray | null;
		while ((m = re.exec(text))) {
			const name = m[1];
			if (!seen.has(name)) { items.push({ label: name, kind: CompletionItemKind.Enum }); seen.add(name); }
		}
		return items;
	}

	// Contextual: member access .x .y .z .s after identifier '.' -> type-aware
	if (/\.\s*$/.test(lineText)) {
		const base = findMemberBase(tokens, offset);
		let comps: string[] | null = null;
		if (base?.kind === 'vector') comps = ['x', 'y', 'z'];
		else if (base?.kind === 'rotation') comps = ['x', 'y', 'z', 's'];
		if (!comps) comps = ['x', 'y', 'z', 's']; // fallback
		for (const m of comps) items.push(scored({ label: m, kind: CompletionItemKind.Property }));
		return items;
	}

	// Determine expected type at cursor (call argument, assignment, etc.)
	const ctx = findCallContext(doc, tokens, pos);
	let expectedType: string | 'any' = 'any';
	if (ctx) {
		const overloads = defs.funcs.get(ctx.name) || [];
		const chosen = chooseBestOverload(overloads, ctx, doc, tokens);
		expectedType = chosen?.params?.[ctx.argIndex]?.type || 'any';
	}

	// Locals/params visible before this position
	const seenNames = new Set<string>();
	for (const d of analysis.decls) {
		if ((d.kind === 'var' || d.kind === 'param') && doc.offsetAt(d.range.start) <= offset) {
			if (!seenNames.has(d.name)) {
				items.push(typeScored({ label: d.name, kind: CompletionItemKind.Variable, detail: d.type }, d.type || 'any', { local: true, boost: 5 }));
				seenNames.add(d.name);
			}
		}
	}

	// Functions from this document
	for (const [name, decl] of analysis.functions) {
		const sig = `${decl.type || 'void'} ${name}(${(decl.params || []).map(p => `${p.type || 'any'} ${p.name}`).join(', ')})`;
		items.push(typeScored({ label: name, kind: CompletionItemKind.Function, detail: sig }, decl.type || 'any'));
	}

	// Include-provided globals and functions
	if (pre && pre.includeSymbols) {
		for (const [file, info] of pre.includeSymbols) {
			void file;
			for (const [gname] of info.globals) {
				if (!seenNames.has(gname)) items.push(scored({ label: gname, kind: CompletionItemKind.Variable }));
			}
			for (const [fname, f] of info.functions) {
				const sig = `${f.returns} ${fname}(${f.params.map(p => `${p.type}${p.name ? ' ' + p.name : ''}`).join(', ')})`;
				items.push(typeScored({ label: fname, kind: CompletionItemKind.Function, detail: sig }, f.returns));
			}
		}
	}

	// Macros
	if (pre) {
		for (const [mname, mval] of Object.entries(pre.macros || {})) {
			const t = macroValueType(mval);
			items.push(typeScored({ label: mname, kind: CompletionItemKind.Constant, detail: t }, t));
		}
		for (const mname of Object.keys(pre.funcMacros || {})) {
			items.push(scored({ label: mname, kind: CompletionItemKind.Function }));
		}
		// Macros from includes too
		for (const info of pre.includeSymbols?.values() || []) {
			for (const [mname] of info.macroObjs) items.push(scored({ label: mname, kind: CompletionItemKind.Constant }));
			for (const [mname] of info.macroFuncs) items.push(scored({ label: mname, kind: CompletionItemKind.Function }));
		}
	}

	// Built-in functions (snippet completions), filtered by expected return type when known
	for (const [name, overloads] of defs.funcs.entries()) {
		const sig = overloads[0];
		const detail = `${sig.returns} ${sig.name}(${sig.params.map(p => `${p.type} ${p.name}`).join(', ')})`;
		const insert = `${name}(${sig.params.map((p, i) => `\${${i + 1}:${p.name}}`).join(', ')})`;
		const item = {
			label: name,
			kind: CompletionItemKind.Function,
			detail,
			documentation: sig.doc,
			data: { name },
			insertTextFormat: 2 as const, // Snippet
			insertText: insert,
			command: { title: 'trigger parameter hints', command: 'editor.action.triggerParameterHints' }
		};
		// If expectedType is set, include all but give higher score to matching return type
		items.push(typeScored(item, sig.returns));
	}

	// Rank by type match and name prefix
	const scoredItems = rankAndFinalize(items, expectedType, wordPrefix);
	return scoredItems;
}

export function resolveCompletion(item: CompletionItem): CompletionItem {
	// No-op; keep for docstring enrichment if needed
	return item;
}

export function lslSignatureHelp(doc: TextDocument, params: { textDocument: { uri: string }, position: Position }, defs: Defs, tokens: Token[]): SignatureHelp | null {
	const ctx = findCallContext(doc, tokens, params.position);
	if (!ctx) return null;
	const overloads = defs.funcs.get(ctx.name);
	if (!overloads || overloads.length === 0) return null;

	// Choose active signature by arity + simple type score
	const candidates = overloads.filter(fn => ctx.argIndex < fn.params.length);
	const chosen = (candidates.length > 0 ? candidates : overloads)
		.slice().sort((a, b) => scoreSignature(b, ctx, doc, tokens) - scoreSignature(a, ctx, doc, tokens))[0];

	const gotType = ctx.argRange ? inferExprType(doc, tokens, ctx.argRange) : 'any';
	const expType = chosen.params[ctx.argIndex]?.type || 'any';
	const mismatch = !typeMatches(expType, gotType);

	const sigs: SignatureInformation[] = overloads.map(fn => ({
		label: `${fn.returns} ${fn.name}(${fn.params.map(p => `${p.type} ${p.name}`).join(', ')})`,
		documentation: fn.doc,
		parameters: fn.params.map((p, i) => ParameterInformation.create(`${p.type} ${p.name}`,
			(fn === chosen && i === ctx.argIndex && mismatch) ? `Expected ${expType}, got ${gotType}` : p.doc))
	}));

	const activeSigIndex = Math.max(0, overloads.indexOf(chosen));
	return { signatures: sigs, activeSignature: activeSigIndex, activeParameter: Math.max(0, Math.min(ctx.argIndex, (chosen.params.length - 1))) };
}

function scoreSignature(fn: { params: { type: string }[] }, ctx: { argIndex: number; argRange?: { start: Position; end: Position } }, doc: TextDocument, tokens: Token[]): number {
	let s = 0;
	// crude: only consider current arg
	const got = ctx.argRange ? inferExprType(doc, tokens, ctx.argRange) : 'any';
	const exp = fn.params[ctx.argIndex]?.type || 'any';
	if (typeMatches(exp, got)) s += 2; else s -= 1;
	// prefer fewer params than wildly longer overloads when argIndex near end
	s += Math.max(0, 5 - fn.params.length);
	return s;
}

function findCallContext(doc: TextDocument, tokens: Token[], pos: Position): { name: string; argIndex: number; argRange?: { start: Position; end: Position } } | null {
	const offset = doc.offsetAt(pos);
	// Find token index at or before offset
	let ti = tokens.findIndex(t => t.start <= offset && t.end >= offset);
	if (ti === -1) {
		// pick last token before offset
		for (let k = tokens.length - 1; k >= 0; k--) if (tokens[k].end <= offset) { ti = k; break; }
	}
	if (ti === -1) return null;
	// Walk backwards to find matching '('
	let depth = 0; let i = ti;
	for (; i >= 0; i--) {
		const t = tokens[i];
		if (t.value === ')') depth++;
		else if (t.value === '(') {
			if (depth === 0) break; else depth--;
		}
	}
	if (i < 1) return null;
	const lparen = tokens[i];
	const prev = tokens[i - 1];
	if (!prev || prev.kind !== 'id') return null;
	const name = prev.value;
	// Exclude type-cast forms like integer(...)
	// We cannot access defs here; callsite ensures only defs.funcs are considered later.

	// Compute arg index and current arg range
	let j = i + 1; let pDepth = 1; let bDepth = 0; let cDepth = 0; let vDepth = 0;
	let argIndex = 0; const argStart = lparen.end; let currentStart: number | null = argStart;
	let currentEnd: number | null = null;
	while (j < tokens.length) {
		const t = tokens[j++];
		if (t.value === '(') { pDepth++; continue; }
		if (t.value === ')') {
			pDepth--;
			if (pDepth === 0) { currentEnd = t.start; break; }
			continue;
		}
		if (t.value === '[') { bDepth++; continue; }
		if (t.value === ']') { if (bDepth > 0) bDepth--; continue; }
		if (t.value === '{') { cDepth++; continue; }
		if (t.value === '}') { if (cDepth > 0) cDepth--; continue; }
		if (t.value === '<') { vDepth++; continue; }
		if (t.value === '>') { if (vDepth > 0) vDepth--; continue; }
		if (pDepth === 1 && bDepth === 0 && cDepth === 0 && vDepth === 0 && t.value === ',') {
			if (offset <= t.start) { currentEnd = t.start; break; }
			argIndex++;
			currentStart = t.end;
		}
	}
	const range = (currentStart != null && currentEnd != null) ? { start: doc.positionAt(currentStart), end: doc.positionAt(currentEnd) } : undefined;
	return { name, argIndex, argRange: range };
}

function inferExprType(doc: TextDocument, tokens: Token[], range: { start: Position, end: Position }): string {
	const startOff = doc.offsetAt(range.start);
	const endOff = doc.offsetAt(range.end);
	const slice = tokens.filter(t => t.start >= startOff && t.end <= endOff);
	if (slice.length === 0) return 'any';
	const t0 = slice[0];
	if (t0.kind === 'str') return 'string';
	if (t0.kind === 'num') return /\./.test(t0.value) ? 'float' : 'integer';
	if (t0.value === '<') return 'vector';
	if (t0.value === '[') return 'list';
	if (t0.kind === 'id') {
		// Member access: <expr>.x|y|z|s -> float
		const prevIdx = tokens.findIndex(t => t.start === t0.start && t.end === t0.end) - 1;
		if (prevIdx >= 1 && tokens[prevIdx]?.value === '.') {
			const mem = t0.value;
			if (mem === 'x' || mem === 'y' || mem === 'z' || mem === 's') return 'float';
		}
		const v = t0.value;
		if (v === 'TRUE' || v === 'FALSE') return 'integer';
		if (v === 'NULL_KEY') return 'key';
		return 'any';
	}
	return 'any';
}

function typeMatches(expected: string, got: string): boolean {
	expected = normalizeType(expected);
	got = normalizeType(got);
	if (expected === 'any' || got === 'any') return true;
	if (expected === got) return true;
	if (expected === 'integer' && got === 'float') return true;
	if (expected === 'float' && got === 'integer') return true;
	return false;
}

function dirnameOfDoc(doc: TextDocument): string {
	try {
		const u = new URL(doc.uri);
		if (u.protocol === 'file:') return path.dirname(decodeURIComponent(u.pathname));
	} catch { /* ignore */ }
	return path.dirname(doc.uri.replace(/^file:\/\//, ''));
}

function chooseBestOverload(overloads: { params: { type: string }[] }[], ctx: { argIndex: number; argRange?: { start: Position; end: Position } }, doc: TextDocument, tokens: Token[]) {
	if (!overloads || overloads.length === 0) return null as any;
	const candidates = overloads.filter(fn => ctx.argIndex < fn.params.length);
	const list = (candidates.length > 0 ? candidates : overloads)
		.slice().sort((a, b) => scoreSignature(b, ctx, doc, tokens) - scoreSignature(a, ctx, doc, tokens));
	return list[0];
}

// Helpers for type-aware ranking and context
function extractWordPrefix(text: string, offset: number): string {
	let i = offset;
	while (i > 0 && /[A-Za-z0-9_]/.test(text[i - 1]!)) i--;
	return text.slice(i, offset);
}

function macroValueType(v: any): string {
	if (typeof v === 'number') return Number.isInteger(v) ? 'integer' : 'float';
	if (typeof v === 'boolean') return 'integer'; // TRUE/FALSE treated as integer in LSL
	if (typeof v === 'string') return 'string';
	return 'any';
}

type ScoredItem = CompletionItem & { _score?: number };

function scored(item: CompletionItem, base = 0): ScoredItem { (item as ScoredItem)._score = base; return item as ScoredItem; }
function typeScored(item: CompletionItem, itemType: string, opts?: { local?: boolean; boost?: number }): ScoredItem {
	const it = item as ScoredItem;
	it._score = (opts?.boost ?? 0) + (opts?.local ? 2 : 0);
	// defer exact type match scoring until rank stage where expectedType is known
	(it as any)._itemType = itemType;
	return it;
}

function rankAndFinalize(items: CompletionItem[], expectedType: string | 'any', prefix: string): CompletionItem[] {
	const out: ScoredItem[] = [];
	for (const it of items as ScoredItem[]) {
		let s = it._score || 0;
		const itemType = (it as any)._itemType as string | undefined;
		if (itemType && expectedType && expectedType !== 'any') {
			if (typeMatches(expectedType, itemType)) s += 50;
		}
		// name prefix boost
		if (prefix && typeof it.label === 'string' && (it.label as string).toLowerCase().startsWith(prefix.toLowerCase())) s += 10;
		// small tie-break by kind
		if (it.kind === CompletionItemKind.Variable) s += 1;
		(it as any).sortText = String(1000000 - s).padStart(7, '0');
		out.push(it);
	}
	return out;
}

function findMemberBase(tokens: Token[], offset: number): { kind: 'vector' | 'rotation' | 'other' } | null {
	// Find the '.' token immediately before offset and inspect the token before it
	let dotIdx = -1;
	for (let i = 0; i < tokens.length; i++) {
		const t = tokens[i];
		if (t.start <= offset && t.end <= offset && t.value === '.') dotIdx = i;
		if (t.start > offset) break;
	}
	if (dotIdx <= 0) return null;
	const prev = tokens[dotIdx - 1];
	if (!prev) return null;
	if (prev.kind === 'id') {
		// We cannot fully resolve type here without full symbol table; fall back to heuristic using following member rules already validated in parser diagnostics
		// If the identifier name hints rotation variable commonly named 'rot' or 'q', we still don't assume; return other
		return { kind: 'other' };
	}
	if (prev.value === '>') return { kind: 'vector' }; // closing of <...>
	return { kind: 'other' };
}
