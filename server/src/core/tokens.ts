// Core token model for the new lexing/macro pipeline

export type Span = { start: number; end: number };

export type TokenKind =
  | 'id'
  | 'number'
  | 'string'
  | 'keyword'
  | 'op'
  | 'punct'
  | 'comment-line'
  | 'comment-block'
  | 'directive' // entire preprocessor directive line (combined with continuations)
  | 'eof';

export interface Token {
  kind: TokenKind;
  value: string; // raw text slice (string tokens include quotes)
  span: Span;    // absolute offsets in original file
}

export const KEYWORDS = new Set<string>([
	'if', 'else', 'while', 'do', 'for', 'return', 'state', 'default', 'jump',
	// types (LSL)
	'integer', 'float', 'string', 'key', 'vector', 'rotation', 'quaternion', 'list',
	'void', 'event'
]);

export class TokenStream {
	// Source can be a static array of tokens or a producer function

	private readonly arr?: Token[];
	private readonly producer?: () => Token;
	private idx = 0;
	private pushback: Token[] = [];
	private stickyEof: Token | null = null;
	private lastEnd = 0;

	constructor(source: Token[] | { producer: () => Token }) {
		if (Array.isArray(source)) {
			this.arr = source;
			if (source.length > 0) this.lastEnd = source[source.length - 1]!.span.end;
		} else {
			this.producer = source.producer;
		}
	}

	next(): Token {
		if (this.stickyEof) {
			return this.stickyEof;
		}
		if (this.pushback.length > 0) {
			const t = this.pushback.pop()!;
			if (t.kind === 'eof') { this.stickyEof = t; return t; }
			this.lastEnd = t.span.end;
			return t;
		}
		let t: Token | null = null;
		if (this.arr) {
			if (this.idx < this.arr.length) {
				t = this.arr[this.idx++];
			} else {
				t = { kind: 'eof', value: '', span: { start: this.lastEnd, end: this.lastEnd } };
			}
		} else if (this.producer) {
			// Read one token from producer
			t = this.producer();
		} else {
			t = { kind: 'eof', value: '', span: { start: this.lastEnd, end: this.lastEnd } };
		}
		if (t.kind === 'eof') { this.stickyEof = t; return t; }
		this.lastEnd = t.span.end;
		return t;
	}

	peek(): Token {
		const t = this.next();
		if (t.kind !== 'eof') this.pushBack(t);
		return t;
	}

	pushBack(t: Token) {
		if (t.kind === 'eof') return; // ignore pushing back EOF
		this.pushback.push(t);
	}

}
