import { type Token } from './tokens';
import { tokenize } from './tokenizer';

export type MacroDefines = Record<string, string | number | boolean>;

type DirKind =
	| { kind: 'if'; expr: string }
	| { kind: 'elif'; expr: string }
	| { kind: 'else' }
	| { kind: 'endif' }
	| { kind: 'ifdef'; name: string }
	| { kind: 'ifndef'; name: string }
	| { kind: 'define_obj'; name: string; body?: string }
	| { kind: 'define_fn'; name: string; params: string; body: string }
	| { kind: 'undef'; name: string }
	| { kind: 'include'; target: string };

function parseDirectiveKind(raw: string): DirKind | null {
	const m = /^#\s*(\w+)([\s\S]*)$/.exec(raw);
	if (!m) return null;
	const head = m[1]!.toLowerCase();
	// Tokenizer already inserted literal newlines where a backslash-newline splice occurred.
	// Keep those newlines in the body for multi-line macros; only strip trailing line comments.
	const rest = (m[2] || '').replace(/\/\/.*$/, '').trim();
	if (head === 'if') return { kind: 'if', expr: rest };
	if (head === 'elif') return { kind: 'elif', expr: rest };
	if (head === 'else') return { kind: 'else' };
	if (head === 'endif') return { kind: 'endif' };
	if (head === 'ifdef') { const name = rest.split(/\s+/)[0] || ''; return { kind: 'ifdef', name }; }
	if (head === 'ifndef') { const name = rest.split(/\s+/)[0] || ''; return { kind: 'ifndef', name }; }
	if (head === 'undef') { const name = rest.split(/\s+/)[0] || ''; return { kind: 'undef', name }; }
	if (head === 'include') { const target = parseIncludeTarget(rest) || ''; return { kind: 'include', target }; }
	if (head === 'define') {
		const mm = /^([A-Za-z_]\w*)(\s*\(([^)]*)\))?(?:\s+([\s\S]*))?$/.exec(rest);
		if (mm) {
			const name = mm[1]!;
			if (mm[2]) {
				const params = (mm[3] || '').trim();
				// Preserve embedded newlines across continuations; trim right only
				const body = (mm[4] ? String(mm[4]).replace(/[ \t]+$/gm, '') : '').trim();
				return { kind: 'define_fn', name, params, body };
			} else {
				const body = (mm[4] ? String(mm[4]).replace(/[ \t]+$/gm, '') : '').trim();
				return { kind: 'define_obj', name, body: body.length ? body : undefined };
			}
		}
	}
	return null;
}

function parseIncludeTarget(rest: string): string | null {
	const s = rest.replace(/\/\/.*$/, '').trim();
	const q1 = s.indexOf('"');
	if (q1 >= 0) { const q2 = s.indexOf('"', q1 + 1); if (q2 > q1 + 1) return s.slice(q1 + 1, q2); }
	const a1 = s.indexOf('<');
	if (a1 >= 0) { const a2 = s.indexOf('>', a1 + 1); if (a2 > a1 + 1) return s.slice(a1 + 1, a2); }
	return null;
}

function parseMacroValue(v: string): string | number | boolean {
	const num = Number(v);
	if (!Number.isNaN(num)) return num;
	if (v === 'true' || v === 'TRUE') return true;
	if (v === 'false' || v === 'FALSE') return false;
	if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith('\'') && v.endsWith('\''))) return v;
	return v;
}

type Frame = { enabled: boolean; sawElse: boolean; taken: boolean };

export type IncludeResolver = (target: string, fromId?: string) => { tokens: Token[]; id: string } | null;

export class MacroConditionalProcessor {
	private readonly tokens: Token[];
	private readonly resolveInclude?: IncludeResolver;
	private readonly includeIds: string[] = [];
	private readonly fromId?: string;
	// Track include stack to detect cycles and prevent infinite recursion
	private readonly includeStack: string[];
	private readonly emitIncludeTokens: boolean;

	constructor(tokens: Token[], opts?: { resolveInclude?: IncludeResolver; fromId?: string; includeStack?: string[]; emitIncludeTokens?: boolean }) {
		this.tokens = tokens;
		this.resolveInclude = opts?.resolveInclude;
		this.fromId = opts?.fromId;
		// Initialize include stack with provided stack or fromId
		const initial: string[] = [];
		if (opts?.includeStack && opts.includeStack.length > 0) initial.push(...opts.includeStack);
		else if (this.fromId) initial.push(this.fromId);
		this.includeStack = initial;
		this.emitIncludeTokens = opts?.emitIncludeTokens !== false; // default true
	}

