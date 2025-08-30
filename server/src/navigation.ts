import { TextDocument } from 'vscode-languageserver-textdocument';
import { Range, TextEdit } from 'vscode-languageserver/node';
import { URI } from 'vscode-uri';
import type { Analysis } from './analysisTypes';
import type { PreprocResult } from './preproc';
import type { Defs } from './defs';

export type SimpleToken = { kind: string; value: string; start: number; end: number };

export function getWordAt(doc: TextDocument, offset: number): { start: number; end: number; text: string } | null {
	const text = doc.getText();
	if (offset < 0 || offset > text.length) return null;
	const isWord = (ch: string) => /[A-Za-z0-9_]/.test(ch);
	let s = offset; let e = offset;
	while (s > 0 && isWord(text[s - 1]!)) s--;
	while (e < text.length && isWord(text[e]!)) e++;
	if (e <= s) return null;
	const w = text.slice(s, e);
	if (!/^[A-Za-z_]\w*$/.test(w)) return null;
	return { start: s, end: e, text: w };
}

export function isReservedIdentifier(defs: Defs | null, name: string): boolean {
	if (!defs) return false;
	if (name === 'event') return true;
	return defs.keywords.has(name) || defs.types.has(name);
}

export function prepareRename(
	doc: TextDocument,
	offset: number,
	analysis: Analysis,
	pre: PreprocResult,
	defs: Defs | null
): Range | null {
	const w = getWordAt(doc, offset);
	if (!w) return null;
	if (isReservedIdentifier(defs, w.text)) return null;

	const atDecl = analysis.symbolAt(offset);
	if (atDecl && doc.offsetAt(atDecl.range.start) <= offset && offset <= doc.offsetAt(atDecl.range.end)) {
		return atDecl.range;
	}
	for (const r of analysis.refs) {
		const s = doc.offsetAt(r.range.start); const e = doc.offsetAt(r.range.end);
		if (offset >= s && offset <= e) {
			const target = analysis.refAt(s);
			if (target) return r.range;
			break;
		}
	}
	const name = w.text;
	const isMacro = Object.prototype.hasOwnProperty.call(pre.macros, name) || Object.prototype.hasOwnProperty.call(pre.funcMacros, name);
	if (isMacro) return { start: doc.positionAt(w.start), end: doc.positionAt(w.end) };
	if (pre.includeSymbols && pre.includes && pre.includes.length > 0) {
		let found = 0;
		for (const file of pre.includes) {
			const info = pre.includeSymbols.get(file);
			if (!info) continue;
			if (info.functions.has(name) || info.globals.has(name) || info.macroObjs.has(name) || info.macroFuncs.has(name)) found++;
		}
		if (found === 1) return { start: doc.positionAt(w.start), end: doc.positionAt(w.end) };
	}
	return null;
}

export function computeRenameEdits(
	doc: TextDocument,
	offset: number,
	newName: string,
	analysis: Analysis,
	pre: PreprocResult,
	defs: Defs | null,
	tokens: SimpleToken[]
): { changes: Record<string, TextEdit[]> } {
	const changes: Record<string, TextEdit[]> = {};
	const addEdit = (uri: string, start: number, end: number) => {
		const arr = (changes[uri] ||= []);
		arr.push({ range: { start: doc.positionAt(start), end: doc.positionAt(end) }, newText: newName });
	};
	const addEditRange = (uri: string, range: Range, baseDoc?: TextDocument) => {
		const arr = (changes[uri] ||= []);
		const posDoc = baseDoc || doc;
		arr.push({ range: { start: posDoc.positionAt(posDoc.offsetAt(range.start)), end: posDoc.positionAt(posDoc.offsetAt(range.end)) }, newText: newName });
	};

	const w = getWordAt(doc, offset);
	if (!w) return { changes } as any;
	const oldName = w.text;
	if (oldName === newName) return { changes } as any;
	if (!/^[A-Za-z_]\w*$/.test(newName)) return { changes } as any;
	if (isReservedIdentifier(defs, newName)) return { changes } as any;

	let targetDecl = analysis.symbolAt(offset);
	if (!targetDecl) {
		for (const r of analysis.refs) {
			const s = doc.offsetAt(r.range.start); const e = doc.offsetAt(r.range.end);
			if (offset >= s && offset <= e) { targetDecl = analysis.refAt(s) || null as any; break; }
		}
	}

	if (targetDecl) {
		addEditRange(doc.uri, targetDecl.range);
		for (const r of analysis.refs) {
			const s = doc.offsetAt(r.range.start);
			const target = analysis.refAt(s);
			if (target && target === targetDecl) addEditRange(doc.uri, r.range);
		}
		return { changes } as any;
	}

	const isMacro = Object.prototype.hasOwnProperty.call(pre.macros, oldName) || Object.prototype.hasOwnProperty.call(pre.funcMacros, oldName);
	if (isMacro) {
		for (const t of tokens) {
			if (t.kind === 'id' && t.value === oldName) {
				const resolved = analysis.refAt(t.start);
				if (!resolved) addEdit(doc.uri, t.start, t.end);
			}
		}
		const text = doc.getText();
		const lines = text.split(/\r?\n/);
		let running = 0;
		for (const L of lines) {
			const m = /^\s*#\s*define\s+([A-Za-z_]\w*)/.exec(L);
			if (m && m[1] === oldName) {
				const idx = L.indexOf(oldName);
				if (idx >= 0) addEdit(doc.uri, running + idx, running + idx + oldName.length);
			}
			running += L.length + 1;
		}
		if (pre.includeSymbols && pre.includes && pre.includes.length > 0) {
			for (const file of pre.includes) {
				const info = pre.includeSymbols.get(file);
				if (!info) continue;
				const mo = info.macroObjs.get(oldName);
				const mf = info.macroFuncs.get(oldName);
				const hit = mo || mf;
				if (hit) {
					const uri = URI.file(file).toString();
					const start = { line: hit.line, character: hit.col };
					const end = { line: hit.line, character: hit.endCol };
					(changes[uri] ||= []).push({ range: { start, end }, newText: newName });
					break;
				}
			}
		}
		return { changes } as any;
	}

	if (pre.includeSymbols && pre.includes && pre.includes.length > 0) {
		let chosen: { file: string; line: number; col: number; endCol: number } | null = null;
		for (const file of pre.includes) {
			const info = pre.includeSymbols.get(file);
			if (!info) continue;
			const fn = info.functions.get(oldName);
			const g = info.globals.get(oldName);
			const hit = fn ? { file, line: fn.line, col: fn.col, endCol: fn.endCol } : (g ? { file, line: g.line, col: g.col, endCol: g.endCol } : null);
			if (hit) { chosen = hit; break; }
		}
		if (chosen) {
			const uri = URI.file(chosen.file).toString();
			(changes[uri] ||= []).push({ range: { start: { line: chosen.line, character: chosen.col }, end: { line: chosen.line, character: chosen.endCol } }, newText: newName });
			for (const t of tokens) {
				if (t.kind === 'id' && t.value === oldName) {
					const resolved = analysis.refAt(t.start);
					if (!resolved) addEdit(doc.uri, t.start, t.end);
				}
			}
			return { changes } as any;
		}
	}

	// Fallback: rename the word under cursor in this document
	addEdit(doc.uri, w.start, w.end);
	return { changes } as any;
}

