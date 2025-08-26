import { DocumentSymbol, Location, Position, Range, SymbolKind } from 'vscode-languageserver/node';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { Analysis } from './parser';
import type { Defs } from './defs';
import { PreprocResult } from './preproc';
import { URI } from 'vscode-uri';

export function documentSymbols(a: Analysis): DocumentSymbol[] {
	const out: DocumentSymbol[] = [];
	for (const d of a.decls) {
		const kind =
			d.kind === 'func' ? SymbolKind.Function :
				d.kind === 'state' ? SymbolKind.Namespace :
					d.kind === 'event' ? SymbolKind.Event :
						d.kind === 'param' ? SymbolKind.Variable :
							SymbolKind.Variable;

		const name = d.kind === 'func' ? `${d.name}(${(d.params || []).map(p=>p.name).join(', ')})` : d.name;

		out.push(DocumentSymbol.create(
			name,
			d.type ? d.type : undefined,
			kind,
			d.range,
			d.range
		));
	}
	return out;
}

export function gotoDefinition(doc: TextDocument, pos: Position, a: Analysis, pre?: PreprocResult, defs?: Defs): Location | null {
	const offset = doc.offsetAt(pos);
	// If on an #include target, navigate to the resolved file
	if (pre && pre.includeTargets) {
		for (const it of pre.includeTargets) {
			if (offset >= it.start && offset <= it.end && it.resolved) {
				return { uri: URI.file(it.resolved).toString(), range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } } };
			}
		}
	}
	// If cursor is on a declaration name, jump to it (noop navigation)
	const atDecl = a.symbolAt(offset);
	if (atDecl) return { uri: doc.uri, range: atDecl.range };

	// Find the identifier reference covering the cursor
	let refName: string | null = null;
	for (const r of a.refs) {
		const s = doc.offsetAt(r.range.start); const e = doc.offsetAt(r.range.end);
		if (offset >= s && offset <= e) { refName = r.name; break; }
	}
	// Fallback: if parser didn't record a ref (e.g., macros/known-non-vars), pick the word under the cursor
	if (!refName) {
		const text = doc.getText();
		const isWord = (ch: string) => /[A-Za-z0-9_]/.test(ch);
		let s = offset; let e = offset;
		while (s > 0 && isWord(text[s - 1]!)) s--;
		while (e < text.length && isWord(text[e]!)) e++;
		if (e > s) {
			const w = text.slice(s, e);
			if (/^[A-Za-z_]\w*$/.test(w)) refName = w;
		}
	}

	if (refName) {
		// If it's a macro, prefer macro resolution paths first
		if (pre && (Object.prototype.hasOwnProperty.call(pre.macros, refName) || Object.prototype.hasOwnProperty.call(pre.funcMacros, refName))) {
			// 3.5) Macros defined in this document: find #define refName
			{
				const text = doc.getText();
				if (text.includes('#define')) {
					const lines = text.split(/\r?\n/);
					let running = 0; // offset of line start
					for (const L of lines) {
						const m = /^\s*#\s*define\s+([A-Za-z_]\w*)/.exec(L);
						if (m && m[1] === refName) {
							const nameIdxInLine = L.indexOf(refName);
							const s = running + (nameIdxInLine >= 0 ? nameIdxInLine : 0);
							const e = s + refName.length;
							return { uri: doc.uri, range: { start: doc.positionAt(s), end: doc.positionAt(e) } };
						}
						running += L.length + 1;
					}
				}
			}
			// Macros from includes
			if (pre && pre.includeSymbols && pre.includes && pre.includes.length > 0) {
				for (const file of pre.includes) {
					const info = pre.includeSymbols.get(file);
					if (!info) continue;
					const mo = info.macroObjs.get(refName);
					if (mo) return { uri: URI.file(file).toString(), range: { start: { line: mo.line, character: mo.col }, end: { line: mo.line, character: mo.endCol } } };
					const mf = info.macroFuncs.get(refName);
					if (mf) return { uri: URI.file(file).toString(), range: { start: { line: mf.line, character: mf.col }, end: { line: mf.line, character: mf.endCol } } };
				}
			}
		}
		// 1) States: state <id>;
		const st = a.states.get(refName);
		if (st) return { uri: doc.uri, range: st.range };
		// 2) Functions declared in this document
		const f = a.functions.get(refName);
		if (f) return { uri: doc.uri, range: f.range };
		// 3) Variables/params: choose the nearest declaration before this offset
		let best: { range: Range } | null = null;
		let bestStart = -1;
		for (const d of a.decls) {
			if ((d.kind === 'var' || d.kind === 'param' || d.kind === 'func' || d.kind === 'state' || d.kind === 'event') && d.name === refName) {
				const s = doc.offsetAt(d.range.start);
				if (s <= offset && s > bestStart) { best = d; bestStart = s; }
			}
		}
		if (best) return { uri: doc.uri, range: best.range };
		// 3.2) If this is a built-in function or constant from defs, do not navigate
		if (defs && (defs.funcs.has(refName) || defs.consts.has(refName))) {
			return null;
		}
		// 3.5) Macros defined in this document: find #define refName
		{
			const text = doc.getText();
			if (text.includes('#define') && (pre?.macros?.[refName] !== undefined || pre?.funcMacros?.[refName] !== undefined)) {
				const lines = text.split(/\r?\n/);
				let running = 0; // offset of line start
				for (const L of lines) {
					const m = /^\s*#\s*define\s+([A-Za-z_]\w*)/.exec(L);
					if (m && m[1] === refName) {
						const nameIdxInLine = L.indexOf(refName);
						const s = running + (nameIdxInLine >= 0 ? nameIdxInLine : 0);
						const e = s + refName.length;
						return { uri: doc.uri, range: { start: doc.positionAt(s), end: doc.positionAt(e) } };
					}
					running += L.length + 1;
				}
			}
		}
		// 4) Include-provided symbols (functions/globals) with positions
		if (pre && pre.includeSymbols && pre.includes && pre.includes.length > 0) {
			for (const file of pre.includes) {
				const info = pre.includeSymbols.get(file);
				if (!info) continue;
				const fn = info.functions.get(refName);
				if (fn) {
		    	return { uri: URI.file(file).toString(), range: { start: { line: fn.line, character: fn.col }, end: { line: fn.line, character: fn.endCol } } };
				}
				const g = info.globals.get(refName);
				if (g) {
		    	return { uri: URI.file(file).toString(), range: { start: { line: g.line, character: g.col }, end: { line: g.line, character: g.endCol } } };
				}
				// Macros from includes
				const mo = info.macroObjs.get(refName);
				if (mo) {
					return { uri: URI.file(file).toString(), range: { start: { line: mo.line, character: mo.col }, end: { line: mo.line, character: mo.endCol } } };
				}
				const mf = info.macroFuncs.get(refName);
				if (mf) {
					return { uri: URI.file(file).toString(), range: { start: { line: mf.line, character: mf.col }, end: { line: mf.line, character: mf.endCol } } };
				}
			}
		}
		// 5) #define (object-like or function-like) in this document: scan lines for a matching define
		const text2 = doc.getText();
		if (text2.includes('#define')) {
			const lines = text2.split(/\r?\n/);
			let running2 = 0;
			for (const L of lines) {
				const m = /^\s*#\s*define\s+([A-Za-z_]\w*)/.exec(L);
				if (m && m[1] === refName) {
					const nameIdxInLine = L.indexOf(refName);
					const s = running2 + (nameIdxInLine >= 0 ? nameIdxInLine : 0);
					const e = s + refName.length;
					return { uri: doc.uri, range: { start: doc.positionAt(s), end: doc.positionAt(e) } };
				}
				running2 += L.length + 1;
			}
		}
	}

	return null;
}