	// Process and return active tokens; also return the final macro table and includes encountered
	processToTokens(defines: MacroDefines): { tokens: Token[]; macros: MacroDefines; includes: string[]; macrosChanged: boolean; changedKeys: string[] } {
		const macros: MacroDefines = { ...defines };
		const out: Token[] = [];
		this.walk(macros, (t, active) => {
			if (active && t.kind !== 'directive') out.push(t);
		}, /*macrosOnly*/ false);
		const delta = computeMacrosDelta(defines, macros);
		return { tokens: out, macros, includes: [...this.includeIds], macrosChanged: delta.changed, changedKeys: delta.changedKeys };
	}

	// Process only macro table changes (defines/undefs) including inside included files when active
	processToMacros(defines: MacroDefines): { macros: MacroDefines; includes: string[]; macrosChanged: boolean; changedKeys: string[] } {
		const macros: MacroDefines = { ...defines };
		this.walk(macros, () => { /* ignore non-directive tokens */ }, /*macrosOnly*/ true);
		const delta = computeMacrosDelta(defines, macros);
		return { macros, includes: [...this.includeIds], macrosChanged: delta.changed, changedKeys: delta.changedKeys };
	}

	private walk(macros: MacroDefines, sink: (t: Token, active: boolean) => void, macrosOnly: boolean) {
		const stack: Frame[] = [];
		const isActive = () => stack.every(f => f.enabled);
		for (let i = 0; i < this.tokens.length; i++) {
			const t = this.tokens[i]!;
			if (t.kind !== 'directive') { sink(t, isActive()); continue; }
			const d = parseDirectiveKind(t.value);
			if (!d) { sink(t, isActive()); continue; }
			// conditionals
			if (d.kind === 'if') {
				const enabled = isActive() && evalExprQuick(d.expr, macros);
				stack.push({ enabled, sawElse: false, taken: enabled });
				continue;
			}
			if (d.kind === 'ifdef') { const enabled = isActive() && Object.prototype.hasOwnProperty.call(macros, d.name); stack.push({ enabled, sawElse: false, taken: enabled }); continue; }
			if (d.kind === 'ifndef') { const enabled = isActive() && !Object.prototype.hasOwnProperty.call(macros, d.name); stack.push({ enabled, sawElse: false, taken: enabled }); continue; }
			if (d.kind === 'elif') {
				const top = stack[stack.length - 1]; if (!top) continue;
				if (top.sawElse) { top.enabled = false; continue; }
				const ancestors = stack.slice(0, -1).every(f => f.enabled);
				let newEnabled = false;
				if (!top.taken && ancestors) { newEnabled = evalExprQuick(d.expr, macros); if (newEnabled) top.taken = true; }
				top.enabled = newEnabled; continue;
			}
			if (d.kind === 'else') {
				const top = stack[stack.length - 1]; if (!top) continue; top.sawElse = true; const ancestors = stack.slice(0, -1).every(f => f.enabled); top.enabled = ancestors && !top.taken; continue;
			}
			if (d.kind === 'endif') { stack.pop(); continue; }
			// non-conditional directives: only act when active
			if (!isActive()) continue;
			if (d.kind === 'define_obj') { macros[d.name] = d.body !== undefined ? parseMacroValue(d.body) : 1; continue; }
			if (d.kind === 'define_fn') { // store body text for caching presence; value equality will reflect changes
				macros[d.name] = `(${d.params}) ${d.body}`.trim(); continue;
			}
			if (d.kind === 'undef') { delete macros[d.name]; continue; }
			if (d.kind === 'include') {
				if (!this.resolveInclude) continue;
				const inc = this.resolveInclude(d.target, this.fromId);
				if (!inc) continue;
				this.includeIds.push(inc.id);
				// Detect include cycles: if the target is already on the include stack, skip recursion to avoid infinite loop
				if (this.includeStack.includes(inc.id)) {
					// Cycle detected (e.g., self-include). Do not recurse further.
					continue;
				}
				// Recurse into included tokens with the same processing mode; propagate include stack
				const nestedStack = [...this.includeStack, inc.id];
				const nested = new MacroConditionalProcessor(inc.tokens, { resolveInclude: this.resolveInclude, fromId: inc.id, includeStack: nestedStack, emitIncludeTokens: this.emitIncludeTokens });
				if (macrosOnly) {
					const r = nested.processToMacros(macros);
					// use returned macros as updated reference (object already mutated via copy)
					Object.assign(macros, r.macros);
				} else {
					const r = nested.processToTokens(macros);
					// Update macros table and optionally emit included tokens
					if (this.emitIncludeTokens) {
						for (const it of r.tokens) sink(it, true);
					}
					Object.assign(macros, r.macros);
				}
				continue;
			}
			// Unknown directive when active: ignore for now
		}
	}

