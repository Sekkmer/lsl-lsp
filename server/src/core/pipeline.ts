import path from 'node:path';
// fs will be provided via opts.fs or required dynamically to allow testing
import type { Token } from './tokens';
import { Tokenizer } from './tokenizer';
import { MacroConditionalProcessor, type MacroDefines, type IncludeResolver } from './macro';
import type { ConditionalGroup } from './preproc';

export type IncludeResolverOptions = {
	includePaths: string[];
	fromPath?: string; // absolute path of the current file for relative includes
	fs?: Pick<typeof import('node:fs'), 'existsSync' | 'readFileSync' | 'statSync'>;
};

// Simple in-memory cache for tokenized include files keyed by absolute path + mtime
type CacheEntry = { id: string; tokens: Token[]; mtimeMs: number };
const includeTokenCache = new Map<string, CacheEntry>();

export function clearIncludeResolverCache() {
	includeTokenCache.clear();
}

export function buildIncludeResolver(opts: IncludeResolverOptions): IncludeResolver {
	const fs = opts.fs ?? require('node:fs');
	return (target: string, fromId?: string) => {
		const base = fromId ?? opts.fromPath ?? '';
		const baseDir = base ? path.dirname(base) : '';
		const candidates: string[] = [];
		if (baseDir) candidates.push(path.join(baseDir, target));
		for (const p of opts.includePaths || []) candidates.push(path.join(p, target));
		let found: string | null = null;
		for (const c of candidates) { if (fs.existsSync(c)) { found = c; break; } }
		if (!found) return null;
		try {
			const stat = fs.statSync(found);
			const mtimeMs: number = Number(stat?.mtimeMs ?? 0) || 0;
			const cached = includeTokenCache.get(found);
			if (cached && cached.mtimeMs === mtimeMs) {
				return { tokens: cached.tokens, id: cached.id };
			}
			const text = fs.readFileSync(found, 'utf8');
			const tz = new Tokenizer(text);
			const toks: Token[] = [];
			for (;;) { const t = tz.next(); toks.push(t); if (t.kind === 'eof') break; }
			includeTokenCache.set(found, { id: found, tokens: toks, mtimeMs });
			return { tokens: toks, id: found };
		} catch {
			return null;
		}
	};
}

export function preprocessTokens(text: string, opts: IncludeResolverOptions & { defines?: MacroDefines }): { tokens: Token[]; macros: MacroDefines; includes: string[]; macrosChanged: boolean; changedKeys: string[] } {
	const tz = new Tokenizer(text);
	const toks: Token[] = [];
	for (;;) { const t = tz.next(); toks.push(t); if (t.kind === 'eof') break; }
	const resolveInclude = buildIncludeResolver(opts);
	const mcp = new MacroConditionalProcessor(toks, { resolveInclude, fromId: opts.fromPath, includeStack: opts.fromPath ? [opts.fromPath] : [] });
	return mcp.processToTokens(opts.defines || {});
}

export function preprocessMacros(text: string, opts: IncludeResolverOptions & { defines?: MacroDefines }): { macros: MacroDefines; includes: string[]; macrosChanged: boolean; changedKeys: string[] } {
	const tz = new Tokenizer(text);
	const toks: Token[] = [];
	for (;;) { const t = tz.next(); toks.push(t); if (t.kind === 'eof') break; }
	const resolveInclude = buildIncludeResolver(opts);
	const mcp = new MacroConditionalProcessor(toks, { resolveInclude, fromId: opts.fromPath, includeStack: opts.fromPath ? [opts.fromPath] : [] });
	return mcp.processToMacros(opts.defines || {});
}

