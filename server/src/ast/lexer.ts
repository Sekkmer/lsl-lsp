/*
	LSL lexer with basic macro expansion and comment tracking for AST parser
*/
import { type Span, TYPES } from './index';
import { TokenStream } from '../core/tokens';
import { builtinMacroForLexer } from '../builtins';

export type TokKind =
	| 'id' | 'number' | 'string' | 'op' | 'punct' | 'keyword'
	| 'comment-line' | 'comment-block' | 'directive' | 'eof';

export interface Token { kind: TokKind; value: string; span: Span; }

const KEYWORDS = [
	'if', 'else', 'while', 'do', 'for', 'return', 'state', 'default', 'jump',
	...TYPES, 'quaternion',
	'void', 'event'
] as const;
type Keyword = typeof KEYWORDS[number];
const KEYWORD_SET = new Set(KEYWORDS) as ReadonlySet<Keyword>;
export function isKeyword(value: string): value is Keyword {
	return KEYWORD_SET.has(value as Keyword);
}

export type MacroTables = {
	obj: Record<string, string | number | boolean>;
	fn: Record<string, string>; // "(params) body"
};

type LexerOptions = {
	macros?: MacroTables;
	disabled?: { start: number; end: number }[];
	filename?: string;
};

export class Lexer {
	private i = 0;
	private readonly n: number;
	private readonly text: string;
	private readonly lineOffsets: number[];
	private readonly macros?: MacroTables;
	private readonly disabled?: { start: number; end: number }[];
	private readonly filename: string;
	private readonly ts: TokenStream;
	private expansionDepth = 0;

	constructor(text: string, opts?: LexerOptions) {
		this.text = text;
		this.n = text.length;
		this.lineOffsets = computeLineOffsets(text);
		this.macros = opts?.macros;
		this.disabled = opts?.disabled ?? [];
		this.filename = opts?.filename ?? 'memory.lsl';
		// Drive tokens via TokenStream so EOF handling is centralized and pushback is unified
		this.ts = new TokenStream({ producer: () => this.produceOne() as any });
	}

	public next(): Token {
		return this.ts.next();
	}

	public peek(): Token {
		return this.ts.peek();
	}

	public pushBack(t: Token) {
		this.ts.pushBack(t);
	}

	// Producer for TokenStream: emits next non-disabled token from source
	private produceOne(): Token {
		let t = this.scanOne();
		while (this.isDisabled(t.span.start) && t.kind !== 'eof') t = this.scanOne();
		return t;
	}

	private isDisabled(pos: number): boolean {
		if (!this.disabled || this.disabled.length === 0) return false;
		// binary search
		let lo = 0, hi = this.disabled.length - 1;
		while (lo <= hi) {
			const mid = (lo + hi) >> 1;
			const r = this.disabled[mid]!;
			if (pos < r.start) hi = mid - 1;
			else if (pos > r.end) lo = mid + 1;
			else return true;
		}
		return false;
	}

