/*
	LSL lexer with basic macro expansion and comment tracking for AST parser
*/
import { TYPES } from './types';
import { TokenStream, type Token } from '../core/tokens';
import { builtinMacroForLexer } from '../builtins';

// Note: Token and Span are imported from core/tokens to keep a single token model.

const KEYWORDS = [
	'if', 'else', 'while', 'do', 'for', 'return', 'state', 'default', 'jump',
	...TYPES, 'quaternion',
	'void', 'event'
] as const;
type Keyword = typeof KEYWORDS[number];
export const KEYWORD_SET = new Set(KEYWORDS) as ReadonlySet<Keyword>;
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
	private readonly disabled?: { start: number; end: number }[];
	private readonly filename: string;
	private readonly ts: TokenStream;
	// Macro data removed; lexer now only tokenizes raw (already preprocessed) source.

	constructor(text: string, opts?: LexerOptions) {
		this.text = text;
		this.n = text.length;
		this.lineOffsets = computeLineOffsets(text);
		this.disabled = opts?.disabled ?? [];
		this.filename = opts?.filename ?? 'memory.lsl';
		// Drive tokens via TokenStream so EOF handling is centralized and pushback is unified
		this.ts = new TokenStream({ producer: (): Token => this.produceOne() });
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
				// Safety: never surface bare __VA_ARGS__ as an identifier.
				// If it leaked here (e.g., from an empty vararg site we didn't normalize),
				// drop it silently to avoid spurious Unknown identifier diagnostics.
				if (rawCore === '__VA_ARGS__') {
					// Continue scanning from current position without emitting a token.
					return this.scanOne();
				}
				// Macro expansion removed from lexer; preprocessing handled earlier.
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


	private skipStringFrom(pos: number): number {
		const quote = this.text[pos]!; let j = pos + 1;
		while (j < this.n) { const ch = this.text[j]!; if (ch === '\\') { j += 2; continue; } if (ch === quote) { j++; break; } j++; }
		return j;
	}

	private findLineEnd(pos: number): number {
		let i = pos; while (i < this.n && this.text[i] !== '\n') i++; return i;
	}

	private mk(kind: Token['kind'], value: string, start: number, end: number): Token {
		return { kind, value, span: { start, end }, file: '<unknown>' };
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
