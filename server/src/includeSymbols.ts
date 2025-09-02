// Parser for include headers: extracts function/global/macro/state symbols and optional doc comments.
export type IncludeFunction = { name: string; returns: string; params: { type: string; name?: string }[]; line: number; col: number; endCol: number; doc?: string };
export type IncludeGlobal = { name: string; type: string; line: number; col: number; endCol: number; doc?: string };
export type IncludeMacro = { name: string; line: number; col: number; endCol: number };
export type IncludeInfo = {
  file: string;
  functions: Map<string, IncludeFunction>;
  globals: Map<string, IncludeGlobal>;
  macroObjs: Map<string, IncludeMacro>;
  macroFuncs: Map<string, IncludeMacro>;
  states: Set<string>;
};

type IncludeCacheEntry = { mtimeMs: number; info: IncludeInfo };
const includeSymbolsCache = new Map<string, IncludeCacheEntry>();

function cleanBlockDoc(raw: string): string {
	const lines = raw.split(/\r?\n/);
	const body = lines.map(l => l.replace(/^\s*\*\s?/, '').trimEnd());
	while (body.length && body[0].trim() === '') body.shift();
	while (body.length && body[body.length - 1].trim() === '') body.pop();
	return body.join('\n');
}

export function parseIncludeSymbols(file: string): IncludeInfo | null {
	try {
		const fs = require('node:fs') as typeof import('node:fs');
		const stat = fs.statSync(file);
		const mtimeMs = Number(stat?.mtimeMs ?? 0) || 0;
		const cached = includeSymbolsCache.get(file);
		if (cached && cached.mtimeMs === mtimeMs) return cached.info;
		const text = fs.readFileSync(file, 'utf8');
		const lines = text.split(/\r?\n/);
		const info: IncludeInfo = {
			file,
			functions: new Map(),
			globals: new Map(),
			macroObjs: new Map(),
			macroFuncs: new Map(),
			states: new Set(),
		};
		let pendingDoc: string | null = null;
		let braceDepth = 0;
		for (let i = 0; i < lines.length; i++) {
			const rawLine = lines[i]!;
			const L = rawLine;
			// Detect single-line block comment used as doc: /* ... */
			const mSingle = /^\s*\/\*([\s\S]*?)\*\/\s*$/.exec(L);
			if (mSingle) { pendingDoc = cleanBlockDoc(mSingle[1] || ''); continue; }
			// Detect start of multiline block doc /** ... */ accumulating until end
			if (/^\s*\/\*/.test(L) && !/\*\//.test(L)) {
				let body = L.replace(/^\s*\/\*/, '');
				let j = i + 1;
				for (; j < lines.length; j++) { const ln = lines[j]!; body += '\n' + ln; if (/\*\//.test(ln)) { j++; break; } }
				i = j - 1;
				body = body.replace(/\*\/\s*$/, '');
				pendingDoc = cleanBlockDoc(body);
				continue;
			}
			// Strip line comments for matching, but keep for macro line position
			const noLineComments = L.replace(/\/\/.*$/, '');
			// Macros (object-like)
			let m = /^\s*#\s*define\s+([A-Za-z_]\w*)(?!\s*\()/.exec(L);
			if (m) { const name = m[1]!; const col = L.indexOf(name); info.macroObjs.set(name, { name, line: i, col: col >= 0 ? col : 0, endCol: (col >= 0 ? col + name.length : 0) }); pendingDoc = null; continue; }
			// Macros (function-like)
			m = /^\s*#\s*define\s+([A-Za-z_]\w*)\s*\(.*\)/.exec(L);
			if (m) { const name = m[1]!; const col = L.indexOf(name); info.macroFuncs.set(name, { name, line: i, col: col >= 0 ? col : 0, endCol: (col >= 0 ? col + name.length : 0) }); pendingDoc = null; continue; }
			if (braceDepth === 0) {
				// States
				const st = /^\s*state\s+([A-Za-z_]\w*)\b/.exec(noLineComments); if (st) { info.states.add(st[1]!); }
				// Globals: [const] type name [= expr] ;
				const gg = /^\s*(?:const\s+)?([A-Za-z_]\w+)\s+([A-Za-z_]\w+)\s*(?:=|;)\s*/.exec(noLineComments);
				if (gg) {
					const type = gg[1]!; const name = gg[2]!; const col = L.indexOf(name);
					const g: IncludeGlobal = { name, type, line: i, col: col >= 0 ? col : 0, endCol: (col >= 0 ? col + name.length : 0) };
					if (pendingDoc && pendingDoc.trim()) g.doc = pendingDoc;
					info.globals.set(name, g); pendingDoc = null; continue;
				}
				// Function headers: returnType name(params) followed by ; or { or EOL
				const ff = /^\s*([A-Za-z_]\w*)\s+([A-Za-z_]\w*)\s*\(([^)]*)\)\s*(?:[;{]|$)/.exec(noLineComments);
				if (ff) {
					const returns = ff[1]!; const name = ff[2]!; const rawParams = (ff[3] || '').trim();
					const params: { type: string; name?: string }[] = [];
					if (rawParams.length > 0) {
						for (const piece of rawParams.split(',')) {
							const p = piece.trim().replace(/\s+/g, ' ');
							const parts = p.split(' ');
							const ty = parts[0] || 'any'; const pn = parts[1];
							params.push(pn ? { type: ty, name: pn } : { type: ty });
						}
					}
					const col = L.indexOf(name);
					const f: IncludeFunction = { name, returns, params, line: i, col: col >= 0 ? col : 0, endCol: (col >= 0 ? col + name.length : 0) };
					if (pendingDoc && pendingDoc.trim()) f.doc = pendingDoc;
					info.functions.set(name, f); pendingDoc = null; continue;
				}
			}
			for (let k = 0; k < noLineComments.length; k++) { const ch = noLineComments[k]!; if (ch === '{') braceDepth++; else if (ch === '}') braceDepth = Math.max(0, braceDepth - 1); }
		}
		includeSymbolsCache.set(file, { mtimeMs, info });
		return info;
	} catch { return null; }
}