// Compute data required by AST lexer: final macro tables split into obj/func and disabled ranges for the root file.
export function preprocessForAst(text: string, opts: IncludeResolverOptions & { defines?: MacroDefines }): {
	macros: MacroDefines;
	funcMacros: Record<string, string>;
	includes: string[];
	disabledRanges: { start: number; end: number }[];
	includeTargets?: { start: number; end: number; file: string; resolved: string | null }[];
	missingIncludes?: { start: number; end: number; file: string }[];
	preprocDiagnostics?: { start: number; end: number; message: string; code?: string }[];
	diagDirectives?: import('./preproc').DiagDirectives;
	conditionalGroups?: ConditionalGroup[];
} {
	const tz = new Tokenizer(text);
	const toks: Token[] = [];
	for (;;) { const t = tz.next(); toks.push(t); if (t.kind === 'eof') break; }
	// First, resolve includes and compute the final macros table using the full processor
	const resolveInclude = buildIncludeResolver(opts);
	const mcp = new MacroConditionalProcessor(toks, { resolveInclude, fromId: opts.fromPath, includeStack: opts.fromPath ? [opts.fromPath] : [] });
	const { macros: finalMacros, includes } = mcp.processToMacros(opts.defines || {});
	// Split function-like macros from object-like
	// Note: Some object-like macros legitimately start with a parenthesized expression, e.g.:
	//   #define CHECK (foo(bar) || baz)
	// Those must NOT be treated as function-like. Only treat as function-like when the
	// string starts with a valid parameter list: (), (x), (x,y), or (...).
	const macros: MacroDefines = {};
	const funcMacros: Record<string, string> = {};
	const fnHeadRe = /^\(\s*(?:[A-Za-z_]\w*(?:\s*,\s*[A-Za-z_]\w*)*|\.\.\.)?\s*\)\s/;
	for (const [k, v] of Object.entries(finalMacros)) {
		if (typeof v === 'string' && fnHeadRe.test(v)) funcMacros[k] = v;
		else macros[k] = v;
	}
	// Compute disabled ranges and collect includeTargets/missingIncludes/diagnostics/diagDirectives on the root file by scanning directive/comment tokens.
	const disabledRanges: { start: number; end: number }[] = [];
	const includeTargets: { start: number; end: number; file: string; resolved: string | null }[] = [];
	const missingIncludes: { start: number; end: number; file: string }[] = [];
	const preprocDiagnostics: { start: number; end: number; message: string; code?: string }[] = [];
	const diagDirectives: import('./preproc').DiagDirectives = { disableLine: new Map(), disableNextLine: new Map(), blocks: [] };
	// Track open disable blocks to compute precise spans until lsl-enable
	const openDisableBlocks: { start: number; codes: Set<string> | null }[] = [];
	const stack: Array<{ enabled: boolean; sawElse: boolean; taken: boolean }> = [];
	const isActive = () => stack.every(f => f.enabled);
	const openOrNull = () => disabledRanges.find(r => r.end === -1) || null;
	const closeOpen = (endAt: number) => { const r = openOrNull(); if (r) r.end = Math.max(0, endAt); };
	// current macros while scanning main file (order-sensitive)
	const localMacros: MacroDefines = { ...(opts.defines || {}) };
	// Merge in prior macros only when they are truly built-ins from opts; included macros will be applied at include points below
	// Walk tokens in order
	// Helper to parse suppression directives from comments
	const collectDiagDirective = (comment: string, lineNo: number, spanStart: number, spanEnd: number) => {
		// lsl-disable(-line|-next-line)? [CODE(, CODE)*]
		const dm = /^(lsl-(disable-next-line|disable-line|disable|enable))\b(.*)$/i.exec(comment.trim());
		if (!dm) return;
		const kind = (dm[2] || '').toLowerCase();
		const rest = (dm[3] || '').trim();
		const parseCodes = (s: string): Set<string> | null => {
			if (!s) return null;
			const m = s.match(/[A-Za-z]{3}\d{3}/g);
			if (!m || m.length === 0) return null;
			return new Set(m.map(x => x.toUpperCase()));
		};
		const codes = parseCodes(rest);
		if (kind === 'disable-line') { diagDirectives.disableLine.set(lineNo, codes); return; }
		if (kind === 'disable-next-line') { diagDirectives.disableNextLine.set(lineNo + 1, codes); return; }
		if (kind === 'disable') { openDisableBlocks.push({ start: spanEnd, codes }); return; }
		if (kind === 'enable') {
			const last = openDisableBlocks.pop();
			if (last) { diagDirectives.blocks.push({ start: last.start, end: spanStart, codes: last.codes || null }); }
			return;
		}
	};

	// Precompute line starts for mapping offsets->line
	const lineStarts: number[] = [0];
	for (let i = 0; i < text.length; i++) if (text[i] === '\n') lineStarts.push(i + 1);
	const lineOf = (offset: number) => {
		// binary search
		let lo = 0, hi = lineStarts.length - 1;
		while (lo <= hi) {
			const mid = (lo + hi) >> 1;
			const s = lineStarts[mid]!;
			const e = (mid + 1 < lineStarts.length ? lineStarts[mid + 1]! - 1 : text.length);
			if (offset < s) hi = mid - 1; else if (offset > e) lo = mid + 1; else return mid + 1; // 1-based
		}
		return 1;
	};

	// First pass: scan comment tokens for suppression directives
	for (const t of toks) {
		if (t.kind === 'comment-line') {
			const raw = t.value.replace(/^\s*\/\//, '');
			const ln = lineOf(t.span.end);
			collectDiagDirective(raw, ln, t.span.start, t.span.end);
		} else if (t.kind === 'comment-block') {
			// Support directives inside block comments by scanning lines within
			const body = t.value.slice(2, Math.max(2, t.value.length - 2));
			const lines = body.split(/\r?\n/);
			let cur = t.span.start + 2;
			for (const L of lines) {
				const m = /lsl-(disable-next-line|disable-line|disable|enable)\b(.*)$/i.exec(L.trim());
				if (m) {
					const ln = lineOf(cur + L.length);
					collectDiagDirective(m[0], ln, cur, cur + L.length);
				}
				cur += L.length + 1;
			}
		}
	}

	// Second pass: walk directives to compute disabledRanges and includes/macros
	for (const t of toks) {
		if (t.kind !== 'directive') continue;
		const raw = t.value;
		const m = /^#\s*(\w+)([\s\S]*)$/.exec(raw);
		if (!m) continue;
		const head = m[1]!.toLowerCase();
		const restRaw = (m[2] || '');
		// Extract trailing line comment (if any) for suppression
		const trailingCommentMatch = /\/\/([^\n\r]*)$/.exec(restRaw);
		if (trailingCommentMatch) {
			const lineNo = lineOf(t.span.end);
			collectDiagDirective(trailingCommentMatch[1] || '', lineNo, t.span.start, t.span.end);
		}
		const rest = restRaw.replace(/\/\/.*$/, '').trim();
		const ancestorsActive = stack.slice(0, -1).every(f => f.enabled);
		const startAfter = t.span.end; // start of disabled content after this directive
		if (head === 'if') {
			const enabled = isActive() && evalExprQuick(rest, localMacros, funcMacros);
			stack.push({ enabled, sawElse: false, taken: enabled });
			if (!enabled) disabledRanges.push({ start: startAfter, end: -1 });
			// validate #if expression for diagnostics
			// validation is handled by collectDiagnostics below
			continue;
		}
		if (head === 'ifdef' || head === 'ifndef') {
			const name = rest.split(/\s+/)[0] || '';
			const present = Object.prototype.hasOwnProperty.call(localMacros, name) || Object.prototype.hasOwnProperty.call(funcMacros, name);
			const enabled = head === 'ifdef' ? (isActive() && present) : (isActive() && !present);
			stack.push({ enabled, sawElse: false, taken: enabled });
			if (!enabled) disabledRanges.push({ start: startAfter, end: -1 });
			continue;
		}
		if (head === 'elif') {
			const top = stack[stack.length - 1]; if (!top) continue;
			if (top.sawElse) { top.enabled = false; continue; }
			let newEnabled = false;
			if (!top.taken && ancestorsActive) { newEnabled = evalExprQuick(rest, localMacros, funcMacros); if (newEnabled) top.taken = true; }
			if (top.enabled !== newEnabled) {
				if (top.enabled && !newEnabled) { disabledRanges.push({ start: startAfter, end: -1 }); }
				else if (!top.enabled && newEnabled) { closeOpen(t.span.start); }
				top.enabled = newEnabled;
			}
			continue;
		}
		if (head === 'else') {
			const top = stack[stack.length - 1]; if (!top) continue; top.sawElse = true;
			const shouldEnable = ancestorsActive && !top.taken;
			if (top.enabled !== shouldEnable) {
				if (top.enabled && !shouldEnable) { disabledRanges.push({ start: startAfter, end: -1 }); }
				else if (!top.enabled && shouldEnable) { closeOpen(t.span.start); }
				top.enabled = shouldEnable;
			}
			continue;
		}
		if (head === 'endif') {
			const top = stack.pop();
			if (top && !top.enabled) { closeOpen(t.span.start); }
			continue;
		}
		// Only apply defines/undefs/includes in active regions
		if (!isActive()) continue;
		if (head === 'define') {
			// Function-like macro only when '(' is immediately after the name (no whitespace)
			// Examples:
			//   #define F(x,y) (x + y)   -> function-like
			//   #define F (1 + 1)       -> object-like with body "(1 + 1)"
			const mm = /^([A-Za-z_]\w*)(\(([^)]*)\))?(?:\s+([\s\S]*))?$/.exec(rest);
			if (mm) {
				const name = mm[1]!;
				const hasParams = !!mm[2];
				const bodyRaw = (mm[4] ? String(mm[4]).replace(/[ \t]+$/gm, '') : '').trim();
				if (hasParams) { funcMacros[name] = `(${(mm[3] || '').trim()})${bodyRaw ? ' ' + bodyRaw : ''}`; delete localMacros[name]; }
				else { localMacros[name] = parseMacroValueCompat(bodyRaw.length ? bodyRaw : '1'); delete funcMacros[name]; }
			}
			continue;
		}
		if (head === 'undef') { const name = rest.split(/\s+/)[0]; delete localMacros[name]; delete funcMacros[name]; continue; }
		if (head === 'include') {
			const target = parseIncludeTargetCompat(rest);
			if (!target) continue;
			const inc = resolveInclude ? resolveInclude(target, opts.fromPath) : null;
			if (inc) {
				includeTargets.push({ start: t.span.start, end: t.span.end, file: target, resolved: inc.id });
				// Merge macros from included file at this point in a guard-aware way.
				// Build initial defines that include both object- and function-like macros so `defined(NAME)` works for either.
				const initialDefs: MacroDefines = { ...localMacros };
				for (const [fk, fv] of Object.entries(funcMacros)) initialDefs[fk] = fv;
				const nested = new MacroConditionalProcessor(inc.tokens, { resolveInclude, fromId: inc.id, includeStack: (opts.fromPath ? [opts.fromPath] : []).concat([inc.id]) });
				const r = nested.processToMacros(initialDefs);
				// Only consider actual changes introduced by the include (new defines, redefines, or undefs)
				for (const k of r.changedKeys) {
					const hadBefore = Object.prototype.hasOwnProperty.call(initialDefs, k);
					const hasAfter = Object.prototype.hasOwnProperty.call(r.macros, k);
					if (!hasAfter) {
						// undef: remove from local macro tables
						delete localMacros[k];
						delete funcMacros[k];
						continue;
					}
					const v = r.macros[k];
					// Use the same strict function-like detection used elsewhere
					const isFunc = (typeof v === 'string' && fnHeadRe.test(v));
					const hasLocalObj = Object.prototype.hasOwnProperty.call(localMacros, k);
					const hasLocalFn = Object.prototype.hasOwnProperty.call(funcMacros, k);
					if (hadBefore && (hasLocalObj || hasLocalFn)) {
						// Real redefinition by the include; report duplicate and keep local value
						preprocDiagnostics.push({ start: t.span.start, end: t.span.end, message: `Duplicate macro ${k}`, code: 'LSL-preproc' });
						continue;
					}
					// New macro from include: adopt it into the appropriate table
					if (isFunc) { funcMacros[k] = v as string; delete localMacros[k]; }
					else { localMacros[k] = v; delete funcMacros[k]; }
				}
			} else {
				includeTargets.push({ start: t.span.start, end: t.span.end, file: target, resolved: null });
				missingIncludes.push({ start: t.span.start, end: t.span.end, file: target });
			}
			continue;
		}
	}
	// Close any open disabled region to EOF
	const open = openOrNull(); if (open) open.end = text.length;

	// Also detect Git merge conflict blocks in raw text and treat them as disabled ranges for AST/diagnostics.
	// This prevents spurious LSL000 errors originating from conflict markers/content.
	try {
		for (const blk of findMergeConflictBlocksCompat(text)) {
			disabledRanges.push({ start: blk.start, end: blk.end });
		}
	} catch { /* optional */ }
	// Normalize ranges (ensure within [0, text.length])
	for (const r of disabledRanges) { if (r.start < 0) r.start = 0; if (r.end < r.start) r.end = r.start; if (r.end > text.length) r.end = text.length; }
	// Sort and merge disabled ranges to satisfy lexer binary search expectations
	disabledRanges.sort((a, b) => a.start - b.start || a.end - b.end);
	if (disabledRanges.length > 1) {
		const merged: { start: number; end: number }[] = [];
		let cur = { ...disabledRanges[0]! };
		for (let i = 1; i < disabledRanges.length; i++) {
			const r = disabledRanges[i]!;
			if (r.start <= cur.end) { cur.end = Math.max(cur.end, r.end); }
			else { merged.push(cur); cur = { ...r }; }
		}
		merged.push(cur);
		disabledRanges.splice(0, disabledRanges.length, ...merged);
	}
	// Close any open disable blocks to EOF
	while (openDisableBlocks.length > 0) {
		const b = openDisableBlocks.pop()!;
		diagDirectives.blocks.push({ start: b.start, end: text.length, codes: b.codes || null });
	}

	// Collect conditional groups and preprocessor diagnostics on the root file only
	let conditionalGroups: ConditionalGroup[] | undefined;
	try {
		const cg = mcp.collectConditionalGroups(localMacros);
		conditionalGroups = cg.groups;
	} catch { /* optional */ }

	try {
		const diags = mcp.collectDiagnostics(localMacros);
		preprocDiagnostics.push(...diags);
	} catch { /* optional */ }

	// diagDirectives.blocks already computed precisely above

	return { macros: localMacros, funcMacros, includes, disabledRanges, includeTargets, missingIncludes, preprocDiagnostics, diagDirectives, conditionalGroups };
}