	// core scanner that returns comments and trivia as tokens (no whitespace tokens)
	private scanOne(): Token {
		if (this.i >= this.n) return this.mk('eof', '', this.i, this.i);
		// skip whitespace (including newlines) and track if we crossed a newline
		// also collapse C-style line continuations: backslash followed by newline
		// track whitespace/newlines while skipping; we don't need an explicit flag anymore for directives
		while (this.i < this.n) {
			const ch = this.text[this.i]!;
			if (ch === '\\') {
				// Handle line splicing with optional spaces/tabs before newline
				let k = this.i + 1;
				while (k < this.n && (this.text[k] === ' ' || this.text[k] === '\t')) k++;
				if (this.text[k] === '\n') { this.i = k + 1; continue; }
				if (this.text[k] === '\r' && this.text[k + 1] === '\n') { this.i = k + 2; continue; }
			}
			if (ch === ' ' || ch === '\t' || ch === '\r' || ch === '\n') { this.i++; continue; }
			break;
		}
		if (this.i >= this.n) return this.mk('eof', '', this.i, this.i);

		const c = this.text[this.i]!;
		// preprocessor directive: allow optional indentation at the start of a line before '#'
		// Detect true line-start by looking backwards for only spaces/tabs up to previous newline or BOF
		if (c === '#') {
			let j0 = this.i - 1;
			while (j0 >= 0 && (this.text[j0] === ' ' || this.text[j0] === '\t')) j0--;
			const atLineStart = (j0 < 0) || this.text[j0] === '\n';
			if (atLineStart) {
				const start = this.i;
				let j = this.i + 1;
				// Consume until end of directive, respecting backslash-newline continuations
				for (; j < this.n;) {
					if (this.text[j] === '\\') {
						let k = j + 1;
						while (k < this.n && (this.text[k] === ' ' || this.text[k] === '\t')) k++;
						if (this.text[k] === '\n') { j = k + 1; continue; }
						if (this.text[k] === '\r' && this.text[k + 1] === '\n') { j = k + 2; continue; }
					}
					if (this.text[j] === '\n') break;
					j++;
				}
				const tok = this.mk('directive', this.text.slice(start, j), start, j);
				this.i = j;
				return tok;
			}
		}

		// comments
		if (c === '/') {
			const c2 = this.text[this.i + 1];
			if (c2 === '/') {
				const start = this.i; this.i += 2;
				const lineEnd = this.findLineEnd(this.i);
				const value = this.text.slice(this.i, lineEnd);
				const tok = this.mk('comment-line', value, start, lineEnd);
				this.i = lineEnd; // position at end-of-line (newline kept for next scan)
				return tok;
			}
			if (c2 === '*') {
				const start = this.i; this.i += 2;
				let j = this.i;
				while (j < this.n && !(this.text[j] === '*' && this.text[j + 1] === '/')) j++;
				const endBody = j;
				if (j < this.n) j += 2; // consume */
				const tok = this.mk('comment-block', this.text.slice(this.i, endBody), start, j);
				this.i = j;
				return tok;
			}
		}

		// strings
		if (c === '"' || c === '\'') {
			const quote = c; const start = this.i; this.i++;
			let j = this.i;
			while (j < this.n) {
				const ch = this.text[j]!;
				if (ch === '\\') { j += 2; continue; }
				if (ch === quote) { break; }
				j++;
			}
			const end = (j < this.n) ? j + 1 : j;
			const tok = this.mk('string', this.text.slice(start, end), start, end);
			this.i = end;
			return tok;
		}

		// numbers (int/float)
		// hex number: 0x... with optional fractional part and optional binary exponent (p/P[+/-]digits)
		if (c === '0' && (this.text[this.i + 1] === 'x' || this.text[this.i + 1] === 'X')) {
			const start = this.i; let j = this.i + 2;
			// integer part (hex digits)
			while (j < this.n) {
				const ch = this.text[j]!;
				if ((ch >= '0' && ch <= '9') || (ch >= 'a' && ch <= 'f') || (ch >= 'A' && ch <= 'F')) { j++; continue; }
				break;
			}
			// optional fractional part .<hex digits>*
			if (this.text[j] === '.') { j++; while (j < this.n) { const ch = this.text[j]!; if ((ch >= '0' && ch <= '9') || (ch >= 'a' && ch <= 'f') || (ch >= 'A' && ch <= 'F')) { j++; continue; } break; } }
			// optional p/P exponent
			if ((this.text[j] === 'p' || this.text[j] === 'P')) {
				j++;
				if (this.text[j] === '+' || this.text[j] === '-') j++;
				while (j < this.n && /[0-9]/.test(this.text[j]!)) { j++; }
				// even if no digits, we will still treat the prior as number to avoid token split; parser may flag if needed
			}
			const end = j;
			const raw = this.text.slice(start, end);
			this.i = end;
			return this.mk('number', raw, start, end);
		}
		// decimal integer/float with optional exponent: e/E or p/P (we accept p for decimal to align with viewer tolerance)
		if (/[0-9]/.test(c) || (c === '.' && /[0-9]/.test(this.text[this.i + 1] || ''))) {
			const start = this.i; let j = this.i;
			let sawDot = false;
			while (j < this.n) {
				const ch = this.text[j]!;
				if (/[0-9]/.test(ch)) { j++; continue; }
				if (ch === '.' && !sawDot) { sawDot = true; j++; continue; }
				break;
			}
			// optional exponent
			if (j < this.n && (this.text[j] === 'e' || this.text[j] === 'E' || this.text[j] === 'p' || this.text[j] === 'P')) {
				j++;
				if (this.text[j] === '+' || this.text[j] === '-') j++;
				while (j < this.n && /[0-9]/.test(this.text[j]!)) { j++; }
				// tolerate missing digits to avoid splitting tokens; downstream may handle
			}
			const raw = this.text.slice(start, j);
			this.i = j;
			return this.mk('number', raw, start, j);
		}

		// identifiers / keywords (relaxed): allow certain leading/trailing noise characters
		// LSL ignores these at the beginning or end of names: #, $, ?, \\, and quotes
		const isNoise = (ch: string | undefined) => ch === '#' || ch === '$' || ch === '?' || ch === '\\' || ch === '"' || ch === '\'';
		const isIdStart = (ch: string | undefined) => !!ch && /[A-Za-z_]/.test(ch);
		const isIdContinue = (ch: string | undefined) => !!ch && /[A-Za-z0-9_]/.test(ch);
		if (isIdStart(c) || isNoise(c)) {
			const start = this.i;
			let j = this.i;
			// skip leading noise characters
			while (j < this.n && isNoise(this.text[j]!)) j++;
			if (j < this.n && isIdStart(this.text[j]!)) {
				let k = j + 1;
				while (k < this.n && isIdContinue(this.text[k]!)) k++;
				// Skip trailing noise characters, but don't include any alnum/_ following as part of name
				let t = k;
				while (t < this.n && isNoise(this.text[t]!)) t++;
				const rawCore = this.text.slice(j, k);
				this.i = t;
				// built-in macros via centralized helper work on normalized word
				const bi = builtinMacroForLexer(rawCore, { filename: this.filename, line: this.lineNumberFor(start) });
				if (bi) return this.mk(bi.kind, bi.value, start, t);
				// Do NOT expand user macros over language keywords (e.g., if/else/for...).
				// Classify keywords first and return them as-is to avoid runaway expansions
				// when projects accidentally define macros with reserved names.
				if (isKeyword(rawCore)) {
					return this.mk('keyword', rawCore, start, t);
				}
				// macro expansion for non-keywords only
				const expanded = this.tryExpandMacro(rawCore);
				if (expanded) return expanded;
				return this.mk('id', rawCore, start, t);
			}
			// Not followed by a valid identifier start -> treat the single char as operator/punct as usual
		}

		// two-char ops
		const two = this.text.slice(this.i, this.i + 2);
		const twoOps = ['==', '!=', '<=', '>=', '&&', '||', '<<', '>>', '+=', '-=', '*=', '/=', '%=', '++', '--'];
		if (twoOps.includes(two)) { const t = this.mk('op', two, this.i, this.i + 2); this.i += 2; return t; }

		// single-char ops & punct
		const single = this.text[this.i]!;
		// Ignore stray backslashes outside of strings/comments (not an operator in LSL)
		if (single === '\\') { this.i++; return this.scanOne(); }
		const SINGLE_OPS = new Set(['+', '-', '*', '/', '%', '!', '~', '<', '>', '=', '&', '|', '^', '.']);
		const PUNCT = new Set([';', ',', '(', ')', '{', '}', '[', ']', ':']);
		if (SINGLE_OPS.has(single)) { const t = this.mk('op', single, this.i, this.i + 1); this.i++; return t; }
		if (PUNCT.has(single)) { const t = this.mk('punct', single, this.i, this.i + 1); this.i++; return t; }

		// unknown char -> skip
		const s = this.mk('punct', single, this.i, this.i + 1); this.i++; return s;
	}