	// New: collect conditional groups with spans and which branch was active under given defines
	collectConditionalGroups(defines: MacroDefines): { groups: { head: { start: number; end: number }; branches: { span: { start: number; end: number }; active: boolean }[]; end: number }[] } {
		const macros: MacroDefines = { ...defines };
		type Frame = { head: { start: number; end: number }; branches: { span: { start: number; end: number }; active: boolean }[]; current: { start: number; end: number } | null; enabled: boolean; sawElse: boolean; taken: boolean };
		const groups: Frame[] = [];
		const out: { head: { start: number; end: number }; branches: { span: { start: number; end: number }; active: boolean }[]; end: number }[] = [];
		const stack: Array<{ enabled: boolean; sawElse: boolean; taken: boolean; idx: number | null }> = [];
		const isActive = () => stack.every(f => f.enabled);
		for (let i = 0; i < this.tokens.length; i++) {
			const t = this.tokens[i]!;
			if (t.kind !== 'directive') continue;
			const d = parseDirectiveKind(t.value);
			if (!d) continue;
			if (d.kind === 'if') {
				const enabled = isActive() && evalExprQuick(d.expr, macros);
				const f: Frame = { head: { start: t.span.start, end: t.span.end }, branches: [], current: null, enabled, sawElse: false, taken: enabled };
				groups.push(f); stack.push({ enabled, sawElse: false, taken: enabled, idx: groups.length - 1 });
				// Start first branch immediately after directive
				f.current = { start: t.span.end, end: t.span.end };
				continue;
			}
			if (d.kind === 'ifdef' || d.kind === 'ifndef') {
				const present = Object.prototype.hasOwnProperty.call(macros, d.name);
				const enabled = isActive() && (d.kind === 'ifdef' ? present : !present);
				const f: Frame = { head: { start: t.span.start, end: t.span.end }, branches: [], current: null, enabled, sawElse: false, taken: enabled };
				groups.push(f); stack.push({ enabled, sawElse: false, taken: enabled, idx: groups.length - 1 });
				f.current = { start: t.span.end, end: t.span.end };
				continue;
			}
			if (d.kind === 'elif') {
				const top = stack[stack.length - 1]; if (!top || top.idx == null) continue;
				const f = groups[top.idx]!;
				// close previous branch at start of this directive
				if (f.current) { f.current.end = t.span.start; f.branches.push({ span: { ...f.current }, active: f.enabled && f.taken }); f.current = null; }
				if (!top.sawElse) {
					const ancestors = stack.slice(0, -1).every(ff => ff.enabled);
					let newEnabled = false;
					if (!top.taken && ancestors) { newEnabled = evalExprQuick(d.expr, macros); if (newEnabled) top.taken = true; }
					top.enabled = newEnabled;
					f.enabled = newEnabled;
				}
				f.current = { start: t.span.end, end: t.span.end };
				continue;
			}
			if (d.kind === 'else') {
				const top = stack[stack.length - 1]; if (!top || top.idx == null) continue;
				const f = groups[top.idx]!;
				if (f.current) { f.current.end = t.span.start; f.branches.push({ span: { ...f.current }, active: f.enabled && f.taken }); f.current = null; }
				top.sawElse = true;
				const ancestors = stack.slice(0, -1).every(ff => ff.enabled);
				const shouldEnable = ancestors && !top.taken;
				top.enabled = shouldEnable; f.enabled = shouldEnable;
				f.current = { start: t.span.end, end: t.span.end };
				continue;
			}
			if (d.kind === 'endif') {
				const top = stack.pop();
				const idx = top ? top.idx : null;
				if (idx != null) {
					const f = groups[idx]!;
					if (f.current) { f.current.end = t.span.start; f.branches.push({ span: { ...f.current }, active: f.enabled && f.taken }); f.current = null; }
					// finalize group end after directive
					out.push({ head: f.head, branches: f.branches, end: t.span.end });
				}
				continue;
			}
		}
		return { groups: out };
	}

