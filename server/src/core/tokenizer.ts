import { isKeyword } from '../ast/lexer';
import { type Token, TokenStream } from './tokens';

// Standalone tokenizer: consumes whitespace and line continuations, emits
// comments and directives as tokens, but does NOT expand or evaluate macros.
export class Tokenizer {
	private i = 0;
	private readonly n: number;
	private readonly text: string;
	private readonly ts: TokenStream;

	constructor(text: string) {
		this.text = text;
		this.n = text.length;
		this.ts = new TokenStream({ producer: () => this.scanOne() });
	}

	next(): Token { return this.ts.next(); }
	peek(): Token { return this.ts.peek(); }
	pushBack(t: Token) { this.ts.pushBack(t); }

	private scanOne(): Token {
		if (this.i >= this.n) return this.mk('eof', '', this.i, this.i);
		// skip whitespace and splice line continuations
		while (this.i < this.n) {
			const ch = this.text[this.i]!;
			if (ch === '\\') {
				let k = this.i + 1; while (k < this.n && (this.text[k] === ' ' || this.text[k] === '\t')) k++;
				if (this.text[k] === '\n') { this.i = k + 1; continue; }
				if (this.text[k] === '\r' && this.text[k + 1] === '\n') { this.i = k + 2; continue; }
			}
			if (ch === ' ' || ch === '\t' || ch === '\r' || ch === '\n') { this.i++; continue; }
			break;
		}
		if (this.i >= this.n) return this.mk('eof', '', this.i, this.i);

		const c = this.text[this.i]!;
		// preprocessor directive at start of line (allow indentation). Build the token value
		// while removing continuation backslashes and inserting a single '\n' per splice.
		if (c === '#') {
			let j0 = this.i - 1; while (j0 >= 0 && (this.text[j0] === ' ' || this.text[j0] === '\t')) j0--;
			const atLineStart = (j0 < 0) || this.text[j0] === '\n';
			if (atLineStart) {
				let j = this.i;
				let segStart = this.i;
				let acc = '';
				j++; // skip '#'
				for (; j < this.n; ) {
					if (this.text[j] === '\\') {
						let k = j + 1; while (k < this.n && (this.text[k] === ' ' || this.text[k] === '\t')) k++;
						if (this.text[k] === '\n') {
							// append up to backslash (exclude it), then insert a newline marker
							acc += this.text.slice(segStart, j);
							acc += '\n';
							j = k + 1; segStart = j; continue;
						}
						if (this.text[k] === '\r' && this.text[k + 1] === '\n') {
							acc += this.text.slice(segStart, j);
							acc += '\n';
							j = k + 2; segStart = j; continue;
						}
					}
					if (this.text[j] === '\n') break;
					j++;
				}
				acc += this.text.slice(segStart, j);
				const t = this.mk('directive', acc, this.i, j);
				this.i = j; return t;
			}
		}

		// comments
		if (c === '/') {
			const d = this.text[this.i + 1];
			if (d === '/') {
				const s = this.i; this.i += 2; const e = this.findLineEnd(this.i);
				const t = this.mk('comment-line', this.text.slice(s, e), s, e); this.i = e; return t;
			}
			if (d === '*') {
				const s = this.i; this.i += 2; let j = this.i;
				while (j < this.n && !(this.text[j] === '*' && this.text[j + 1] === '/')) j++;
				if (j < this.n) j += 2;
				const t = this.mk('comment-block', this.text.slice(s, j), s, j); this.i = j; return t;
			}
		}

		// strings
		if (c === '"' || c === '\'') {
			const q = c; const s = this.i; this.i++;
			let j = this.i; while (j < this.n) { const ch = this.text[j]!; if (ch === '\\') { j += 2; continue; } if (ch === q) { j++; break; } j++; }
			const t = this.mk('string', this.text.slice(s, j), s, j); this.i = j; return t;
		}

		// numbers (hex, decimal, float, exponents)
		if (c === '0' && (this.text[this.i + 1] === 'x' || this.text[this.i + 1] === 'X')) {
			const s = this.i; let j = this.i + 2;
			while (j < this.n && /[0-9A-Fa-f]/.test(this.text[j]!)) j++;
			if (this.text[j] === '.') { j++; while (j < this.n && /[0-9A-Fa-f]/.test(this.text[j]!)) j++; }
			if (this.text[j] === 'p' || this.text[j] === 'P') { j++; if (this.text[j] === '+' || this.text[j] === '-') j++; while (j < this.n && /[0-9]/.test(this.text[j]!)) j++; }
			const t = this.mk('number', this.text.slice(s, j), s, j); this.i = j; return t;
		}
		if (/[0-9]/.test(c) || (c === '.' && /[0-9]/.test(this.text[this.i + 1] || ''))) {
			const s = this.i; let j = this.i; let sawDot = false;
			while (j < this.n) { const ch = this.text[j]!; if (/[0-9]/.test(ch)) { j++; continue; } if (ch === '.' && !sawDot) { sawDot = true; j++; continue; } break; }
			if (j < this.n && /[eEpP]/.test(this.text[j]!)) { j++; if (this.text[j] === '+' || this.text[j] === '-') j++; while (j < this.n && /[0-9]/.test(this.text[j]!)) j++; }
			const t = this.mk('number', this.text.slice(s, j), s, j); this.i = j; return t;
		}

		// identifiers/keywords (allow a small set of leading/trailing noise chars to match LSL leniency)
		const isNoise = (ch: string | undefined) => ch === '#' || ch === '$' || ch === '?' || ch === '\\' || ch === '"' || ch === '\'';
		const isIdStart = (ch: string | undefined) => !!ch && /[A-Za-z_]/.test(ch);
		const isIdContinue = (ch: string | undefined) => !!ch && /[A-Za-z0-9_]/.test(ch);
		if (isIdStart(c) || isNoise(c)) {
			const s = this.i; let j = this.i; while (j < this.n && isNoise(this.text[j]!)) j++;
			if (j < this.n && isIdStart(this.text[j]!)) {
				let k = j + 1; while (k < this.n && isIdContinue(this.text[k]!)) k++;
				let tEnd = k; while (tEnd < this.n && isNoise(this.text[tEnd]!)) tEnd++;
				const word = this.text.slice(j, k);
				this.i = tEnd;
				return this.mk(isKeyword(word) ? 'keyword' : 'id', word, s, tEnd);
			}
		}

		// operators and punctuation
		const two = this.text.slice(this.i, this.i + 2);
		const TWO = new Set(['==', '!=', '<=', '>=', '&&', '||', '<<', '>>', '+=', '-=', '*=', '/=', '%=', '++', '--']);
		if (TWO.has(two)) { const t = this.mk('op', two, this.i, this.i + 2); this.i += 2; return t; }
		const single = this.text[this.i]!;
		if (single === '\\') { this.i++; return this.scanOne(); }
		const SINGLE = new Set(['+', '-', '*', '/', '%', '!', '~', '<', '>', '=', '&', '|', '^', '.']);
		const PUNCT = new Set([';', ',', '(', ')', '{', '}', '[', ']', ':']);
		if (SINGLE.has(single)) { const t = this.mk('op', single, this.i, this.i + 1); this.i++; return t; }
		if (PUNCT.has(single)) { const t = this.mk('punct', single, this.i, this.i + 1); this.i++; return t; }

		// unknown char -> emit as punct to keep stream progressing
		const t = this.mk('punct', single, this.i, this.i + 1); this.i++; return t;
	}

	private findLineEnd(pos: number): number { let i = pos; while (i < this.n && this.text[i] !== '\n') i++; return i; }
	private mk(kind: Token['kind'], value: string, start: number, end: number): Token { return { kind, value, span: { start, end }, file: '<unknown>' }; }
}

export function tokenize(text: string): Token[] {
	const tz = new Tokenizer(text);
	const out: Token[] = [];
	for (; ;) { const t = tz.next(); out.push(t); if (t.kind === 'eof') break; }
	return out;
}
