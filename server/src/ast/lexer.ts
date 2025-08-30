/*
	LSL lexer with basic macro expansion and comment tracking for AST parser
*/
import type { Span, Type } from './index';

export type TokKind =
	| 'id' | 'number' | 'string' | 'op' | 'punct' | 'keyword'
	| 'comment-line' | 'comment-block' | 'directive' | 'eof';

export interface Token { kind: TokKind; value: string; span: Span; }

const KEYWORDS = new Set([
	'if', 'else', 'while', 'do', 'for', 'return', 'state', 'default', 'jump', 'label',
	// types (used for casts/decls)
	'integer', 'float', 'string', 'key', 'vector', 'rotation', 'list', 'void'
]);

const TYPE_SET = new Set<Type>(['integer', 'float', 'string', 'key', 'vector', 'rotation', 'list']);

export type MacroTables = {
	obj: Record<string, string | number | boolean>;
	fn: Record<string, string>; // "(params) body"
};

export class Lexer {
	private i = 0;
	private readonly n: number;
	private readonly text: string;
	private readonly lineOffsets: number[];
	private readonly macros?: MacroTables;
	private readonly disabled?: { start: number; end: number }[];
	private readonly filename: string;
	private pending: Token[] = [];
	private expansionDepth = 0;

	constructor(text: string, opts?: { macros?: MacroTables; disabled?: { start: number; end: number }[]; filename?: string }) {
		this.text = text;
		this.n = text.length;
		this.lineOffsets = computeLineOffsets(text);
		this.macros = opts?.macros;
		this.disabled = opts?.disabled ?? [];
		this.filename = opts?.filename ?? 'memory.lsl';
	}

	public next(): Token {
		if (this.pending.length > 0) return this.pending.pop()!;
		let t = this.scanOne();
		// skip tokens that are in disabled ranges (preprocessor inactive sections)
		while (this.isDisabled(t.span.start) && t.kind !== 'eof') t = this.scanOne();
		return t;
	}

	public peek(): Token {
		const t = this.next();
		this.pushBack(t);
		return t;
	}

	public pushBack(t: Token) { this.pending.push(t); }

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
		// skip whitespace (including newlines)
		while (this.i < this.n) {
			const ch = this.text[this.i]!;
			if (ch === ' ' || ch === '\t' || ch === '\r' || ch === '\n') { this.i++; continue; }
			break;
		}
		if (this.i >= this.n) return this.mk('eof', '', this.i, this.i);

		const c = this.text[this.i]!;
		// preprocessor directive only if at column 0 (or after newline) and '#'
		if (c === '#') {
			const prev = this.i > 0 ? this.text[this.i - 1] : '\n';
			if (prev === '\n') {
				const start = this.i;
				let j = this.i + 1;
				while (j < this.n && this.text[j] !== '\n') j++;
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
		// hex integer: 0x... or 0X...
		if (c === '0' && (this.text[this.i + 1] === 'x' || this.text[this.i + 1] === 'X')) {
			const start = this.i; let j = this.i + 2;
			while (j < this.n) {
				const ch = this.text[j]!;
				if ((ch >= '0' && ch <= '9') || (ch >= 'a' && ch <= 'f') || (ch >= 'A' && ch <= 'F')) { j++; continue; }
				break;
			}
			const raw = this.text.slice(start, j);
			this.i = j;
			return this.mk('number', raw, start, j);
		}
		// decimal integer/float (with optional leading digits and single dot, and optional exponent for decimals)
		if (/[0-9]/.test(c) || (c === '.' && /[0-9]/.test(this.text[this.i + 1] || ''))) {
			const start = this.i; let j = this.i;
			let sawDot = false;
			while (j < this.n) {
				const ch = this.text[j]!;
				if (/[0-9]/.test(ch)) { j++; continue; }
				if (ch === '.' && !sawDot) { sawDot = true; j++; continue; }
				break;
			}
			const raw = this.text.slice(start, j);
			this.i = j;
			return this.mk('number', raw, start, j);
		}

		// identifiers / keywords
		if (/[A-Za-z_]/.test(c)) {
			const start = this.i; let j = this.i + 1;
			while (j < this.n && /[A-Za-z0-9_]/.test(this.text[j]!)) j++;
			const word = this.text.slice(start, j);
			this.i = j;
			// built-in macros
			if (word === '__LINE__') {
				const line = this.lineNumberFor(start);
				return this.mk('number', String(line), start, j);
			}
			if (word === '__FILE__') {
				const quoted = JSON.stringify(this.filename);
				return this.mk('string', quoted, start, j);
			}
			if (word === '__TIME__') {
				const time = new Date().toLocaleTimeString('en-US', { hour12: false });
				return this.mk('string', JSON.stringify(time), start, j);
			}
			if (word === '__DATE__') {
				const date = new Date().toLocaleDateString('en-US', { timeZone: 'UTC' });
				return this.mk('string', JSON.stringify(date), start, j);
			}
			// TODO: __VERSION__, __FILE_NAME__, __COUNTER__ ???
			// macro expansion
			const expanded = this.tryExpandMacro(word);
			if (expanded) return expanded;
			const kind: TokKind = KEYWORDS.has(word) ? 'keyword' : 'id';
			return this.mk(kind, word, start, j);
		}

		// two-char ops
		const two = this.text.slice(this.i, this.i + 2);
		const twoOps = ['==', '!=', '<=', '>=', '&&', '||', '<<', '>>', '+=', '-=', '*=', '/=', '%=', '++', '--'];
		if (twoOps.includes(two)) { const t = this.mk('op', two, this.i, this.i + 2); this.i += 2; return t; }

		// single-char ops & punct
		const single = this.text[this.i]!;
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
			let k = this.i; while (k < this.n && /\s/.test(this.text[k]!)) k++;
			if (this.text[k] !== '(') return null; // not a call -> treat as id
			// parse args region to keep raw text
			k++; let depth = 1;
			const parts: string[] = [];
			let segStart = k;
			while (k < this.n && depth > 0) {
				const ch = this.text[k]!;
				if (ch === '"' || ch === '\'') { k = this.skipStringFrom(k); continue; }
				if (ch === '(') { depth++; k++; continue; }
				if (ch === ')') { depth--; if (depth === 0) break; k++; continue; }
				if (ch === ',' && depth === 1) { parts.push(this.text.slice(segStart, k)); k++; while (k < this.n && /\s/.test(this.text[k]!)) k++; segStart = k; continue; }
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
		// Lex the body into tokens and push onto pending stack in reverse (so next pop yields first)
		const lx = new Lexer(body, { macros: this.macros });
		const buf: Token[] = [];
		for (; ;) { const t = lx.scanOne(); if (t.kind === 'eof') break; if (t.kind === 'comment-line' || t.kind === 'comment-block') continue; buf.push(t); }
		this.expansionDepth--;
		for (let i = buf.length - 1; i >= 0; i--) this.pending.push(buf[i]!);
		// return a phantom token that will be immediately replaced by pending content
		return this.next();
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

export function isTypeWord(w: string): w is Type { return TYPE_SET.has(w as Type); }

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