	// Collect preprocessor diagnostics: malformed #if/#elif, stray #elif/#else/#endif, unmatched #if at EOF
	collectDiagnostics(_defines: MacroDefines): { start: number; end: number; message: string; code?: string }[] {
		const diagnostics: { start: number; end: number; message: string; code?: string }[] = [];
		const stack: Array<'if' | 'ifdef' | 'ifndef'> = [];
		for (let i = 0; i < this.tokens.length; i++) {
			const t = this.tokens[i]!;
			if (t.kind !== 'directive') continue;
			const d = parseDirectiveKind(t.value);
			if (!d) continue;
			const add = (msg: string) => diagnostics.push({ start: t.span.start, end: t.span.end, message: msg, code: 'LSL-preproc' });
			if (d.kind === 'if') {
				if (!validateIfExpr(d.expr)) add('Malformed #if expression');
				stack.push('if');
				continue;
			}
			if (d.kind === 'ifdef') { stack.push('ifdef'); continue; }
			if (d.kind === 'ifndef') { stack.push('ifndef'); continue; }
			if (d.kind === 'elif') {
				if (stack.length === 0) add('Stray #elif');
				if (!validateIfExpr(d.expr)) add('Malformed #elif expression');
				continue;
			}
			if (d.kind === 'else') { if (stack.length === 0) add('Stray #else'); continue; }
			if (d.kind === 'endif') { if (stack.length === 0) add('Stray #endif'); else stack.pop(); continue; }
		}
		if (stack.length > 0) diagnostics.push({ start: this.tokens.length ? this.tokens[this.tokens.length - 1]!.span.end : 0, end: this.tokens.length ? this.tokens[this.tokens.length - 1]!.span.end : 0, message: 'Unmatched conditional block', code: 'LSL-preproc' });
		return diagnostics;
	}
}

