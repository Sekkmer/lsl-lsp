import { filePathToUri, fileUriToPath, type Position, type Range } from './protocol';
import type { TextDocument } from './protocol';
import type { Analysis } from './analysisTypes';
import type { Defs } from './defs';
import type { PreprocResult } from './core/preproc';

import fs from 'node:fs';
import path from 'node:path';

export type ResolvedTarget =
	| { kind: 'include-target'; uri: string; range: Range }
	| { kind: 'macro-obj' | 'macro-func'; name: string; uri: string; range: Range; from: 'local' | 'include' }
	| { kind: 'function' | 'global' | 'state' | 'event' | 'var' | 'param'; name: string; uri: string; range: Range; from: 'local' | 'include' }
	| { kind: 'builtin-func' | 'builtin-const' | 'keyword' | 'type'; name: string };

export interface ResolverOptions {
	filePathToUri?: (filePath: string) => string;
}

// Simple cache of include file contents -> lines for definition scanning.
const includeFileCache: Map<string, { lines: string[]; text: string }> = new Map();

function readIncludeFile(file: string): { lines: string[]; text: string } {
	try {
		const text = fs.readFileSync(file, 'utf8');
		const cached = includeFileCache.get(file);
		if (cached && cached.text === text) return cached;
		const lines = text.split(/\r?\n/);
		const entry = { lines, text };
		includeFileCache.set(file, entry);
		return entry;
	} catch { return { lines: [], text: '' }; }
}

export interface ExternalDefHit { file: string; line: number; startChar: number; endChar: number; kind: ResolvedTarget['kind']; }
export type ExternalDefKind = Extract<ExternalDefHit['kind'], 'macro-obj' | 'macro-func' | 'function' | 'global'>;

function lineOffsetsFor(text: string): number[] {
	const offsets: number[] = [];
	let offset = 0;
	for (const line of text.split(/\r?\n/)) {
		offsets.push(offset);
		offset += line.length;
		if (text[offset] === '\r' && text[offset + 1] === '\n') offset += 2;
		else if (text[offset] === '\n') offset += 1;
	}
	return offsets;
}

function hasActiveTokenOnLine(pre: PreprocResult, file: string, line: number, lineOffsets: number[], lines: string[]): boolean {
	const expanded = pre.expandedTokens;
	if (!expanded || expanded.length === 0) return true;
	const start = lineOffsets[line] ?? 0;
	const end = start + (lines[line]?.length ?? 0);
	return expanded.some(t => t.file === file && t.span.start >= start && t.span.start <= end);
}

function activeMacroDefineLine(pre: PreprocResult, name: string, file: string, lineOffsets: number[], lines: string[]): number | null {
	const def = pre.macroDefs?.[name];
	if (!def || def.file !== file) return null;
	const line = lineOffsets.findIndex((start, index) => {
		const end = start + (lines[index]?.length ?? 0);
		return def.start >= start && def.start <= end;
	});
	return line >= 0 ? line : null;
}

function stripComments(line: string, state: { inBlockComment: boolean }): string {
	let out = '';
	for (let i = 0; i < line.length;) {
		if (state.inBlockComment) {
			if (line[i] === '*' && line[i + 1] === '/') {
				out += '  ';
				i += 2;
				state.inBlockComment = false;
			} else {
				out += ' ';
				i++;
			}
			continue;
		}
		if (line[i] === '/' && line[i + 1] === '*') {
			out += '  ';
			i += 2;
			state.inBlockComment = true;
			continue;
		}
		if (line[i] === '/' && line[i + 1] === '/') {
			out += ' '.repeat(line.length - i);
			break;
		}
		out += line[i];
		i++;
	}
	return out;
}

function stripStringLiterals(line: string): string {
	let out = '';
	let quote: string | null = null;
	for (let i = 0; i < line.length;) {
		const ch = line[i]!;
		if (quote) {
			out += ' ';
			if (ch === '\\' && i + 1 < line.length) {
				out += ' ';
				i += 2;
				continue;
			}
			if (ch === quote) quote = null;
			i++;
			continue;
		}
		if (ch === '"' || ch === '\'') {
			quote = ch;
			out += ' ';
			i++;
			continue;
		}
		out += ch;
		i++;
	}
	return out;
}

function hasFunctionBodyAfterOpenParen(lines: string[], lineIndex: number, openParen: number): boolean {
	let depth = 0;
	for (let i = lineIndex; i < lines.length; i++) {
		const line = lines[i]!;
		const start = i === lineIndex ? openParen : 0;
		for (let c = start; c < line.length; c++) {
			const ch = line[c]!;
			if (ch === '(') depth++;
			else if (ch === ')') {
				depth--;
				if (depth === 0) {
					for (let j = i; j < lines.length; j++) {
						const after = lines[j]!;
						let k = j === i ? c + 1 : 0;
						while (k < after.length && /\s/.test(after[k]!)) k++;
						if (k >= after.length) continue;
						return after[k] === '{';
					}
					return false;
				}
			}
		}
	}
	return false;
}

