import { TextDocument } from 'vscode-languageserver-textdocument';
import { Range, TextEdit } from 'vscode-languageserver/node';
import type { Analysis } from './analysisTypes';
import type { PreprocResult } from './core/preproc';
import type { Token as LexToken } from './lexer';
import { isKeyword } from './ast/lexer';

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

export function prepareRename(
	doc: TextDocument,
	offset: number,
	analysis: Analysis,
	pre: PreprocResult,
): Range | null {
	const w = getWordAt(doc, offset);
	if (!w) return null;
	if (isKeyword(w.text)) return null;

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
	return null;
}

export function computeRenameEdits(
	doc: TextDocument,
	offset: number,
	newName: string,
	analysis: Analysis,
	pre: PreprocResult,
	tokens: ReadonlyArray<LexToken>
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
	if (!w) return { changes };
	const oldName = w.text;
	if (oldName === newName) return { changes };
	if (!/^[A-Za-z_]\w*$/.test(newName)) return { changes };
	if (isKeyword(newName)) return { changes };

	let targetDecl = analysis.symbolAt(offset);
	if (!targetDecl) {
		for (const r of analysis.refs) {
			const s = doc.offsetAt(r.range.start); const e = doc.offsetAt(r.range.end);
			if (offset >= s && offset <= e) { targetDecl = analysis.refAt(s) || null; break; }
		}
	}

	if (targetDecl) {
		addEditRange(doc.uri, targetDecl.range);
		for (const r of analysis.refs) {
			const s = doc.offsetAt(r.range.start);
			const target = analysis.refAt(s);
			if (target && target === targetDecl) addEditRange(doc.uri, r.range);
		}
		return { changes };
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
		return { changes };
	}

	// Fallback: rename the word under cursor in this document
	addEdit(doc.uri, w.start, w.end);
	return { changes };
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
			if (offset >= s && offset <= e) { targetDecl = analysis.refAt(s) || null; break; }
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
