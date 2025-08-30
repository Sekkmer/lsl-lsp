 
import path from 'node:path';
import { normalizeType } from './defs';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { Connection } from 'vscode-languageserver/node';

export interface DisabledRange { start: number; end: number; }
export interface IncludeFunctionParam { type: string; name?: string }
export interface IncludeFunction { name: string; returns: string; params: IncludeFunctionParam[]; line: number; col: number; endCol: number }
export interface IncludeSymbols {
	functions: Map<string, IncludeFunction>;
	macroObjs: Map<string, { line: number; col: number; endCol: number; body?: string }>;
	macroFuncs: Map<string, { line: number; col: number; endCol: number; body: string }>;
	constants: Set<string>;
	events: Set<string>;
	typedefs: Set<string>;
	globals: Map<string, { line: number; col: number; endCol: number }>;
}

export interface PreprocResult {
	disabledRanges: DisabledRange[];
	macros: Record<string, string | number | boolean>;
	funcMacros: Record<string, string>; // name -> "(params) body"
	includes: string[];
	includeSymbols: Map<string, IncludeSymbols>;
	missingIncludes: { start: number; end: number; file: string }[];
	includeTargets: { start: number; end: number; file: string; resolved: string | null }[];
	// Preprocessor diagnostics (malformed expressions, stray or unmatched directives)
	preprocDiagnostics: { start: number; end: number; message: string; code?: string }[];
	// Diagnostic suppression directives parsed from comments
	diagDirectives?: {
		// disable for a specific line (1-based)
		disableLine: Map<number, Set<string> | null>; // null means all
		// disable for the next line (1-based target)
		disableNextLine: Map<number, Set<string> | null>;
		// block disable/enable ranges as offsets
		blocks: { start: number; end: number; codes: Set<string> | null }[];
	};
}

// (no-op)

// Global caches to improve include resolution performance across files
const includeCache = new Map<string, IncludeSymbols>();
const includeDeps = new Map<string, string[]>();

function parseIncludesFromText(text: string): string[] {
	const out: string[] = [];
	const lines = text.split(/\r?\n/);
	for (const L of lines) {
		const m = /^\s*#\s*include\s+(.*)$/.exec(L);
		if (!m) continue;
		const target = parseIncludeTarget((m[1] || '').trim());
		if (target) out.push(target);
	}
	return out;
}

function loadIncludeRecursive(
	rootFile: string,
	includePaths: string[],
	sinkSymbols: Map<string, IncludeSymbols>,
	macroObjs: Set<string>,
	macroFuncs: Set<string>,
	seen: Set<string>
) {
	const fs = require('node:fs') as typeof import('node:fs');
	if (seen.has(rootFile)) return;
	seen.add(rootFile);
	try {
		let info = includeCache.get(rootFile);
		let deps = includeDeps.get(rootFile);
		if (!info || !deps) {
			const text = fs.readFileSync(rootFile, 'utf8');
			info = scanIncludeText(text);
			deps = parseIncludesFromText(text)
				.map(t => resolveInclude(path.dirname(rootFile), t, includePaths))
				.filter((p): p is string => !!p);
			includeCache.set(rootFile, info);
			includeDeps.set(rootFile, deps);
		}
		sinkSymbols.set(rootFile, info);
		for (const k of info.macroObjs.keys()) macroObjs.add(k);
		for (const k of info.macroFuncs.keys()) macroFuncs.add(k);
		for (const dep of deps!) {
			loadIncludeRecursive(dep, includePaths, sinkSymbols, macroObjs, macroFuncs, seen);
		}
	} catch { /* ignore */ }
}