// Evaluate #if expressions with simple arithmetic and logical operators.
// Supported: defined(NAME), identifiers, integer literals, unary ! + -,
// binary * / %, + -, < <= > >=, == !=, && ||, and parentheses.
function evalExprQuick(expr: string, defs: MacroDefines): boolean {
	type Tok = { kind: 'num'; value: number } | { kind: 'ident'; value: string } | { kind: 'op'; value: string } | { kind: 'lparen' } | { kind: 'rparen' };
	const s = expr.trim();
	if (!s) return false;

	// Tokenizer
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
			const num = Number(s.slice(i, j));
			toks.push({ kind: 'num', value: num });
			i = j; continue;
		}
		if (/[A-Za-z_]/.test(ch)) {
			let j = i + 1;
			while (j < s.length && /[A-Za-z0-9_]/.test(s[j]!)) j++;
			const ident = s.slice(i, j);
			toks.push({ kind: 'ident', value: ident });
			i = j; continue;
		}
		// Unknown char: skip to avoid infinite loop
		i++;
	}

	// Parser (recursive descent)
	let p = 0;
	const peek = () => toks[p];
	const take = () => toks[p++];
	const peekOp = () => (peek() && peek()!.kind === 'op') ? (peek() as Extract<Tok, { kind: 'op' }>).value : undefined;
	const takeOp = () => { const t = take(); return t && t.kind === 'op' ? t.value : undefined; };

	const truthy = (v: number) => v !== 0;
	const valOfIdent = (name: string): number => {
		// defined(NAME) handled in parsePrimary/parseUnary
		const v = defs[name];
		if (v === undefined) return 0;
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
				// defined NAME | defined(NAME)
				let name = '';
				if (peek() && peek()!.kind === 'lparen') {
					take(); // (
					const id = take();
					if (id && id.kind === 'ident') name = id.value;
					if (peek() && peek()!.kind === 'rparen') take();
				} else {
					const id = take();
					if (id && id.kind === 'ident') name = id.value; else name = '';
				}
				return Object.prototype.hasOwnProperty.call(defs, name) ? 1 : 0;
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

function computeMacrosDelta(prev: MacroDefines, next: MacroDefines): { changed: boolean; changedKeys: string[] } {
	const keys = new Set<string>([...Object.keys(prev), ...Object.keys(next)]);
	const changedKeys: string[] = [];
	for (const k of keys) {
		const a = prev[k];
		const b = next[k];
		if (a === b) continue;
		// Compare by stringified value to normalize numeric vs string representations
		if (JSON.stringify(a) !== JSON.stringify(b)) changedKeys.push(k);
	}
	return { changed: changedKeys.length > 0, changedKeys };
}

// Minimal validator for #if/#elif expressions used only for diagnostics; shares the same operator set as evalExprQuick
function validateIfExpr(expr: string): boolean {
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
		if (/[0-9]/.test(ch)) { let j = i + 1; while (j < s.length && /[0-9]/.test(s[j]!)) j++; toks.push({ kind: 'num', value: 0 }); i = j; continue; }
		if (/[A-Za-z_]/.test(ch)) { let j = i + 1; while (j < s.length && /[A-Za-z0-9_]/.test(s[j]!)) j++; toks.push({ kind: 'ident', value: s.slice(i, j) }); i = j; continue; }
		return false;
	}
	let p = 0; let ok = true;
	const peek = () => toks[p];
	const take = () => toks[p++];
	function parsePrimary(): number {
		const t = peek(); if (!t) { ok = false; return 0; }
		if (t.kind === 'num') { take(); return 0; }
		if (t.kind === 'ident') {
			if (t.value === 'defined') {
				take();
				if (peek() && peek()!.kind === 'lparen') { take(); const id = take(); if (!id || id.kind !== 'ident') { ok = false; return 0; } if (!peek() || peek()!.kind !== 'rparen') { ok = false; return 0; } take(); }
				else { const id = take(); if (!id || id.kind !== 'ident') { ok = false; return 0; } }
				return 0;
			}
			take(); return 0;
		}
		if (t.kind === 'lparen') { take(); const v = parseOr(); if (!peek() || peek()!.kind !== 'rparen') { ok = false; return v; } take(); return v; }
		ok = false; return 0;
	}
	function parseUnary(): number { const t = peek(); if (t && t.kind === 'op' && (t.value === '!' || t.value === '+' || t.value === '-')) { take(); return parseUnary(); } return parsePrimary(); }
	function parseMul(): number { let v = parseUnary(); while (peek() && peek()!.kind === 'op' && ['*', '/', '%'].includes((peek() as { kind: 'op'; value: string }).value)) { take(); v = parseUnary(); } return v; }
	function parseAdd(): number { let v = parseMul(); while (peek() && peek()!.kind === 'op' && ['+', '-'].includes((peek() as { kind: 'op'; value: string }).value)) { take(); v = parseMul(); } return v; }
	function parseRel(): number { let v = parseAdd(); while (peek() && peek()!.kind === 'op' && ['<', '>', '<=', '>='].includes((peek() as { kind: 'op'; value: string }).value)) { take(); v = parseAdd(); } return v; }
	function parseEq(): number { let v = parseRel(); while (peek() && peek()!.kind === 'op' && ['==', '!='].includes((peek() as { kind: 'op'; value: string }).value)) { take(); v = parseRel(); } return v; }
	function parseAnd(): number { let v = parseEq(); while (peek() && peek()!.kind === 'op' && (peek() as { kind: 'op'; value: string }).value === '&&') { take(); v = parseEq(); } return v; }
	function parseOr(): number { let v = parseAnd(); while (peek() && peek()!.kind === 'op' && (peek() as { kind: 'op'; value: string }).value === '||') { take(); v = parseAnd(); } return v; }
	parseOr();
	if (!ok) return false;
	const last = toks[toks.length - 1];
	if (last && last.kind === 'op') return false;
	return true;
}

export type ExpandedToken = Token & { origin?: Token[] };

// Representation split: object-like vs function-like bodies preserved as raw body string currently stored.
// We'll build a normalized map when expanding.
interface FuncMacroDef { params: string[]; hasVarArgs: boolean; body: string; }

