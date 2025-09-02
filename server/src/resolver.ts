import { Position, Range } from 'vscode-languageserver/node';
import { TextDocument } from 'vscode-languageserver-textdocument';
import type { Analysis } from './analysisTypes';
import type { Defs } from './defs';
import type { PreprocResult } from './core/preproc';
import { URI } from 'vscode-uri';

export type ResolvedTarget =
	| { kind: 'include-target'; uri: string; range: Range }
	| { kind: 'macro-obj' | 'macro-func'; name: string; uri: string; range: Range; from: 'local' | 'include' }
	| { kind: 'function' | 'global' | 'state' | 'event' | 'var' | 'param'; name: string; uri: string; range: Range; from: 'local' | 'include' }
	| { kind: 'builtin-func' | 'builtin-const' | 'keyword' | 'type'; name: string };

/** Get the identifier under the cursor as [startOffset, endOffset, word] or null. */
function wordAt(doc: TextDocument, pos: Position): [number, number, string] | null {
	const offset = doc.offsetAt(pos);
	const text = doc.getText();
	const isWord = (ch: string) => /[A-Za-z0-9_]/.test(ch);
	let s = offset;
	let e = offset;
	while (s > 0 && isWord(text[s - 1]!)) s--;
	while (e < text.length && isWord(text[e]!)) e++;
	if (e > s) {
		const w = text.slice(s, e);
		if (/^[A-Za-z_]\w*$/.test(w)) return [s, e, w];
	}
	return null;
}

/** Resolve the best definition target at the given position, unifying hover/gotoDefinition logic. */
export function resolveSymbolAt(
	doc: TextDocument,
	pos: Position,
	analysis: Analysis,
	pre?: PreprocResult,
	defs?: Defs
): ResolvedTarget | null {
	const offset = doc.offsetAt(pos);

	// If on an #include target, navigate to the resolved file
	if (pre && pre.includeTargets) {
		for (const it of pre.includeTargets) {
			if (offset >= it.start && offset <= it.end && it.resolved) {
				return { kind: 'include-target', uri: URI.file(it.resolved).toString(), range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } } };
			}
		}
	}

	// If cursor is on a declaration name, jump to it (noop navigation)
	const atDecl = analysis.symbolAt(offset);
	if (atDecl) {
		const mapKind = (k: typeof atDecl.kind): ResolvedTarget['kind'] => {
			switch (k) {
				case 'func': return 'function';
				case 'var': return 'var';
				case 'param': return 'param';
				case 'state': return 'state';
				case 'event': return 'event';
			}
		};
		return { kind: mapKind(atDecl.kind), name: atDecl.name, uri: doc.uri, range: atDecl.range, from: 'local' };
	}

	// Try to find a recorded reference covering the cursor
	let refName: string | null = null;
	for (const r of analysis.refs) {
		const s = doc.offsetAt(r.range.start); const e = doc.offsetAt(r.range.end);
		if (offset >= s && offset <= e) { refName = r.name; break; }
	}
	// Fallback to word under cursor
	if (!refName) {
		const w = wordAt(doc, pos);
		if (w) refName = w[2];
	}
	if (!refName) return null;

	// Built-ins: treat as non-navigable targets
	if (defs && (defs.funcs.has(refName) || defs.consts.has(refName))) {
		if (defs.funcs.has(refName)) return { kind: 'builtin-func', name: refName };
		if (defs.consts.has(refName)) return { kind: 'builtin-const', name: refName };
	}

	// Local states/functions/vars/params: choose nearest declaration before this offset
	{
		let best: Analysis['decls'][number] | null = null;
		let bestStart = -1;
		for (const d of analysis.decls) {
			const isSupported = d.kind === 'var' || d.kind === 'param' || d.kind === 'func' || d.kind === 'state' || d.kind === 'event';
			if (isSupported && d.name === refName) {
				const s = doc.offsetAt(d.range.start);
				if (s <= offset && s > bestStart) { best = d; bestStart = s; }
			}
		}
		if (best) {
			const k = best.kind === 'func' ? 'function' : (best.kind as 'state' | 'event' | 'var' | 'param');
			return { kind: k, name: refName, uri: doc.uri, range: best.range, from: 'local' };
		}
	}

	// Local macros: scan this document
	if (pre && (pre.macros?.[refName] !== undefined || pre.funcMacros?.[refName] !== undefined)) {
		const text = doc.getText();
		if (text.includes('#define')) {
			const lines = text.split(/\r?\n/);
			let running = 0;
			for (const L of lines) {
				const m = /^\s*#\s*define\s+([A-Za-z_]\w*)/.exec(L);
				if (m && m[1] === refName) {
					const nameIdxInLine = L.indexOf(refName);
					const s = running + (nameIdxInLine >= 0 ? nameIdxInLine : 0);
					const e = s + refName.length;
					const range = { start: doc.positionAt(s), end: doc.positionAt(e) };
					const kind: 'macro-obj' | 'macro-func' = pre.funcMacros?.[refName] !== undefined ? 'macro-func' : 'macro-obj';
					return { kind, name: refName, uri: doc.uri, range, from: 'local' };
				}
				running += L.length + 1;
			}
		}
	}

	// Include-provided symbols: macros, functions, globals
	if (pre && pre.includeSymbols && pre.includeSymbols.size > 0) {
		for (const [file, info] of pre.includeSymbols) {
			if (!info) continue;
			// macros first
			const mo = info.macroObjs.get(refName);
			if (mo) {
				return { kind: 'macro-obj', name: refName, uri: URI.file(file).toString(), range: { start: { line: mo.line, character: mo.col }, end: { line: mo.line, character: mo.endCol } }, from: 'include' };
			}
			const mf = info.macroFuncs.get(refName);
			if (mf) {
				return { kind: 'macro-func', name: refName, uri: URI.file(file).toString(), range: { start: { line: mf.line, character: mf.col }, end: { line: mf.line, character: mf.endCol } }, from: 'include' };
			}
			// functions/globals
			const fn = info.functions.get(refName);
			if (fn) {
				return { kind: 'function', name: refName, uri: URI.file(file).toString(), range: { start: { line: fn.line, character: fn.col }, end: { line: fn.line, character: fn.endCol } }, from: 'include' };
			}
			const g = info.globals.get(refName);
			if (g) {
				return { kind: 'global', name: refName, uri: URI.file(file).toString(), range: { start: { line: g.line, character: g.col }, end: { line: g.line, character: g.endCol } }, from: 'include' };
			}
		}
	}

	return null;
}