export function preprocess(
	doc: TextDocument,
	baseMacros: Record<string, any>,
	includePaths: string[],
	_connection: Connection
): PreprocResult {
	const text = doc.getText();
	const lines = text.split(/\r?\n/);
	const macros: Record<string, any> = { ...baseMacros };
	// Built-in macro __FILE__ (basename)
	try {
		let full = '';
		try { const u = new URL(doc.uri); full = u.protocol === 'file:' ? decodeURIComponent(u.pathname) : doc.uri; }
		catch { full = doc.uri.replace(/^file:\/\//, ''); }
		macros['__FILE__'] = path.basename(full);
	} catch (e) { void e; }

	const funcMacros: Record<string, string> = {};
	const disabledRanges: DisabledRange[] = [];
	const includes: string[] = [];
	const includeSymbols = new Map<string, IncludeSymbols>();
	const missingIncludes: { start: number; end: number; file: string }[] = [];
	const includeTargets: { start: number; end: number; file: string; resolved: string | null }[] = [];
	const preprocDiagnostics: { start: number; end: number; message: string; code?: string }[] = [];

	// Diagnostic suppression collection
	const disableLine = new Map<number, Set<string> | null>();
	const disableNextLine = new Map<number, Set<string> | null>();
	const blocks: { start: number; end: number; codes: Set<string> | null }[] = [];
	let openBlock: { start: number; codes: Set<string> | null } | null = null;

	type Frame = { enabled: boolean; sawElse: boolean; taken: boolean; headStart: number; headEnd: number };
	const stack: Frame[] = [];

	let offset = 0;
	for (let i = 0; i < lines.length; i++) {
		const L = lines[i];
		const lineStart = offset;
		const lineEnd = offset + L.length;

		// comment-based diagnostic directives
		const cidx = L.indexOf('//');
		if (cidx >= 0) {
			const comment = L.slice(cidx + 2).trim();
			const dm = /^(lsl-(disable-next-line|disable-line|disable|enable))\b(.*)$/i.exec(comment);
			if (dm) {
				const kind = (dm[2] || '').toLowerCase();
				const restCodes = (dm[3] || '').trim();
				let codes: Set<string> | null = null;
				if (restCodes) { const list = restCodes.split(/[\s,]+/).filter(Boolean); if (list.length > 0) codes = new Set(list); }
				const lineNo = i + 1;
				if (kind === 'disable-next-line') disableNextLine.set(lineNo + 1, codes);
				else if (kind === 'disable-line') disableLine.set(lineNo, codes);
				else if (kind === 'disable') { if (!openBlock) openBlock = { start: lineStart, codes }; }
				else if (kind === 'enable') { if (openBlock) { blocks.push({ start: openBlock.start, end: lineEnd, codes: openBlock.codes }); openBlock = null; } }
			}
		}

		const m = /^\s*#\s*(\w+)(.*)$/.exec(L);
		if (m) {
			const directive = m[1];
			const rest = m[2].trim();
			const head = headRange(directive, L, lineStart);

			switch (directive) {
				case 'if': {
					const expr = stripLineComment(rest);
					const r = evalIfExpr(expr, macros, funcMacros);
					if (!r.valid) {
						const a = argRangeForDirective('if', L, lineStart, lineEnd);
						preprocDiagnostics.push({ start: a.start, end: a.end, message: 'Malformed #if expression', code: 'LSL-preproc' });
					}
					const enabled = truthy(r.value);
					stack.push({ enabled, sawElse: false, taken: enabled, headStart: head.start, headEnd: head.end });
					if (!enabled) disabledRanges.push({ start: lineEnd + 1, end: -1 });
					break;
				}
				case 'elif': {
					const top = stack[stack.length - 1];
					if (!top) { preprocDiagnostics.push({ start: head.start, end: head.end, message: 'Stray #elif without matching #if', code: 'LSL-preproc' }); break; }
					if (top.sawElse) { preprocDiagnostics.push({ start: head.start, end: head.end, message: '#elif after #else is not allowed', code: 'LSL-preproc' }); break; }
					let newEnabled = false;
					if (!top.taken) {
						const expr = stripLineComment(rest);
						const r = evalIfExpr(expr, macros, funcMacros);
						if (!r.valid) {
							const a = argRangeForDirective('elif', L, lineStart, lineEnd);
							preprocDiagnostics.push({ start: a.start, end: a.end, message: 'Malformed #elif expression', code: 'LSL-preproc' });
						}
						newEnabled = truthy(r.value);
						if (newEnabled) top.taken = true;
					}
					if (top.enabled !== newEnabled) {
						if (top.enabled && !newEnabled) disabledRanges.push({ start: lineEnd + 1, end: -1 });
						else if (!top.enabled && newEnabled) closeLastOpen(disabledRanges, lineStart - 1);
						top.enabled = newEnabled;
					}
					break;
				}
				case 'else': {
					const top = stack[stack.length - 1];
					if (!top) { preprocDiagnostics.push({ start: head.start, end: head.end, message: 'Stray #else without matching #if', code: 'LSL-preproc' }); break; }
					if (top.sawElse) { preprocDiagnostics.push({ start: head.start, end: head.end, message: 'Multiple #else branches in #if chain', code: 'LSL-preproc' }); break; }
					top.sawElse = true;
					const shouldEnable = !top.taken;
					if (top.enabled !== shouldEnable) {
						if (top.enabled && !shouldEnable) disabledRanges.push({ start: lineEnd + 1, end: -1 });
						else if (!top.enabled && shouldEnable) closeLastOpen(disabledRanges, lineStart - 1);
						top.enabled = shouldEnable;
					}
					break;
				}
				case 'endif': {
					const top = stack.pop();
					if (!top) { preprocDiagnostics.push({ start: head.start, end: head.end, message: 'Stray #endif without matching #if', code: 'LSL-preproc' }); break; }
					if (!top.enabled) closeLastOpen(disabledRanges, lineStart - 1);
					break;
				}
				case 'define': {
					// Support object-like and function-like macros
					const mm = /^([A-Za-z_]\w*)(\s*\(([^)]*)\))?(?:\s+(.*))?$/.exec(rest);
					if (mm) {
						const name = mm[1];
						const hasParams = !!mm[2];
						const params = (mm[3] ?? '').trim();
						const body = (mm[4] ?? '').trim();
						if (hasParams) {
							// Keep verbatim, including __VA_ARGS__/__VA_OPT__ markers
							funcMacros[name] = `(${params})${body ? ' ' + body : ''}`;
						} else {
							const value = body.length > 0 ? body : '1';
							macros[name] = parseMacroValue(value);
						}
					}
					break;
				}
				case 'undef': {
					const name = rest.split(/\s+/)[0];
					delete macros[name];
					delete funcMacros[name];
					break;
				}
				case 'ifdef': {
					const name = rest.split(/\s+/)[0];
					const enabled = !!macros[name] || !!funcMacros[name];
					stack.push({ enabled, sawElse: false, taken: enabled, headStart: head.start, headEnd: head.end });
					if (!enabled) disabledRanges.push({ start: lineEnd + 1, end: -1 });
					break;
				}
				case 'ifndef': {
					const name = rest.split(/\s+/)[0];
					const enabled = !(!!macros[name] || !!funcMacros[name]);
					stack.push({ enabled, sawElse: false, taken: enabled, headStart: head.start, headEnd: head.end });
					if (!enabled) disabledRanges.push({ start: lineEnd + 1, end: -1 });
					break;
				}
				case 'include': {
					const file = parseIncludeTarget(rest);
					const headInc = /^\s*#\s*include\b/.exec(L);
					if (headInc) {
						const headLen = headInc[0].length;
						const tail = L.slice(headLen);
						let sRel = -1, eRel = -1;
						const q = tail.indexOf('"');
						const a = tail.indexOf('<');
						if (q >= 0 && (a < 0 || q < a)) { sRel = q; const q2 = tail.indexOf('"', q + 1); if (q2 >= 0) eRel = q2 + 1; }
						else if (a >= 0) { sRel = a; const a2 = tail.indexOf('>', a + 1); if (a2 >= 0) eRel = a2 + 1; }
						if (sRel >= 0 && eRel > sRel) {
							const start = lineStart + headLen + sRel;
							const end = lineStart + headLen + eRel;
							const resolved = file ? resolveInclude(dirnameOfDoc(doc), file, includePaths) : null;
							includeTargets.push({ start, end, file: file || '', resolved });
							if (!resolved && file) { missingIncludes.push({ start, end, file }); }
							if (resolved) {
								includes.push(resolved);
								// Recursively collect symbols and macros with caching
								const symMap = new Map<string, IncludeSymbols>();
								const mObjs = new Set<string>();
								const mFuncs = new Set<string>();
								loadIncludeRecursive(resolved, includePaths, symMap, mObjs, mFuncs, new Set());
								for (const [fp, info] of symMap) includeSymbols.set(fp, info);
								// Prefer actual macro bodies from include scan when present
								for (const [_, info] of symMap) {
									for (const [name, meta] of info.macroObjs) {
										if (meta.body && meta.body.length > 0) macros[name] = parseMacroValue(meta.body);
										else macros[name] = 1;
									}
									for (const [name, meta] of info.macroFuncs) {
										if (meta.body && meta.body.length > 0) funcMacros[name] = meta.body;
										else funcMacros[name] = '(...)';
									}
								}
							}
						}
					}
					break;
				}
				default: {
					// unknown directive: ignore
					break;
				}
			}
		}

		offset = lineEnd + 1;
	}
	// Close any still-open disabled ranges to EOF
	closeAllOpen(disabledRanges, text.length);

	// Unmatched blocks at EOF
	for (const f of stack) {
		preprocDiagnostics.push({ start: f.headStart, end: f.headEnd, message: 'Unmatched conditional block (missing #endif)', code: 'LSL-preproc' });
	}

	// Close any open diag block to EOF
	if (openBlock) { blocks.push({ start: openBlock.start, end: text.length, codes: openBlock.codes }); openBlock = null; }

	return {
		disabledRanges: normalize(disabledRanges),
		macros,
		funcMacros,
		includes,
		includeSymbols,
		missingIncludes,
		includeTargets,
		preprocDiagnostics,
		diagDirectives: { disableLine, disableNextLine, blocks }
	};
}

function parseMacroValue(v: string): any {
	const num = Number(v);
	if (!Number.isNaN(num)) return num;
	if (v === 'true' || v === 'TRUE') return true;
	if (v === 'false' || v === 'FALSE') return false;
	// Preserve surrounding quotes for string macro bodies so downstream lexers
	// can emit proper string tokens when expanding object-like macros.
	// Example: #define DEMO_SECRET "secret" -> keep "secret" (with quotes)
	// whereas #define NAME Foo -> keep Foo (unquoted identifier text)
	if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) return v;
	return v;
}

