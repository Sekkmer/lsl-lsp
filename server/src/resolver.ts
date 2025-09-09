import { Position, Range } from 'vscode-languageserver/node';
import { TextDocument } from 'vscode-languageserver-textdocument';
import type { Analysis } from './analysisTypes';
import type { Defs } from './defs';
import type { PreprocResult } from './core/preproc';
import { URI } from 'vscode-uri';
import fs from 'node:fs';
import path from 'node:path';

export type ResolvedTarget =
	| { kind: 'include-target'; uri: string; range: Range }
	| { kind: 'macro-obj' | 'macro-func'; name: string; uri: string; range: Range; from: 'local' | 'include' }
	| { kind: 'function' | 'global' | 'state' | 'event' | 'var' | 'param'; name: string; uri: string; range: Range; from: 'local' | 'include' }
	| { kind: 'builtin-func' | 'builtin-const' | 'keyword' | 'type'; name: string };

// Simple one-run cache of include file contents -> lines for definition scanning
const includeFileCache: Map<string, { mtimeMs: number; lines: string[]; text: string }> = new Map();

function readIncludeFileLines(file: string): string[] {
	try {
		const stat = fs.statSync(file);
		const mtimeMs = Number(stat.mtimeMs) || 0;
		const cached = includeFileCache.get(file);
		if (cached && cached.mtimeMs === mtimeMs) return cached.lines;
		const text = fs.readFileSync(file, 'utf8');
		const lines = text.split(/\r?\n/);
		includeFileCache.set(file, { mtimeMs, lines, text });
		return lines;
	} catch { return []; }
}

export interface ExternalDefHit { file: string; line: number; startChar: number; endChar: number; kind: ResolvedTarget['kind']; }