// Local helpers mirroring macroConditional behavior
function evalExprQuick(expr: string, defs: import('./macro').MacroDefines, fnDefs?: Record<string, string>): boolean {
	type Tok = { kind: 'num'; value: number } | { kind: 'ident'; value: string } | { kind: 'op'; value: string } | { kind: 'lparen' } | { kind: 'rparen' };
	const s = expr.trim();
	if (!s) return false;

	const toks: Tok[] = [];
	let i = 0;
	const twoOps = new Set(['&&', '||', '==', '!=', '<=', '>=']);
	while (i < s.length) {
		const ch = s[i]!;
		if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r') { i++; continue; }
		const two = s.slice(i, i + 2);
		if (twoOps.has(two)) { toks.push({ kind: 'op', value: two }); i += 2; continue; }
		if ('+-*/%<>!'.includes(ch)) { toks.push({ kind: 'op', value: ch }); i++; continue; }
		if (ch === '(') { toks.push({ kind: 'lparen' }); i++; continue; }
		if (ch === ')') { toks.push({ kind: 'rparen' }); i++; continue; }
		if (/[0-9]/.test(ch)) {
			let j = i + 1;
			while (j < s.length && /[0-9]/.test(s[j]!)) j++;
			toks.push({ kind: 'num', value: Number(s.slice(i, j)) });
			i = j; continue;
		}
		if (/[A-Za-z_]/.test(ch)) {
			let j = i + 1;
			while (j < s.length && /[A-Za-z0-9_]/.test(s[j]!)) j++;
			toks.push({ kind: 'ident', value: s.slice(i, j) });
			i = j; continue;
		}
		i++;
	}

	let p = 0;
	const peek = () => toks[p];
	const take = () => toks[p++];
	const peekOp = () => (peek() && peek()!.kind === 'op') ? (peek() as Extract<Tok, { kind: 'op' }>).value : undefined;
	const takeOp = () => {
		const tk = take();
		return tk && tk.kind === 'op' ? tk.value : undefined;
	};
	const truthy = (v: number) => v !== 0;
	const valOfIdent = (name: string): number => {
		const v = defs[name];
		if (v === undefined) return (fnDefs && Object.prototype.hasOwnProperty.call(fnDefs, name)) ? 1 : 0;
		if (typeof v === 'number') return v;
		if (typeof v === 'boolean') return v ? 1 : 0;
		if (typeof v === 'string') {
			const vs = v.trim();
			if (/^[-+]?\d+$/.test(vs)) return Number(vs);
			const low = vs.toLowerCase();
			if (low === 'true') return 1;
			if (low === 'false') return 0;
			return vs.length > 0 ? 1 : 0;
		}
		return 1;
	};

	function parsePrimary(): number {
		const t = peek();
		if (!t) return 0;
		if (t.kind === 'num') { take(); return t.value; }
		if (t.kind === 'ident') {
			if (t.value === 'defined') {
				take();
				let name = '';
				if (peek() && peek()!.kind === 'lparen') {
					take();
					const id = take();
					if (id && id.kind === 'ident') name = id.value;
					if (peek() && peek()!.kind === 'rparen') take();
				} else {
					const id = take();
					if (id && id.kind === 'ident') name = id.value; else name = '';
				}
				return (Object.prototype.hasOwnProperty.call(defs, name) || (fnDefs ? Object.prototype.hasOwnProperty.call(fnDefs, name) : false)) ? 1 : 0;
			}
			take();
			return valOfIdent(t.value);
		}
		if (t.kind === 'lparen') {
			take();
			const v = parseOr();
			if (peek() && peek()!.kind === 'rparen') take();
			return v;
		}
		return 0;
	}

	function parseUnary(): number {
		const t = peek();
		if (t && t.kind === 'op' && (t.value === '!' || t.value === '+' || t.value === '-')) {
			take();
			const v = parseUnary();
			if (t.value === '!') return truthy(v) ? 0 : 1;
			if (t.value === '+') return +v;
			return -v;
		}
		return parsePrimary();
	}

	function parseMul(): number {
		let v = parseUnary();
		while (peekOp() && ['*', '/', '%'].includes(peekOp()!)) {
			const op = takeOp()!;
			const r = parseUnary();
			if (op === '*') v = v * r; else if (op === '/') v = Math.trunc(v / r); else v = v % r;
		}
		return v;
	}

	function parseAdd(): number {
		let v = parseMul();
		while (peekOp() && ['+', '-'].includes(peekOp()!)) {
			const op = takeOp()!;
			const r = parseMul();
			if (op === '+') v = v + r; else v = v - r;
		}
		return v;
	}

	function parseRel(): number {
		let v = parseAdd();
		while (peekOp() && ['<', '>', '<=', '>='].includes(peekOp()!)) {
			const op = takeOp()!;
			const r = parseAdd();
			if (op === '<') v = v < r ? 1 : 0;
			else if (op === '>') v = v > r ? 1 : 0;
			else if (op === '<=') v = v <= r ? 1 : 0;
			else v = v >= r ? 1 : 0;
		}
		return v;
	}

	function parseEq(): number {
		let v = parseRel();
		while (peekOp() && ['==', '!='].includes(peekOp()!)) {
			const op = takeOp()!;
			const r = parseRel();
			if (op === '==') v = v === r ? 1 : 0; else v = v !== r ? 1 : 0;
		}
		return v;
	}

	function parseAnd(): number {
		let v = parseEq();
		while (peekOp() === '&&') {
			takeOp();
			const r = parseEq();
			v = truthy(v) && truthy(r) ? 1 : 0;
		}
		return v;
	}

	function parseOr(): number {
		let v = parseAnd();
		while (peekOp() === '||') {
			takeOp();
			const r = parseAnd();
			v = truthy(v) || truthy(r) ? 1 : 0;
		}
		return v;
	}

	const result = parseOr();
	return truthy(result);
}
function parseMacroValueCompat(v: string): string | number | boolean {
	const num = Number(v);
	if (!Number.isNaN(num)) return num;
	if (v === 'true' || v === 'TRUE') return true;
	if (v === 'false' || v === 'FALSE') return false;
	if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith('\'') && v.endsWith('\''))) return v;
	return v;
}
function parseIncludeTargetCompat(rest: string): string | null {
	const s = rest.replace(/\/\/.*$/, '').trim();
	const q1 = s.indexOf('"'); if (q1 >= 0) { const q2 = s.indexOf('"', q1 + 1); if (q2 > q1 + 1) return s.slice(q1 + 1, q2); }
	const a1 = s.indexOf('<'); if (a1 >= 0) { const a2 = s.indexOf('>', a1 + 1); if (a2 > a1 + 1) return s.slice(a1 + 1, a2); }
	return null;
}

// Detect Git merge conflict blocks in raw text; returns spans including marker lines.
function findMergeConflictBlocksCompat(text: string): { start: number; end: number }[] {
	const res: { start: number; end: number }[] = [];
	let pos = 0;
	while (pos < text.length) {
		const a = text.indexOf('<<<<<<< ', pos);
		if (a < 0) break;
		// find separator ======= after begin
		const sep = text.indexOf('\n=======', a); // ensures it's at line start likely
		if (sep < 0) { pos = a + 1; continue; }
		// find end marker >>>>>>> after sep
		const endMarkerIdx = text.indexOf('\n>>>>>>> ', sep);
		if (endMarkerIdx < 0) { pos = a + 1; continue; }
		// Block end is end of the end marker line
		const lineEnd = text.indexOf('\n', endMarkerIdx + 1);
		const bEnd = lineEnd >= 0 ? lineEnd + 1 : text.length;
		res.push({ start: a, end: bEnd });
		pos = bEnd;
	}
	return res;
}