function parseIncludeTarget(rest: string): string | null {
	let m = /^"(.*)"$/.exec(rest); if (m) return m[1];
	m = /^<(.*)>$/.exec(rest); if (m) return m[1];
	return null;
}

function resolveInclude(baseDir: string, target: string, includePaths: string[]): string | null {
	const candidates = [path.join(baseDir, target), ...includePaths.map(p => path.join(p, target))];
	const fs = require('node:fs');
	for (const c of candidates) { if (fs.existsSync(c)) return c; }
	return null;
}

function dirnameOfDoc(doc: TextDocument): string {
	try {
		const u = new URL(doc.uri);
		if (u.protocol === 'file:') return path.dirname(decodeURIComponent(u.pathname));
	} catch {
		// fallthrough
	}
	return path.dirname(doc.uri.replace(/^file:\/\//, ''));
}

function closeLastOpen(ranges: DisabledRange[], endOffset: number) {
	for (let i = ranges.length - 1; i >= 0; i--) {
		if (ranges[i].end === -1) { ranges[i].end = endOffset; return; }
	}
}

function closeAllOpen(ranges: DisabledRange[], endOffset: number) {
	for (let i = ranges.length - 1; i >= 0; i--) {
		if (ranges[i].end === -1) ranges[i].end = endOffset;
	}
}

function normalize(ranges: DisabledRange[]): DisabledRange[] {
	const out: DisabledRange[] = [];
	const sorted = ranges.filter(r => r.end >= r.start).sort((a, b) => a.start - b.start);
	for (const r of sorted) {
		const last = out[out.length - 1];
		if (!last || r.start > last.end + 1) out.push(r);
		else last.end = Math.max(last.end, r.end);
	}
	return out;
}

// Very light include scanner: collect macros and function names by simple regexes
function scanIncludeText(text: string): IncludeSymbols {
	const functions = new Map<string, IncludeFunction>();
	const macroObjs = new Map<string, { line: number; col: number; endCol: number; body?: string }>();
	const macroFuncs = new Map<string, { line: number; col: number; endCol: number; body: string }>();
	const constants = new Set<string>();
	const events = new Set<string>();
	const typedefs = new Set<string>();
	const globals = new Map<string, { line: number; col: number; endCol: number }>();

	const lines = text.split(/\r?\n/);
	let braceDepth = 0;
	for (let lineNo = 0; lineNo < lines.length; lineNo++) {
		const raw = lines[lineNo];
		const L = raw.replace(/\/\/.*$/, ''); // strip line comments
		const m = /^\s*#\s*define\s+([A-Za-z_]\w*)(\s*\(([^)]*)\))?(?:\s+(.*))?$/.exec(L);
		if (m) {
			const name = m[1];
			const whole = m[0];
			const nameRel = whole.indexOf(name);
			const col = nameRel >= 0 ? nameRel : Math.max(0, whole.search(/\b[A-Za-z_]\w*/));
			if (m[2]) {
				// function-like macro: preserve full body including params list
				const params = (m[3] ?? '').trim();
				const body = (m[4] ?? '').trim();
				const full = `(${params})${body ? ' ' + body : ''}`;
				macroFuncs.set(name, { line: lineNo, col, endCol: col + name.length, body: full });
			}
			else {
				// object-like macro: preserve body text if present
				const body = (m[4] ?? '').trim();
				macroObjs.set(name, { line: lineNo, col, endCol: col + name.length, body });
			}
			continue;
		}
		// Function decl at top-level (braceDepth===0):
		// 1) With explicit return type: <retType> <name>(params) { or ;
		// Accept the common style where '{' is on the next line by allowing end-of-line after ')'
		const fdm = (braceDepth === 0) ? /^\s*([A-Za-z_]\w*)\s+([A-Za-z_]\w*)\s*\(([^)]*)\)\s*(?:[{;]|$)/.exec(L) : null;
		if (fdm) {
			const ret = normalizeType(fdm[1]);
			const name = fdm[2];
			const paramsRaw = fdm[3].trim();
			const whole = fdm[0];
			const nameRel = whole.indexOf(name);
			const col = nameRel >= 0 ? nameRel : Math.max(0, whole.search(/\b[A-Za-z_]\w*\s*\(/));
			const params: IncludeFunctionParam[] = [];
			if (paramsRaw.length > 0) {
				for (const piece of paramsRaw.split(',')) {
					const p = piece.trim().replace(/\s+/g, ' ');
					if (!p) continue;
					// Pattern: <type> [name]
					const parts = p.split(' ');
					if (parts.length >= 2) params.push({ type: normalizeType(parts[0]), name: parts[1] });
					else params.push({ type: normalizeType(parts[0]) });
				}
			}
			functions.set(name, { name, returns: ret, params, line: lineNo, col, endCol: col + name.length });
			continue;
		}
		// 2) Without explicit return type (common in some codebases): <name>(params) { or ;
		// We treat these as functions with "integer" return by convention; only arity matters for our checks.
		// Also allow '{' on the next line by accepting end-of-line here.
		const fdm2 = (braceDepth === 0) ? /^\s*([A-Za-z_]\w*)\s*\(([^)]*)\)\s*(?:[{;]|$)/.exec(L) : null;
		if (fdm2) {
			const name = fdm2[1];
			const paramsRaw = (fdm2[2] || '').trim();
			const whole = fdm2[0];
			const nameRel = whole.indexOf(name);
			const col = nameRel >= 0 ? nameRel : Math.max(0, whole.search(/\b[A-Za-z_]\w*\s*\(/));
			const params: IncludeFunctionParam[] = [];
			if (paramsRaw.length > 0) {
				for (const piece of paramsRaw.split(',')) {
					const p = piece.trim().replace(/\s+/g, ' ');
					if (!p) continue;
					const parts = p.split(' ');
					if (parts.length >= 2) params.push({ type: normalizeType(parts[0]), name: parts[1] });
					else params.push({ type: normalizeType(parts[0]) });
				}
			}
			functions.set(name, { name, returns: 'integer', params, line: lineNo, col, endCol: col + name.length });
			// do not continue; still update braceDepth for this line below
		}
		// Global var: <type> <name> [= ...] ;
		const gv = /^\s*([A-Za-z_]\w*)\s+([A-Za-z_]\w*)\s*(?:=|;)/.exec(L);
		if (gv && !/\(/.test(L)) {
			const name = gv[2];
			const whole = gv[0];
			const nameRel = whole.indexOf(name);
			const col = nameRel >= 0 ? nameRel : Math.max(0, whole.search(/\b[A-Za-z_]\w*/));
			globals.set(name, { line: lineNo, col, endCol: col + name.length });
		}
		// Update brace depth after processing this line (naive, fine for headers)
		for (let k = 0; k < L.length; k++) {
			const ch = L[k]!;
			if (ch === '{') braceDepth++;
			else if (ch === '}') { if (braceDepth > 0) braceDepth--; }
		}
	}
	return { functions, macroObjs, macroFuncs, constants, events, typedefs, globals };
}

// ------------------------------
// #if / #elif expression support
// ------------------------------

function stripLineComment(src: string): string {
	return src.replace(/\/\/.*$/, '').trim();
}

function truthy(v: any): boolean {
	if (typeof v === 'number') return v !== 0;
	if (typeof v === 'boolean') return v;
	if (typeof v === 'string') return v.length > 0 && v !== '0' && v.toLowerCase() !== 'false';
	return !!v;
}

type Tok = { kind: 'num' | 'id' | 'op' | 'lparen' | 'rparen' | 'eof'; value: string };

function lexIfExpr(src: string): Tok[] {
	const out: Tok[] = [];
	let i = 0;
	const isIdStart = (c: string) => /[A-Za-z_]/.test(c);
	const isId = (c: string) => /[A-Za-z0-9_]/.test(c);
	while (i < src.length) {
		const ch = src[i];
		if (/\s/.test(ch)) { i++; continue; }
		// numbers (int only is enough)
		if (/[0-9]/.test(ch)) {
			let j = i + 1; while (j < src.length && /[0-9]/.test(src[j])) j++;
			out.push({ kind: 'num', value: src.slice(i, j) }); i = j; continue;
		}
		// identifiers
		if (isIdStart(ch)) {
			let j = i + 1; while (j < src.length && isId(src[j])) j++;
			out.push({ kind: 'id', value: src.slice(i, j) }); i = j; continue;
		}
		// two-char ops
		const two = src.slice(i, i + 2);
		if (two === '||' || two === '&&' || two === '==' || two === '!=' || two === '<=' || two === '>=') {
			out.push({ kind: 'op', value: two }); i += 2; continue;
		}
		// single-char ops / parens
		if ('+-*/%<>!'.includes(ch)) { out.push({ kind: 'op', value: ch }); i++; continue; }
		if (ch === '(') { out.push({ kind: 'lparen', value: ch }); i++; continue; }
		if (ch === ')') { out.push({ kind: 'rparen', value: ch }); i++; continue; }
		// unknown: skip
		i++;
	}
	out.push({ kind: 'eof', value: '' });
	return out;
}

// Pratt parser with simple precedence
function evalIfExpr(src: string, macros: Record<string, any>, funcMacros: Record<string, string>): { value: number | boolean; valid: boolean } {
	const toks = lexIfExpr(src);
	let pos = 0;
	let valid = true;
	const peek = () => toks[pos];
	const take = () => toks[pos++];

	function parsePrimary(): any {
		const t = take();
		if (t.kind === 'num') return Number(t.value);
		if (t.kind === 'id') {
			// defined NAME or defined(NAME)
			if (t.value === 'defined') {
				if (peek().kind === 'lparen') {
					take();
					const idTok = take();
					const name = (idTok.kind === 'id') ? idTok.value : '';
					if (peek().kind === 'rparen') take(); else valid = false;
					return (name in macros) || (name in funcMacros);
				} else {
					const idTok = take();
					const name = (idTok && idTok.kind === 'id') ? idTok.value : '';
					if (!name) valid = false;
					return (name in macros) || (name in funcMacros);
				}
			}
			// macro substitution: object-like only here (func-like treated as defined())
			if (t.value in macros) {
				const v = macros[t.value];
				if (typeof v === 'number' || typeof v === 'boolean') return v;
				const num = Number(v);
				return Number.isNaN(num) ? truthy(v) : num;
			}
			// undefined id -> 0
			return 0;
		}
		if (t.kind === 'lparen') { const v = parseExpr(1); if (peek().kind === 'rparen') take(); else valid = false; return v; }
		if (t.kind === 'op' && t.value === '!') { return truthy(parsePrimary()) ? 0 : 1; }
		// unexpected token
		valid = false;
		return 0;
	}

	function prec(op: string): number {
		switch (op) {
			case '||': return 1;
			case '&&': return 2;
			case '==': case '!=': return 3;
			case '<': case '>': case '<=': case '>=': return 4;
			case '+': case '-': return 5;
			case '*': case '/': case '%': return 6;
			default: return 0;
		}
	}

	function apply(a: any, op: string, b: any): any {
		switch (op) {
			case '||': return (truthy(a) || truthy(b)) ? 1 : 0;
			case '&&': return (truthy(a) && truthy(b)) ? 1 : 0;
			case '==': return (a == b) ? 1 : 0;
			case '!=': return (a != b) ? 1 : 0;
			case '<': return (Number(a) < Number(b)) ? 1 : 0;
			case '>': return (Number(a) > Number(b)) ? 1 : 0;
			case '<=': return (Number(a) <= Number(b)) ? 1 : 0;
			case '>=': return (Number(a) >= Number(b)) ? 1 : 0;
			case '+': return Number(a) + Number(b);
			case '-': return Number(a) - Number(b);
			case '*': return Number(a) * Number(b);
			case '/': return Number(b) === 0 ? 0 : (Number(a) / Number(b));
			case '%': return Number(b) === 0 ? 0 : (Number(a) % Number(b));
		}
		return 0;
	}

	function parseExpr(minPrec: number): any {
		let lhs = parsePrimary();
		while (peek().kind === 'op' && prec(peek().value) >= minPrec) {
			const op = take().value;
			let rhs = parsePrimary();
			while (peek().kind === 'op' && prec(peek().value) > prec(op)) {
				rhs = parseExpr(prec(peek().value));
			}
			lhs = apply(lhs, op, rhs);
		}
		return lhs;
	}

	const value = parseExpr(1);
	if (peek().kind !== 'eof') valid = false;
	return { value, valid };
}

// Helpers to compute ranges on directive lines
function headRange(directive: string, line: string, lineStart: number): { start: number; end: number } {
	const re = new RegExp(`^\\s*#\\s*${directive}\\b`);
	const m = re.exec(line);
	if (m) {
		const s = line.indexOf(m[0]);
		const start = s >= 0 ? lineStart + s : lineStart;
		return { start, end: start + m[0].length };
	}
	return { start: lineStart, end: lineStart + directive.length };
}

function argRangeForDirective(directive: string, line: string, lineStart: number, lineEnd: number): { start: number; end: number } {
	const re = new RegExp(`^\\s*#\\s*${directive}\\b`);
	const m = re.exec(line);
	if (!m) return { start: lineStart, end: lineEnd };
	const headLen = m[0].length;
	let s = headLen;
	while (s < line.length && /\s/.test(line[s]!)) s++;
	const noComment = line.replace(/\/\/.*$/, '');
	const end = lineStart + Math.max(headLen, noComment.length);
	return { start: lineStart + s, end };
}