export function scanIncludesForSymbol(name: string, pre?: PreprocResult): ExternalDefHit | null {
	if (!pre || !pre.includeTargets || !name) return null;
	const queue: string[] = [];
	const seen = new Set<string>();
	for (const t of pre.includeTargets) { const f = t.resolved || t.file; if (f) queue.push(f); }
	const MAX = 16; let depth = 0;
	while (queue.length && depth < MAX) {
		const file = queue.shift()!; if (seen.has(file)) { depth++; continue; }
		seen.add(file);
		// TEMP DEBUG: log traversal for transitive include resolution in tests
		try { if (process.env.LSL_LSP_DEBUG_XINCS) console.log('[scanIncludes]', name, 'visiting', file); } catch { /* ignore */ }
		const lines = readIncludeFileLines(file);
		for (let i = 0; i < lines.length; i++) {
			const L = lines[i]!;
			// Discover further includes transitively
			const inc = /^\s*#\s*include\s+["<]([^">]+)[">]/.exec(L);
			if (inc) {
				const target = inc[1];
				const candidate = path.isAbsolute(target) ? target : path.join(path.dirname(file), target);
				try { if (process.env.LSL_LSP_DEBUG_XINCS) console.log('  include ->', candidate); } catch { /* ignore */ }
				if (!seen.has(candidate) && fs.existsSync(candidate)) queue.push(candidate);
			}
			// Macro definition
			const mMacro = /^\s*#\s*define\s+([A-Za-z_]\w*)/.exec(L);
			if (mMacro && mMacro[1] === name) {
				try { if (process.env.LSL_LSP_DEBUG_XINCS) console.log('  FOUND macro', name, 'in', file, 'line', i); } catch { /* ignore */ }
				const col = L.indexOf(name);
				return { file, line: i, startChar: col, endChar: col + name.length, kind: (/\w+\s*\(/.test(L) ? 'macro-func' : 'macro-obj') } as ExternalDefHit;
			}
			// Function prototype/definition
			const funcRe = new RegExp(`(^|[^A-Za-z0-9_])([A-Za-z_]\\w*)\\s+(${name})\\s*\\(`);
			const fm = funcRe.exec(L);
			if (fm) {
				try { if (process.env.LSL_LSP_DEBUG_XINCS) console.log('  FOUND function', name, 'in', file, 'line', i); } catch { /* ignore */ }
				const col = L.indexOf(name, fm.index);
				if (col >= 0) return { file, line: i, startChar: col, endChar: col + name.length, kind: 'function' } as ExternalDefHit;
			}
			// Global variable
			const gvRe = new RegExp(`(^|[^A-Za-z0-9_])([A-Za-z_]\\w*)\\s+(${name})(?=\\n|[ \t]*[=;])`);
			const gvm = gvRe.exec(L);
			if (gvm && !/\(\s*$/.test(L.slice(gvm.index))) {
				try { if (process.env.LSL_LSP_DEBUG_XINCS) console.log('  FOUND global', name, 'in', file, 'line', i); } catch { /* ignore */ }
				const col = L.indexOf(name, gvm.index);
				if (col >= 0) return { file, line: i, startChar: col, endChar: col + name.length, kind: 'global' } as ExternalDefHit;
			}
		}
		depth++;
	}
	return null;
}

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
	try { if (process.env.LSL_LSP_DEBUG_XINCS) console.log('[resolveSymbolAt] pos', pos.line, pos.character); } catch { /* ignore */ }

	// If on an #include target, navigate to the resolved file
	if (pre && pre.includeTargets) {
		for (const it of pre.includeTargets) {
			if (offset >= it.start && offset <= it.end && it.resolved) {
				return { kind: 'include-target', uri: URI.file(it.resolved).toString(), range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } } };
			}
		}
	}

	// Attempt to derive word early for cross-include scan (helps cases where symbol not in refs yet, e.g., macro usage)
	let earlyWord: string | null = null;
	{
		const w = wordAt(doc, pos);
		if (w) earlyWord = w[2];
	}
	if (earlyWord && pre && pre.includeTargets && pre.includeTargets.length) {
		try { if (process.env.LSL_LSP_DEBUG_XINCS) console.log('[resolveSymbolAt] very-early include scan', earlyWord); } catch { /* ignore */ }
		const veryEarly = scanIncludesForSymbol(earlyWord, pre);
		if (veryEarly) {
			const uri = veryEarly.file.startsWith('file://') ? veryEarly.file : URI.file(path.resolve(veryEarly.file)).toString();
			return { kind: veryEarly.kind as ResolvedTarget['kind'], name: earlyWord, uri, range: { start: { line: veryEarly.line, character: veryEarly.startChar }, end: { line: veryEarly.line, character: veryEarly.endChar } }, from: 'include' };
		}
	}

	// If cursor is on a declaration name, jump to it (noop navigation)
	const atDecl = analysis.symbolAt(offset);
	if (atDecl) {
		try { if (process.env.LSL_LSP_DEBUG_XINCS) console.log('[resolveSymbolAt] atDecl', atDecl.name, atDecl.kind, 'declStart', atDecl.range.start, 'pos', pos); } catch { /* ignore */ }
		// Only accept if the cursor sits on the identifier token itself (start char .. start char + name.length)
		if (atDecl.range.start.line === pos.line) {
			const idStartChar = atDecl.range.start.character;
			const idEndChar = idStartChar + atDecl.name.length;
			if (pos.character >= idStartChar && pos.character <= idEndChar) {
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
		}
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
	try { if (process.env.LSL_LSP_DEBUG_XINCS) console.log('[resolveSymbolAt] refName', refName); } catch { /* ignore */ }
	if (!refName) return null;

	// Cross-include lookup early for macros/functions/globals before treating as builtin to avoid shadowing by builtins
	if (pre && pre.includeTargets && pre.includeTargets.length) {
		try { if (process.env.LSL_LSP_DEBUG_XINCS) console.log('[resolveSymbolAt] early cross-include scan', refName); } catch { /* ignore */ }
		const earlyHit = scanIncludesForSymbol(refName, pre);
		if (earlyHit) {
			const uri = earlyHit.file.startsWith('file://') ? earlyHit.file : URI.file(path.resolve(earlyHit.file)).toString();
			return { kind: earlyHit.kind as ResolvedTarget['kind'], name: refName, uri, range: { start: { line: earlyHit.line, character: earlyHit.startChar }, end: { line: earlyHit.line, character: earlyHit.endChar } }, from: 'include' };
		}
	}
	// Built-ins: treat as non-navigable targets (after include scan to allow user prototypes to override)
	if (defs && (defs.funcs.has(refName) || defs.consts.has(refName))) {
		try { if (process.env.LSL_LSP_DEBUG_XINCS) console.log('[resolveSymbolAt] builtin hit', refName); } catch { /* ignore */ }
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

	// Late cross-include scan (should rarely hit now) in case macros table indicated local but search missed
	if (pre && pre.includeTargets && pre.includeTargets.length) {
		try { if (process.env.LSL_LSP_DEBUG_XINCS) console.log('[resolveSymbolAt] cross-include scan (late)', refName); } catch { /* ignore */ }
		const hit = scanIncludesForSymbol(refName, pre);
		if (hit) {
			const uri = hit.file.startsWith('file://') ? hit.file : URI.file(path.resolve(hit.file)).toString();
			return { kind: hit.kind as ResolvedTarget['kind'], name: refName, uri, range: { start: { line: hit.line, character: hit.startChar }, end: { line: hit.line, character: hit.endChar } }, from: 'include' };
		}
	}

	return null;
}