export function scanIncludesForSymbol(name: string, pre?: PreprocResult, kinds?: readonly ExternalDefKind[]): ExternalDefHit | null {
	if (!pre || !pre.includeTargets || !name) return null;
	const acceptsKind = (kind: ExternalDefKind) => !kinds || kinds.includes(kind);
	const queue: string[] = [];
	const seen = new Set<string>();
	for (const t of pre.includeTargets) { if (t.resolved) queue.push(t.resolved); }
	const MAX = 16; let depth = 0;
	while (queue.length && depth < MAX) {
		const file = queue.shift()!; if (seen.has(file)) { depth++; continue; }
		seen.add(file);
		// TEMP DEBUG: log traversal for transitive include resolution in tests
		try { if (process.env.LSL_LSP_DEBUG_XINCS) console.log('[scanIncludes]', name, 'visiting', file); } catch { /* ignore */ }
		const { lines, text } = readIncludeFile(file);
		const lineOffsets = lineOffsetsFor(text);
		const strippedLines: string[] = [];
		const commentState = { inBlockComment: false };
		for (const line of lines) strippedLines.push(stripStringLiterals(stripComments(line, commentState)));
		const includeCommentState = { inBlockComment: false };
		for (let i = 0; i < lines.length; i++) {
			const L = lines[i]!;
			const codeLine = stripComments(L, includeCommentState);
			const symbolLine = strippedLines[i]!;
			// Discover further includes transitively
			const inc = /^\s*#\s*include\s+["<]([^">]+)[">]/.exec(codeLine);
			if (inc) {
				const target = inc[1];
				const candidate = path.isAbsolute(target) ? target : path.join(path.dirname(file), target);
				try { if (process.env.LSL_LSP_DEBUG_XINCS) console.log('  include ->', candidate); } catch { /* ignore */ }
				if (!seen.has(candidate) && fs.existsSync(candidate)) queue.push(candidate);
			}
			// Macro definition
			const mMacro = /^\s*#\s*define\s+([A-Za-z_]\w*)/.exec(codeLine);
			if (mMacro && mMacro[1] === name) {
				const activeLine = activeMacroDefineLine(pre, name, file, lineOffsets, lines);
				if (activeLine !== i) continue;
				const col = codeLine.indexOf(name);
				const afterName = codeLine.slice(col + name.length);
				const macroKind = /^\(/.test(afterName) ? 'macro-func' : 'macro-obj';
				if (!acceptsKind(macroKind)) continue;
				try { if (process.env.LSL_LSP_DEBUG_XINCS) console.log('  FOUND macro', name, 'in', file, 'line', i); } catch { /* ignore */ }
				return { file, line: i, startChar: col, endChar: col + name.length, kind: macroKind } as ExternalDefHit;
			}
			// Function definition. Includes are textual LSL, so C-style prototypes are not declarations.
			const funcRe = new RegExp(`(^|[^A-Za-z0-9_])([A-Za-z_]\\w*)\\s+(${name})\\s*\\(`);
			const fm = funcRe.exec(symbolLine);
			if (fm) {
				const col = symbolLine.indexOf(name, fm.index);
				const openParen = symbolLine.indexOf('(', col + name.length);
				if (col >= 0 && openParen >= 0 && hasFunctionBodyAfterOpenParen(strippedLines, i, openParen)) {
					if (!hasActiveTokenOnLine(pre, file, i, lineOffsets, lines)) continue;
					if (!acceptsKind('function')) continue;
					try { if (process.env.LSL_LSP_DEBUG_XINCS) console.log('  FOUND function', name, 'in', file, 'line', i); } catch { /* ignore */ }
					return { file, line: i, startChar: col, endChar: col + name.length, kind: 'function' } as ExternalDefHit;
				}
			}
			// Global variable
			const gvRe = new RegExp(`(^|[^A-Za-z0-9_])([A-Za-z_]\\w*)\\s+(${name})(?=\\n|[ \t]*[=;])`);
			const gvm = gvRe.exec(symbolLine);
			if (gvm && !/\(\s*$/.test(symbolLine.slice(gvm.index))) {
				if (!hasActiveTokenOnLine(pre, file, i, lineOffsets, lines)) continue;
				if (!acceptsKind('global')) continue;
				try { if (process.env.LSL_LSP_DEBUG_XINCS) console.log('  FOUND global', name, 'in', file, 'line', i); } catch { /* ignore */ }
				const col = symbolLine.indexOf(name, gvm.index);
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

function isDeclInDocument(doc: TextDocument, decl: Analysis['decls'][number]): boolean {
	try {
		const start = doc.offsetAt(decl.range.start);
		const end = doc.offsetAt(decl.range.end);
		const text = doc.getText();
		if (start < 0 || end <= start || text.slice(start, end) !== decl.name) return false;
		let lineStart = start;
		while (lineStart > 0 && text[lineStart - 1] !== '\n') lineStart--;
		let lineEnd = end;
		while (lineEnd < text.length && text[lineEnd] !== '\n') lineEnd++;
		const before = text.slice(lineStart, start);
		const after = text.slice(end, lineEnd);
		const typedPrefix = /\b(?:integer|float|string|key|vector|rotation|quaternion|list|void)\s+$/.test(before);
		switch (decl.kind) {
			case 'func':
				return typedPrefix && /^\s*\(/.test(after);
			case 'var':
				return typedPrefix && /^\s*(?:[=;,]|$)/.test(after);
			case 'param':
				return typedPrefix && /^\s*(?:,|\))/.test(after);
			case 'state':
				return /\bstate\s+$/.test(before);
			case 'event':
				return /^\s*\(/.test(after);
		}
	} catch {
		return false;
	}
}

/** Resolve the best definition target at the given position, unifying hover/gotoDefinition logic. */
export function resolveSymbolAt(
	doc: TextDocument,
	pos: Position,
	analysis: Analysis,
	pre?: PreprocResult,
	defs?: Defs,
	options: ResolverOptions = {}
): ResolvedTarget | null {
	const offset = doc.offsetAt(pos);
	const toUri = options.filePathToUri ?? filePathToUri;
	try { if (process.env.LSL_LSP_DEBUG_XINCS) console.log('[resolveSymbolAt] pos', pos.line, pos.character); } catch { /* ignore */ }

	// If on an #include target, navigate to the resolved file
	if (pre && pre.includeTargets) {
		for (const it of pre.includeTargets) {
			if (offset >= it.start && offset <= it.end && it.resolved) {
				return { kind: 'include-target', uri: toUri(it.resolved), range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } } };
			}
		}
	}

	// If cursor is on a declaration name, jump to it (noop navigation)
	const atDecl = analysis.symbolAt(offset);
	if (atDecl && isDeclInDocument(doc, atDecl)) {
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

	// Local states/functions/vars/params: choose nearest declaration before this offset
	{
		let best: Analysis['decls'][number] | null = null;
		let bestStart = -1;
		for (const d of analysis.decls) {
			const isSupported = d.kind === 'var' || d.kind === 'param' || d.kind === 'func' || d.kind === 'state' || d.kind === 'event';
			if (isSupported && d.name === refName && isDeclInDocument(doc, d)) {
				const s = doc.offsetAt(d.range.start);
				if (s <= offset && s > bestStart) { best = d; bestStart = s; }
			}
		}
		if (best) {
			const k = best.kind === 'func' ? 'function' : (best.kind as 'state' | 'event' | 'var' | 'param');
			return { kind: k, name: refName, uri: doc.uri, range: best.range, from: 'local' };
		}
	}

	// Local macros: trust active macro metadata rather than raw text, so inactive #defines
	// cannot steal navigation from an active include macro with the same name.
	if (pre && (pre.macros?.[refName] !== undefined || pre.funcMacros?.[refName] !== undefined)) {
		const localPath = doc.uri.startsWith('file://') ? fileUriToPath(doc.uri) : undefined;
		const def = pre.macroDefs?.[refName];
		if (def && localPath && def.file === localPath) {
			const range = { start: doc.positionAt(def.start), end: doc.positionAt(def.end) };
			const kind: 'macro-obj' | 'macro-func' = pre.funcMacros?.[refName] !== undefined ? 'macro-func' : 'macro-obj';
			return { kind, name: refName, uri: doc.uri, range, from: 'local' };
		}
	}

	// Cross-include lookup for macros/functions/globals after locals, but before builtins,
	// so user/includes can shadow built-in definitions without stealing local references.
	if (pre && pre.includeTargets && pre.includeTargets.length) {
		try { if (process.env.LSL_LSP_DEBUG_XINCS) console.log('[resolveSymbolAt] cross-include scan', refName); } catch { /* ignore */ }
		const hit = scanIncludesForSymbol(refName, pre);
		if (hit) {
			const uri = hit.file.startsWith('file://') ? hit.file : toUri(path.resolve(hit.file));
			return { kind: hit.kind as ResolvedTarget['kind'], name: refName, uri, range: { start: { line: hit.line, character: hit.startChar }, end: { line: hit.line, character: hit.endChar } }, from: 'include' };
		}
	}

	// Built-ins: treat as non-navigable targets after include definitions have had a chance to shadow them.
	if (defs && (defs.funcs.has(refName) || defs.consts.has(refName))) {
		try { if (process.env.LSL_LSP_DEBUG_XINCS) console.log('[resolveSymbolAt] builtin hit', refName); } catch { /* ignore */ }
		if (defs.funcs.has(refName)) return { kind: 'builtin-func', name: refName };
		if (defs.consts.has(refName)) return { kind: 'builtin-const', name: refName };
	}

	return null;
}