	// Attempt macro expansion at current scan position when an identifier was read
	private tryExpandMacro(word: string): Token | null {
		if (!this.macros) return null;
		const obj = this.macros.obj[word];
		const fn = this.macros.fn[word];
		const start = this.i - word.length;
		if (obj !== undefined) {
			// expand object-like: get textual form
			let body: string;
			if (typeof obj === 'number' || typeof obj === 'boolean') body = String(obj);
			else body = String(obj);
			return this.expandTextAsPending(body, start, start + word.length);
		}
		if (fn !== undefined) {
			// fn string like "(a,b) body"
			// We need to parse an argument list next in the original text
			// const save = this.i;
			// skip whitespace
			let k = this.i;
			while (k < this.n && /\s/.test(this.text[k]!)) k++;
			if (this.text[k] !== '(') return null; // not a call -> treat as id
			// parse args region to keep raw text
			k++; let depth = 1;
			const parts: string[] = [];
			let segStart = k;
			while (k < this.n && depth > 0) {
				const ch = this.text[k]!;
				// Skip strings entirely
				if (ch === '"' || ch === '\'') { k = this.skipStringFrom(k); continue; }
				// Skip line comments //...
				if (ch === '/' && this.text[k + 1] === '/') { k = this.findLineEnd(k + 2); continue; }
				// Skip block comments /* ... */
				if (ch === '/' && this.text[k + 1] === '*') {
					k += 2;
					while (k < this.n && !(this.text[k] === '*' && this.text[k + 1] === '/')) k++;
					if (k < this.n) k += 2; // consume closing */
					continue;
				}
				if (ch === '(') { depth++; k++; continue; }
				if (ch === ')') { depth--; if (depth === 0) break; k++; continue; }
				if (ch === ',' && depth === 1) {
					parts.push(this.text.slice(segStart, k));
					k++;
					// Skip whitespace and any immediate comments between args
					for (; ;) {
						while (k < this.n && /\s/.test(this.text[k]!)) k++;
						if (k < this.n && this.text[k] === '/' && this.text[k + 1] === '/') { k = this.findLineEnd(k + 2); continue; }
						if (k + 1 < this.n && this.text[k] === '/' && this.text[k + 1] === '*') {
							k += 2;
							while (k < this.n && !(this.text[k] === '*' && this.text[k + 1] === '/')) k++;
							if (k < this.n) k += 2;
							continue;
						}
						break;
					}
					segStart = k;
					continue;
				}
				k++;
			}
			if (depth === 0) { parts.push(this.text.slice(segStart, k)); }
			const callEnd = (depth === 0) ? k + 1 : k;
			this.i = callEnd; // consume call

			const m = /^\(([^)]*)\)\s*([\s\S]*)$/.exec(fn);
			const rawParams = (m?.[1] ?? '').trim();
			const bodyRaw = (m?.[2] ?? '').trim();
			const params = rawParams.length ? rawParams.split(',').map(s => s.trim()).filter(Boolean) : [];
			const hasVarArg = params[params.length - 1] === '...';
			const fixedCount = hasVarArg ? params.length - 1 : params.length;
			const argMap = new Map<string, string>();
			for (let idx = 0; idx < fixedCount; idx++) argMap.set(params[idx]!, (parts[idx] ?? '').trim());
			const varArgsProvided = hasVarArg ? (parts.length > fixedCount) : false;
			const varArgsList = hasVarArg ? parts.slice(fixedCount).map(s => s.trim()).filter(s => s.length > 0) : [];
			const varArgsJoined = varArgsList.join(', ');
			// Step 1: Expand __VA_OPT__ depending on varargs presence
			const bodyAfterVaOpt = expandVaOpt(bodyRaw, varArgsProvided);
			// Step 2: Handle stringification (#param) using ORIGINAL raw arg text
			let expanded = applyStringify(bodyAfterVaOpt, params.slice(0, fixedCount), parts.slice(0, fixedCount));
			// Step 3: Substitute fixed params by name (before token pasting)
			for (const [name, arg] of argMap) {
				const re = new RegExp(`\\b${escapeRegExp(name)}\\b`, 'g');
				expanded = expanded.replace(re, arg);
			}
			// Step 4: Substitute __VA_ARGS__ with joined list
			expanded = expanded.replace(/\b__VA_ARGS__\b/g, varArgsJoined);
			// Step 5: Apply token pasting last so CAT(a,b) -> a##b becomes n##1 -> n1
			expanded = applyTokenPaste(expanded);
			return this.expandTextAsPending(expanded, start, callEnd);
		}
		return null;
	}


	private expandTextAsPending(body: string, start: number, end: number): Token {
		if (this.expansionDepth > 20) return this.mk('id', '/*macro-depth*/', start, end);
		this.expansionDepth++;
		// Lex the body into tokens and push onto stream pushback in reverse (so next pop yields first)
		const lx = new Lexer(body, { macros: this.macros });
		const buf: Token[] = [];
		for (; ;) {
			const t = lx.scanOne();
			if (t.kind === 'eof') break;
			if (t.kind === 'comment-line' || t.kind === 'comment-block') continue;
			// Remap token spans to the call site span in the original text
			buf.push({ ...t, span: { start, end } });
		}
		this.expansionDepth--;
		// If the call site is disabled, drop the entire expansion.
		// IMPORTANT: Do not call this.ts.next() from within the producer here,
		// as that would recurse into the same TokenStream and can cause runaway loops.
		// Instead, emit a harmless placeholder token at the same span; produceOne()
		// will immediately filter it out via the disabled-range check and continue.
		if (this.isDisabled(start)) {
			return this.mk('comment-line', '/*disabled-macro*/', start, end);
		}
		for (let i = buf.length - 1; i >= 0; i--) this.ts.pushBack(buf[i]!);
		// return first expanded token
		return this.ts.next();
	}

	private skipStringFrom(pos: number): number {
		const quote = this.text[pos]!; let j = pos + 1;
		while (j < this.n) { const ch = this.text[j]!; if (ch === '\\') { j += 2; continue; } if (ch === quote) { j++; break; } j++; }
		return j;
	}

	private findLineEnd(pos: number): number {
		let i = pos; while (i < this.n && this.text[i] !== '\n') i++; return i;
	}

	private mk(kind: TokKind, value: string, start: number, end: number): Token {
		return { kind, value, span: { start, end } };
	}

	private lineNumberFor(pos: number): number {
		// Binary search in lineOffsets to find greatest offset <= pos
		let lo = 0, hi = this.lineOffsets.length - 1, ans = 0;
		while (lo <= hi) {
			const mid = (lo + hi) >> 1;
			const off = this.lineOffsets[mid]!;
			if (off <= pos) { ans = mid; lo = mid + 1; }
			else { hi = mid - 1; }
		}
		return ans + 1; // 1-based line numbers
	}
}