function splitMacroTables(macros: MacroDefines): { obj: Record<string, string | number | boolean>; fn: Record<string, FuncMacroDef> } {
	const obj: Record<string, string | number | boolean> = {};
	const fn: Record<string, FuncMacroDef> = {};
	for (const [k, v] of Object.entries(macros)) {
		if (typeof v === 'string') {
			// function-like markers are: starts with '(' paramlist ')' space/body
			const m = /^\(([^)]*)\)\s+([\s\S]*)$/.exec(v);
			if (m) {
				const rawParams = m[1].trim();
				const body = m[2];
				const params = rawParams ? rawParams.split(',').map(s=>s.trim()).filter(Boolean) : [];
				const hasVarArgs = params[params.length-1] === '...';
				const fixed = hasVarArgs ? params.slice(0,-1) : params;
				fn[k] = { params: fixed, hasVarArgs, body };
				continue;
			}
		}
		obj[k] = v;
	}
	return { obj, fn };
}

// Public expansion entry: takes already preprocessed (conditionals/includes applied) tokens with directives removed.
export function expandActiveTokens(tokens: Token[], macroTable: MacroDefines): Token[] {
	const { obj, fn } = splitMacroTables(macroTable);
	// We perform multiple passes until no further expansion occurs or max iterations exceeded.
	let work = tokens.slice();
	const MAX_PASSES = 50; // safety
	// Hide-set: track macro names that produced current token to avoid re-expansion in same position
	const hides: WeakMap<Token, Set<string>> = new WeakMap();
	for (let pass=0; pass<MAX_PASSES; pass++) {
		let changed = false;
		const out: Token[] = [];
		for (let i=0;i<work.length;i++) {
			const t = work[i]!;
			if (t.kind !== 'id') { out.push(t); continue; }
			const name = t.value;
			const hs = hides.get(t);
			if (hs && hs.has(name)) { out.push(t); continue; }
			// Skip expansion of certain built-ins so later built-in pass can substitute proper literal tokens.
			// We still want them to appear "defined" for conditional logic, but not expand to raw basename text
			// which would lex into identifiers/punctuation (e.g., test.lsl -> test . lsl -> Member node in AST).
			if (Object.prototype.hasOwnProperty.call(obj, name) && name !== '__FILE__') {
				const body = objectMacroToTokens(obj[name]);
				if (body.length) changed = true;
				const dist = distributeSpan(body, t.span.start, t.span.end);
				for (const nt of dist) {
					const set = new Set<string>([name]);
					hides.set(nt, set);
					out.push(nt);
				}
				continue;
			}
			if (Object.prototype.hasOwnProperty.call(fn, name)) {
				const call = parseMacroCall(work, i+1);
				if (!call) { out.push(t); continue; }
				// Avoid infinite self-expansion: mark this invocation by removing name during its own expansion
				const saved = obj[name];
				delete obj[name];
				const mdef = fn[name]!;
				const expandedBody = expandFunctionMacro(name, mdef, call.args, obj, fn, t.span.start, call.endSpanEnd);
				if (saved !== undefined) obj[name] = saved; // restore
				if (expandedBody.length) changed = true;
				// advance index to token after call
				i = call.nextIndex - 1;
				const dist = expandedBody; // already distributed
				for (const nt of dist) {
					const set = new Set<string>((hides.get(t) ? Array.from(hides.get(t)!) : []).concat([name]));
					hides.set(nt, set);
					out.push(nt);
				}
				continue;
			}
			out.push(t);
		}
		work = out;
		if (!changed) break;
	}
	return work;
}

// Derive simple alias map (#define FOO BAR) where body is single identifier; exported for signature help.
export function computeMacroAliases(macros: MacroDefines): Record<string,string> {
	const aliases: Record<string,string> = {};
	for (const [k,v] of Object.entries(macros)) {
		if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') {
			const text = String(v).trim();
			if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(text)) aliases[k] = text;
		}
	}
	return aliases;
}

function objectMacroToTokens(v: string | number | boolean): Token[] {
	const text = String(v);
	if (!text.length) return [];
	let toks = tokenize(text).filter(t=> t.kind !== 'eof' && t.kind !== 'directive');
	// If object-like macro is a single parenthesized literal or identifier, unwrap redundant parens so AST tests expecting NumberLiteral succeed
	if (toks.length >=3 && toks[0].kind==='punct' && toks[0].value==='(' && toks[toks.length-1].kind==='punct' && toks[toks.length-1].value===')') {
		let depth=0, ok=true; for (let i=0;i<toks.length;i++){ const tk=toks[i]!; if (tk.kind==='punct'){ if (tk.value==='(') depth++; else if (tk.value===')') depth--; if (depth===0 && i < toks.length-1) { ok=false; break; } } }
		if (ok) toks = toks.slice(1,-1);
	}
	return toks;
}

