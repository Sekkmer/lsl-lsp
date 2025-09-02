import { type Token } from './tokens';

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

	constructor(tokens: Token[], opts?: { resolveInclude?: IncludeResolver; fromId?: string; includeStack?: string[] }) {
		this.tokens = tokens;
		this.resolveInclude = opts?.resolveInclude;
		this.fromId = opts?.fromId;
		// Initialize include stack with provided stack or fromId
		const initial: string[] = [];
		if (opts?.includeStack && opts.includeStack.length > 0) initial.push(...opts.includeStack);
		else if (this.fromId) initial.push(this.fromId);
		this.includeStack = initial;
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
				const nested = new MacroConditionalProcessor(inc.tokens, { resolveInclude: this.resolveInclude, fromId: inc.id, includeStack: nestedStack });
				if (macrosOnly) {
					const r = nested.processToMacros(macros);
					// use returned macros as updated reference (object already mutated via copy)
					Object.assign(macros, r.macros);
				} else {
					const r = nested.processToTokens(macros);
					// Update macros table and we need to emit included tokens into sink
					for (const it of r.tokens) sink(it, true);
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