export function computeLineOffsets(text: string): number[] {
	const out = [0];
	for (let i = 0; i < text.length; i++) { if (text[i] === '\n') out.push(i + 1); }
	return out;
}

function escapeRegExp(s: string): string { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

// Expand occurrences of __VA_OPT__(content): include content only when varargs are provided
function expandVaOpt(body: string, hasVarArgs: boolean): string {
	let out = '';
	let i = 0;
	while (i < body.length) {
		const idx = body.indexOf('__VA_OPT__', i);
		if (idx < 0) { out += body.slice(i); break; }
		out += body.slice(i, idx);
		let j = idx + '__VA_OPT__'.length;
		while (j < body.length && /\s/.test(body[j]!)) j++;
		if (j >= body.length || body[j] !== '(') {
			// keep literal text if not followed by '('
			out += '__VA_OPT__';
			i = j;
			continue;
		}
		// find matching ')'
		let k = j + 1; let depth = 1;
		while (k < body.length && depth > 0) {
			const ch = body[k]!;
			if (ch === '"' || ch === '\'') {
				// skip string literal
				const q = ch; k++;
				while (k < body.length) { const c = body[k]!; if (c === '\\') { k += 2; continue; } if (c === q) { k++; break; } k++; }
				continue;
			}
			if (ch === '(') depth++;
			else if (ch === ')') depth--;
			k++;
		}
		const content = body.slice(j + 1, Math.max(j + 1, k - 1));
		if (hasVarArgs) out += content;
		i = k;
	}
	return out;
}

// Replace #param with a quoted form of the original argument text (stringification)
// We stringify only fixed parameters by name; __VA_ARGS__ stringification is not standard and ignored here.
function applyStringify(body: string, fixedParamNames: string[], fixedArgParts: string[]): string {
	// Build a lookup for quick match
	const map = new Map<string, string>();
	for (let i = 0; i < fixedParamNames.length; i++) {
		const name = fixedParamNames[i]!;
		const raw = (fixedArgParts[i] ?? '').trim();
		// Stringify raw exactly as written, escaping quotes in JSON
		const quoted = JSON.stringify(raw);
		map.set(name, quoted);
	}
	// Replace occurrences of #<name> where <name> is a param
	// Respect word boundary after name; allow optional spaces after '#'
	let out = '';
	let i = 0;
	while (i < body.length) {
		const idx = body.indexOf('#', i);
		if (idx < 0) { out += body.slice(i); break; }
		out += body.slice(i, idx);
		// If this is part of a token-paste '##', keep as-is and skip both
		if (body[idx + 1] === '#') { out += '##'; i = idx + 2; continue; }
		let j = idx + 1;
		while (j < body.length && /\s/.test(body[j]!)) j++;
		// read identifier
		let k = j;
		while (k < body.length && /[A-Za-z0-9_]/.test(body[k]!)) k++;
		const name = body.slice(j, k);
		if (name && map.has(name)) {
			out += map.get(name)!;
			i = k; continue;
		}
		// otherwise keep literal '#'
		out += '#';
		i = j;
	}
	return out;
}

// Apply token pasting for occurrences of X ## Y by removing the operator and surrounding whitespace.
// We don’t attempt C preprocessor re-tokenization; we simply concatenate the surrounding text tokens.
function applyTokenPaste(body: string): string {
	// Consume occurrences outside of string literals to avoid corrupting strings
	let out = '';
	let i = 0;
	while (i < body.length) {
		// handle string literals
		const ch = body[i]!;
		if (ch === '"' || ch === '\'') {
			const s = i; const q = ch; i++;
			while (i < body.length) { const c = body[i]!; if (c === '\\') { i += 2; continue; } if (c === q) { i++; break; } i++; }
			out += body.slice(s, i);
			continue;
		}
		if (body[i] === '#' && body[i + 1] === '#') {
			// trim trailing spaces from out and skip leading spaces after ##
			out = out.replace(/[ \t]+$/g, '');
			i += 2;
			while (i < body.length && /\s/.test(body[i]!)) i++;
			// no separator added; just continue appending following text
			continue;
		}
		out += body[i]!; i++;
	}
	return out;
}