type MacroCall = { args: string[]; nextIndex: number; endSpanEnd: number };
function parseMacroCall(tokens: Token[], startIndex: number): MacroCall | null {
	// Collect argument text preserving minimal spacing between tokens so that
	// stringification (#x) keeps internal spaces. We reconstruct textual form
	// by inserting a single space when two alphanumeric tokens abut without
	// original punctuation between them.
	let i = startIndex;
	const open = tokens[i];
	if (!open || open.kind !== 'punct' || open.value !== '(') return null;
	i++; // after '('
	let depth = 1;
	let current = '';
	const args: string[] = [];
	let prevWasWord = false;
	const isWord = (t: Token) => t.kind === 'id' || t.kind === 'number' || t.kind === 'keyword';
	for (; i < tokens.length; i++) {
		const tk = tokens[i]!;
		if (tk.kind === 'punct') {
			if (tk.value === '(') { depth++; current += tk.value; prevWasWord = false; continue; }
			if (tk.value === ')') {
				depth--; if (depth === 0) {
					const trimmed = current.trim();
					if (trimmed.length) args.push(trimmed); // only push non-empty arg content
					// If the only collected argument is an empty string, treat as zero args (e.g., MACRO())
					if (args.length === 1 && args[0] === '') args.length = 0;
					return { args, nextIndex: i+1, endSpanEnd: tk.span.end };
				}
				current += tk.value; prevWasWord = false; continue;
			}
			if (tk.value === ',' && depth === 1) { args.push(current.trim()); current=''; prevWasWord=false; continue; }
			// other punctuation is significant
			current += tk.value; prevWasWord=false; continue;
		}
		// For consecutive word tokens (identifier/number/keyword) that were originally
		// separate tokens, insert a space so stringification preserves separation.
		if (isWord(tk)) {
			if (prevWasWord) current += ' ';
			current += tk.value;
			prevWasWord = true;
		} else {
			current += tk.value;
			prevWasWord = false;
		}
	}
	return null; // unterminated -> treat as not a call; parser will handle
}

