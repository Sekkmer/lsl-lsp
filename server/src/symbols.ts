import { DocumentSymbol, Location, Position, SymbolKind } from 'vscode-languageserver/node';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { Analysis } from './analysisTypes';
import type { Defs } from './defs';
import type { PreprocResult } from './core/preproc';
import { resolveSymbolAt, scanIncludesForSymbol } from './resolver';
import path from 'node:path';
import { URI } from 'vscode-uri';

export function documentSymbols(a: Analysis): DocumentSymbol[] {
	const states: Map<string, DocumentSymbol> = new Map();
	const top: DocumentSymbol[] = [];

	// First pass: create state symbols
	for (const d of a.decls) {
		if (d.kind === 'state') {
			const sym = DocumentSymbol.create(
				d.name,
				undefined,
				SymbolKind.Namespace,
				d.range,
				d.range,
				[]
			);
			states.set(d.name, sym);
			top.push(sym);
		}
	}
	// Second pass: add events under their states (best-effort by proximity: find nearest preceding state decl)
	let lastState: DocumentSymbol | null = null;
	for (const d of a.decls) {
		if (d.kind === 'state') {
			lastState = states.get(d.name) || null;
			continue;
		}
		if (d.kind === 'event') {
			const name = `${d.name}(${(d.params || []).map(p => p.name).join(', ')})`;
			const ev = DocumentSymbol.create(name, undefined, SymbolKind.Event, d.range, d.range);
			if (lastState) {
				(lastState.children ||= []).push(ev);
			} else {
				top.push(ev);
			}
			continue;
		}
	}
	// Remaining decls (functions, variables, params) as top-level for now
	for (const d of a.decls) {
		if (d.kind === 'state' || d.kind === 'event') continue;
		const kind = d.kind === 'func' ? SymbolKind.Function : (d.kind === 'param' ? SymbolKind.Variable : SymbolKind.Variable);
		const name = d.kind === 'func' ? `${d.name}(${(d.params || []).map(p => p.name).join(', ')})` : d.name;
		top.push(DocumentSymbol.create(name, d.type ? d.type : undefined, kind, d.range, d.range));
	}
	return top;
}

export function gotoDefinition(doc: TextDocument, pos: Position, a: Analysis, pre?: PreprocResult, defs?: Defs): Location | null {
	const target = resolveSymbolAt(doc, pos, a, pre, defs);
	if (!target) return null;
	if ('uri' in target && 'range' in target) {
		return { uri: target.uri, range: target.range };
	}
	// Fallback: if no navigable target (builtin) but symbol present in includes as user prototype
	if (!('uri' in target) && pre) {
		// Identify word under cursor and verify it's followed by '('
		const text = doc.getText();
		const offset = doc.offsetAt(pos);
		const isWord = (ch: string) => /[A-Za-z0-9_]/.test(ch);
		let s = offset; while (s > 0 && isWord(text[s - 1]!)) s--;
		let e = offset; while (e < text.length && isWord(text[e]!)) e++;
		if (e > s) {
			const name = text.slice(s, e);
			// Only attempt if next non-space char is '(' (likely function call)
			let k = e; while (k < text.length && /[ \t]/.test(text[k]!)) k++;
			if (text[k] === '(') {
				const hit = scanIncludesForSymbol(name, pre);
				if (hit) {
					const uri = hit.file.startsWith('file://') ? hit.file : URI.file(path.resolve(hit.file)).toString();
					return { uri, range: { start: { line: hit.line, character: hit.startChar }, end: { line: hit.line, character: hit.endChar } } };
				}
			}
		}
	}
	return null;
}
