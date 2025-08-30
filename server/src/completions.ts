import {
	CompletionItem, CompletionItemKind,
	Position, CompletionParams, SignatureHelp, SignatureInformation, ParameterInformation
} from 'vscode-languageserver/node';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { Defs, normalizeType } from './defs';
import type { Analysis } from './analysisTypes';
import type { PreprocResult } from './preproc';
import path from 'node:path';
import fs from 'node:fs';

export function lslCompletions(
	doc: TextDocument,
	params: CompletionParams,
	defs: Defs,
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

	// If we're at the top level inside a state body (not inside an event/function),
	// suggest only events with a full typed signature snippet. (AST-based)
	const stateCtx = findStateTopLevelContextAst(doc, analysis, offset);
	if (stateCtx.inStateTopLevel) {
		// Collect events already declared in this state up to this position
		const declaredEvents = new Set<string>();
		for (const d of analysis.decls) {
			if (d.kind !== 'event') continue;
			if (!stateCtx.stateRange) continue;
			const s = doc.offsetAt(d.range.start);
			const stStart = doc.offsetAt(stateCtx.stateRange.start);
			const stEnd = doc.offsetAt(stateCtx.stateRange.end);
			// Consider all events declared inside this state, regardless of cursor position
			if (s >= stStart && s <= stEnd) declaredEvents.add(d.name);
		}
		const out: CompletionItem[] = [];
		for (const e of defs.events.values()) {
			if (declaredEvents.has(e.name)) continue;
			if (wordPrefix && !e.name.toLowerCase().startsWith(wordPrefix.toLowerCase())) continue;
			const paramsSig = e.params.map(p => `${p.type} ${p.name}`).join(', ');
			const detail = `event ${e.name}(${paramsSig})`;
			const insert = `${e.name}(${paramsSig}) {\n\t$0\n}`;
			out.push({
				label: e.name,
				kind: CompletionItemKind.Event,
				detail,
				documentation: e.doc,
				insertTextFormat: 2 as const, // Snippet
				insertText: insert
			});
		}
		return out;
	}

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

	// Contextual: member access .x .y .z .s after identifier '.' -> type-aware (AST/text-based)
	if (/\.\s*$/.test(lineText)) {
		const name = findMemberBaseName(text, offset);
		let comps: string[] | null = null;
		if (name) {
			const declType = resolveIdentifierTypeAt(name, analysis, doc, offset) || '';
			if (declType === 'vector') comps = ['x', 'y', 'z'];
			else if (declType === 'rotation') comps = ['x', 'y', 'z', 's'];
		}
		if (!comps) comps = ['x', 'y', 'z', 's']; // fallback
		for (const m of comps) items.push(scored({ label: m, kind: CompletionItemKind.Property }));
		return items;
	}

	// Determine expected type at cursor (call argument, assignment, etc.)
	const ctx = findCallContextFromAnalysis(analysis, pos);
	let expectedType: string | 'any' = 'any';
	if (ctx) {
		const overloads = defs.funcs.get(ctx.name) || [];
		const chosen = chooseBestOverloadAst(overloads, ctx);
		expectedType = chosen?.params?.[ctx.argIndex]?.type || 'any';
	}

	// Locals/params visible before this position
	const seenNames = new Set<string>();
	for (const d of analysis.decls) {
		if ((d.kind === 'var' || d.kind === 'param') && doc.offsetAt(d.range.start) <= offset) {
			if (!seenNames.has(d.name)) {
				// If inside a call arg with expectedType, add extra weight when types match
				const boost = (expectedType && expectedType !== 'any' && d.type && typeMatches(expectedType, d.type)) ? 15 : 5;
				items.push(typeScored({ label: d.name, kind: CompletionItemKind.Variable, detail: d.type }, d.type || 'any', { local: true, boost }));
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

// AST-based: inside state but not inside an event
function findStateTopLevelContextAst(doc: TextDocument, analysis: Analysis, offset: number): { inStateTopLevel: boolean; stateRange?: { start: Position; end: Position } } {
	const pos = doc.positionAt(offset);
	let stateRange: { start: Position; end: Position } | undefined;
	for (const d of analysis.decls) {
		if (d.kind !== 'state') continue;
		if (inRange(pos, d.range)) { stateRange = d.range; break; }
	}
	if (!stateRange) return { inStateTopLevel: false };
	for (const d of analysis.decls) {
		if (d.kind !== 'event') continue;
		if (inRange(pos, d.range)) return { inStateTopLevel: false };
	}
	return { inStateTopLevel: true, stateRange };
}

export function resolveCompletion(item: CompletionItem): CompletionItem {
	// No-op; keep for docstring enrichment if needed
	return item;
}

export function lslSignatureHelp(doc: TextDocument, params: { textDocument: { uri: string }, position: Position }, defs: Defs, analysis: Analysis): SignatureHelp | null {
	// Try AST-based context first; if null, attempt a small text fallback to catch edge cursors
	let ctx = findCallContextFromAnalysis(analysis, params.position);
	if (!ctx) {
		const text = doc.getText();
		const off = doc.offsetAt(params.position);
		// Robust back-scan to find innermost enclosing call: track paren depth and skip strings/brackets
		let i = off - 1;
		let depth = 0;
		outer: while (i >= 0) {
			const ch = text[i] || '';
			// skip whitespace quickly
			if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r') { i--; continue; }
			// skip string literals (simple heuristics)
			if (ch === '"' || ch === '\'') {
				const quote = ch; i--;
				while (i >= 0) { if (text[i] === quote && text[i - 1] !== '\\') { i--; break; } i--; }
				continue;
			}
			// track nesting for ), ], }
			if (ch === ')' || ch === ']' || ch === '}') { depth++; i--; continue; }
			if (ch === '(') {
				if (depth === 0) {
					// Found the candidate call start; read identifier left of it
					let j = i - 1; let name = '';
					while (j >= 0 && /[A-Za-z0-9_]/.test(text[j]!)) { name = text[j] + name; j--; }
					if (name) {
						// Count commas from after '(' to the cursor, ignoring commas in nested parentheses
						let k = i + 1; let commas = 0; let nest = 0;
						while (k < off) {
							const c = text[k] || '';
							if (c === '"' || c === '\'') {
								const q = c; k++;
								while (k < off) { if (text[k] === q && text[k - 1] !== '\\') { k++; break; } k++; }
								continue;
							}
							if (c === '(') { nest++; k++; continue; }
							if (c === ')') { if (nest === 0) break; nest--; k++; continue; }
							if (c === ',' && nest === 0) { commas++; }
							k++;
						}
						ctx = { name, argIndex: Math.max(0, commas) };
					}
					break outer;
				}
				depth--; i--; continue;
			}
			i--;
		}
	}
	if (!ctx) return null;
	const overloads = defs.funcs.get(ctx.name);
	if (!overloads || overloads.length === 0) return null;

	const candidates = overloads.filter(fn => ctx.argIndex < fn.params.length);
	const chosen = (candidates.length > 0 ? candidates : overloads)[0];

	const expType = chosen.params[ctx.argIndex]?.type || 'any';
	const gotType = inferExprTypeFromText(doc, analysis, params.position) || 'any';
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


// token-less call context is derived from Analysis.calls in findCallContextFromAnalysis

// AST-based call context using Analysis.calls
function findCallContextFromAnalysis(analysis: Analysis, pos: Position): { name: string; argIndex: number } | null {
	let best: { name: string; argIndex: number; area: number } | null = null;
	for (const c of analysis.calls) {
		if (!inRange(pos, c.range)) continue;
		let idx = 0;
		for (let i = 0; i < c.argRanges.length; i++) {
			const r = c.argRanges[i];
			if (inRange(pos, r)) { idx = i; break; }
			if (docPositionCmp(pos, r.start) >= 0) idx = i;
		}
		const area = rangeArea(c.range);
		if (!best || area < best.area) best = { name: c.name, argIndex: idx, area };
	}
	if (!best) return null;
	return { name: best.name, argIndex: best.argIndex };
}

function rangeArea(r: { start: Position; end: Position }): number {
	return (r.end.line - r.start.line) * 1_000_000 + (r.end.character - r.start.character);
}

function docPositionCmp(a: Position, b: Position): number {
	if (a.line !== b.line) return a.line - b.line;
	return a.character - b.character;
}

function inferExprTypeFromText(doc: TextDocument, analysis: Analysis, pos: Position): string | null {
	// Heuristic: find the nearest call at pos and scan the arg substring for a leading token-like char
	const call = findCallContextFromAnalysis(analysis, pos);
	if (!call) return null;
	const full = analysis.calls.find(c => c.name === call.name && inRange(pos, c.range));
	if (!full) return null;
	const argR = full.argRanges[call.argIndex];
	if (!argR) return null;
	const text = doc.getText({ start: argR.start, end: argR.end }).trim();
	if (!text) return null;
	const ch = text[0];
	if (ch === '"') return 'string';
	if (ch === '<') return 'vector';
	if (ch === '[') return 'list';
	if (/^[+-]?\d/.test(text) || /^0x[0-9A-Fa-f]+/.test(text)) return text.includes('.') ? 'float' : 'integer';
	if (/^(TRUE|FALSE)\b/.test(text)) return 'integer';
	if (/^NULL_KEY\b/.test(text)) return 'key';
	// identifier: try to resolve local/param type
	const id = text.match(/^[A-Za-z_][A-Za-z0-9_]*/)?.[0];
	if (id) return resolveIdentifierTypeAt(id, analysis, doc, doc.offsetAt(argR.start)) || 'any';
	return null;
}

function typeMatches(expected: string, got: string): boolean {
	expected = normalizeType(expected);
	got = normalizeType(got);
	if (expected === 'any' || got === 'any') return true;
	if (expected === got) return true;
	if (expected === 'integer' && got === 'float') return true;
	if (expected === 'float' && got === 'integer') return true;
	if ((expected === 'key' && got === 'string') || (expected === 'string' && got === 'key')) return true;
	return false;
}

function dirnameOfDoc(doc: TextDocument): string {
	try {
		const u = new URL(doc.uri);
		if (u.protocol === 'file:') return path.dirname(decodeURIComponent(u.pathname));
	} catch { /* ignore */ }
	return path.dirname(doc.uri.replace(/^file:\/\//, ''));
}

// Simpler overload choice without token inference
function chooseBestOverloadAst(overloads: { params: { type: string }[] }[], ctx: { argIndex: number }) {
	if (!overloads || overloads.length === 0) return null as any;
	const candidates = overloads.filter(fn => ctx.argIndex < fn.params.length);
	const list = (candidates.length > 0 ? candidates : overloads)
		.slice().sort((a, b) => a.params.length - b.params.length);
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
	// Deduplicate by (label, kind)
	const seen = new Set<string>();
	const deduped: CompletionItem[] = [];
	for (const it of out) {
		const key = `${String(it.label)}#${it.kind ?? ''}`;
		if (seen.has(key)) continue;
		seen.add(key);
		const { _score, ...clean } = it as any;
		delete (clean as any)._itemType;
		deduped.push(clean);
	}
	return deduped;
}

// Extract the identifier left of the trailing '.' at offset
function findMemberBaseName(text: string, offset: number): string | null {
	let i = offset - 1;
	while (i > 0 && /\s/.test(text[i]!)) i--;
	if (text[i] !== '.') return null;
	let j = i - 1; let name = '';
	while (j >= 0 && /[A-Za-z0-9_]/.test(text[j]!)) { name = text[j] + name; j--; }
	return name || null;
}

function resolveIdentifierTypeAt(name: string, analysis: Analysis, doc: TextDocument, offset: number): string | undefined {
	let best: { type?: string; start: number } | null = null;
	for (const d of analysis.decls) {
		if ((d.kind === 'var' || d.kind === 'param') && d.name === name) {
			const s = doc.offsetAt(d.range.start);
			if (s <= offset && (!best || s > best.start)) best = { type: d.type, start: s };
		}
	}
	return best?.type;
}

function inRange(pos: Position, range: { start: Position; end: Position }): boolean {
	if (pos.line < range.start.line || pos.line > range.end.line) return false;
	if (pos.line === range.start.line && pos.character < range.start.character) return false;
	if (pos.line === range.end.line && pos.character > range.end.character) return false;
	return true;
}