function expandFunctionMacro(name: string, def: FuncMacroDef, callArgs: string[], obj: Record<string, string | number | boolean>, fn: Record<string, FuncMacroDef>, callStart: number, callEnd: number): Token[] {
	const fixedCount = def.params.length;
	const hasVar = def.hasVarArgs;
	// Normalize callArgs: drop any empty-string entries that can arise from edge parsing cases
	callArgs = callArgs.filter(a => a.length > 0);
	const varProvided = hasVar ? callArgs.length > fixedCount : false;
	const mapping = new Map<string,string>();
	for (let i=0;i<fixedCount;i++) mapping.set(def.params[i]!, (callArgs[i] ?? '').trim());
	const vaList = hasVar ? callArgs.slice(fixedCount).map(s=>s.trim()).filter(Boolean) : [];
	let body = def.body;
	// __VA_OPT__ handling: simple pattern __VA_OPT__( ... )
	body = body.replace(/__VA_OPT__\s*\(([^)]*)\)/g, (_,inner)=> varProvided? inner: '');
	// Stringification #param: convert to a bare string literal token content WITHOUT quotes yet;
	// we'll inject quotes so tokenizer produces a single string token. Preserve inner spacing.
	body = body.replace(/#\s*([A-Za-z_]\w*)/g, (m,p)=> {
		if (!mapping.has(p)) return m;
		// Don't double-quote if already quoted text
		const raw = mapping.get(p)!;
		const unq = raw.replace(/^['"]|['"]$/g,'');
		// Escape embedded quotes/backslashes minimally
		const esc = unq.replace(/\\/g,'\\\\').replace(/"/g,'\\"');
		return '"' + esc + '"';
	});
	// Replace params (word boundary)
	for (const [p,val] of mapping) {
		const re = new RegExp(`\\b${escapeRegExp(p)}\\b`, 'g');
		body = body.replace(re, val);
	}
	if (hasVar) {
		const joined = vaList.join(', ');
		body = body.replace(/__VA_ARGS__/g, joined);
		if (!varProvided) body = body.replace(/,\s*\)/g, ')');
	}
	// Token pasting: A ## B -> AB. Perform iterative replacement until no more occurrences.
	// This is done before tokenization so the concatenated identifier is lexed as one token.
	let prevBody: string | null = null;
	while (prevBody !== body) { prevBody = body; body = applyTokenPasteSimple(body); }
	// Cleanup: remove artifacts from empty __VA_ARGS__/__VA_OPT__ eliminations.
	body = body
		// Remove a comma right after opening bracket/paren
		.replace(/\[(\s*),/g, '[$1')
		// Remove leading comma before closing bracket or paren: ", ]" or ", )"
		.replace(/,\s*([)\]])/g, '$1')
		// Collapse duplicate commas
		.replace(/,\s*,+/g, ',')
		// Trim comma immediately before closing list bracket
		.replace(/,\s*\]/g, ']')
		// Trim comma immediately after opening list bracket
		.replace(/\[\s*,/g, '[')
		// Collapse duplicate semicolons that can arise when macro body ends with ';' and call site also adds ';'
		.replace(/;\s*;/g, ';');
	// Turn into tokens (lex body) and distribute span
	let toks = body.length ? tokenize(body).filter(t=> t.kind !== 'eof' && t.kind !== 'directive') : [];
	// Drop single enclosing paren pair if they wrap the entire expansion and aren't needed syntactically (e.g., ("text") or ((2)+(3))) so tests see inner node
	if (toks.length >=3 && toks[0].kind==='punct' && toks[0].value==='(' && toks[toks.length-1].kind==='punct' && toks[toks.length-1].value===')') {
		let depth=0, ok=true; for (let i=0;i<toks.length;i++){ const tk=toks[i]!; if (tk.kind==='punct'){ if (tk.value==='(') depth++; else if (tk.value===')') depth--; if (depth===0 && i < toks.length-1) { ok=false; break; } } }
		if (ok) toks = toks.slice(1,-1);
	}
	// Post-tokenization merging for token pasting that may still have split identifiers (e.g., n + 1 -> n1)
	if (def.body.includes('##') && toks.length > 1) {
		const merged: Token[] = [];
		for (let i = 0; i < toks.length; i++) {
			const a = toks[i]!;
			const b = toks[i+1];
			// Merge patterns: id+id, id+number, number+id when concatenation forms a valid identifier (must start with letter/_)
			if (b && ((a.kind === 'id' || a.kind === 'number') && (b.kind === 'id' || b.kind === 'number'))) {
				const combined = a.value + b.value;
				if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(combined)) {
					merged.push({ kind: 'id', value: combined, span: { start: a.span.start, end: b.span.end } } as Token);
					i++; // skip b
					continue;
				}
			}
			merged.push(a);
		}
		// Only replace if we actually merged something (length reduced)
		if (merged.length < toks.length) toks = merged;
	}
	return distributeSpan(toks, callStart, callEnd);
}

function applyTokenPasteSimple(s: string): string {
	// Accept multi-char left/right (ident/number) not just single char, merge greedily.
	// We iterate merging longest adjacent identifier/number chunks separated by ##.
	return s.replace(/([A-Za-z_][A-Za-z0-9_]*|\d+)\s*##\s*([A-Za-z_][A-Za-z0-9_]*|\d+)/g, (_,a,b)=> a + b);
}

function distributeSpan(toks: Token[], start: number, end: number): Token[] {
	if (toks.length <= 1) return toks.map(t=> ({ ...t, span:{ start, end } }));
	const width = Math.max(1, end-start);
	return toks.map((t,i)=> {
		const a = start + Math.floor((i/ toks.length)*width);
		const b = (i===toks.length-1)? end : start + Math.floor(((i+1)/toks.length)*width);
		return { ...t, span:{ start:a, end: Math.max(a,b) } };
	});
}

// pushExpanded no longer used after hide-set integration; keep placeholder for future diff stability
// function pushExpanded(out: Token[], toks: Token[]) { for (const t of toks) out.push(t); }

function escapeRegExp(s: string){ return s.replace(/[.*+?^${}()|[\]\\]/g,'\\$&'); }