export function findAllReferences(
	doc: TextDocument,
	offset: number,
	includeDecl: boolean,
	analysis: Analysis,
	pre: PreprocResult,
	tokens: SimpleToken[]
): { uri: string; range: Range }[] {
	const out: { uri: string; range: Range }[] = [];
	const pushLoc = (uri: string, range: Range) => { out.push({ uri, range }); };

	let targetDecl = analysis.symbolAt(offset);
	if (!targetDecl) {
		for (const r of analysis.refs) {
			const s = doc.offsetAt(r.range.start); const e = doc.offsetAt(r.range.end);
			if (offset >= s && offset <= e) { targetDecl = analysis.refAt(s) || null as any; break; }
		}
	}

	if (targetDecl) {
		if (includeDecl) pushLoc(doc.uri, targetDecl.range);
		for (const r of analysis.refs) {
			const s = doc.offsetAt(r.range.start);
			const t = analysis.refAt(s);
			if (t && t === targetDecl) pushLoc(doc.uri, r.range);
		}
		return out;
	}

	const w = getWordAt(doc, offset);
	if (!w) return out;
	const name = w.text;

	const isMacro = Object.prototype.hasOwnProperty.call(pre.macros, name) || Object.prototype.hasOwnProperty.call(pre.funcMacros, name);
	if (isMacro) {
		if (includeDecl) {
			const text = doc.getText();
			const lines = text.split(/\r?\n/);
			let running = 0;
			for (const L of lines) {
				const m = /^\s*#\s*define\s+([A-Za-z_]\w*)/.exec(L);
				if (m && m[1] === name) {
					const idx = L.indexOf(name);
					if (idx >= 0) pushLoc(doc.uri, { start: doc.positionAt(running + idx), end: doc.positionAt(running + idx + name.length) });
				}
				running += L.length + 1;
			}
			if (pre.includeSymbols && pre.includes) {
				for (const file of pre.includes) {
					const info = pre.includeSymbols.get(file);
					if (!info) continue;
					const mo = info.macroObjs.get(name);
					const mf = info.macroFuncs.get(name);
					const hit = mo || mf;
					if (hit) out.push({ uri: URI.file(file).toString(), range: { start: { line: hit.line, character: hit.col }, end: { line: hit.line, character: hit.endCol } } });
				}
			}
		}
		for (const t of tokens) {
			if (t.kind === 'id' && t.value === name) {
				const resolved = analysis.refAt(t.start);
				if (!resolved) pushLoc(doc.uri, { start: doc.positionAt(t.start), end: doc.positionAt(t.end) });
			}
		}
		return out;
	}

	if (pre.includeSymbols && pre.includes) {
		for (const file of pre.includes) {
			const info = pre.includeSymbols.get(file);
			if (!info) continue;
			const fn = info.functions.get(name);
			const g = info.globals.get(name);
			const hit = fn ? { line: fn.line, col: fn.col, endCol: fn.endCol } : (g ? { line: g.line, col: g.col, endCol: g.endCol } : null);
			if (hit && includeDecl) out.push({ uri: URI.file(file).toString(), range: { start: { line: hit.line, character: hit.col }, end: { line: hit.line, character: hit.endCol } } });
		}
		for (const t of tokens) {
			if (t.kind === 'id' && t.value === name) {
				const resolved = analysis.refAt(t.start);
				if (!resolved) pushLoc(doc.uri, { start: doc.positionAt(t.start), end: doc.positionAt(t.end) });
			}
		}
		return out;
	}

	return out;
}
