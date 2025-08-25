import { TextDocument } from 'vscode-languageserver-textdocument';
import { DisabledRange } from './preproc';

export type TokKind = 'id' | 'num' | 'str' | 'kw' | 'type' | 'const' | 'punc' | 'op' | 'comment' | 'pp';

export interface Token {
	kind: TokKind;
	value: string;
	start: number;
	end: number; // exclusive
}

function inDisabled(offset: number, disabled: DisabledRange[]): boolean {
	// binary search would be better; this linear is fine for modest files
	return disabled.some(r => offset >= r.start && offset <= r.end);
}

const reId = /^[A-Za-z_][A-Za-z0-9_]*/;
// Numbers: hex (0x..), floats, or decimals; exponent applies only to decimal/float
const reNum = /^(?:0[xX][0-9A-Fa-f]+|(?:\d*\.\d+|\d+)(?:[eE][+-]?\d+)?)/;

export function lex(doc: TextDocument, disabled: DisabledRange[]): Token[] {
	const text = doc.getText();
	const out: Token[] = [];
	let i = 0;
	while (i < text.length) {
		if (inDisabled(i, disabled)) { i++; continue; }

		const ch = text[i];

		// whitespace
		if (/\s/.test(ch)) { i++; continue; }

		// comments
		if (ch === '/' && text[i + 1] === '/') {
			const start = i; while (i < text.length && text[i] !== '\n') i++;
			out.push({ kind: 'comment', value: text.slice(start, i), start, end: i });
			continue;
		}
		if (ch === '/' && text[i + 1] === '*') {
			const start = i; i += 2;
			while (i < text.length && !(text[i - 1] === '*' && text[i] === '/')) i++;
			i++;
			out.push({ kind: 'comment', value: text.slice(start, i), start, end: i });
			continue;
		}

		// preprocessor lines (for semantic tokens)
		if (ch === '#') {
			const start = i; while (i < text.length && text[i] !== '\n') i++;
			out.push({ kind: 'pp', value: text.slice(start, i), start, end: i });
			continue;
		}

		// strings
		if (ch === '"' || ch === '\'') {
			const quote = ch; const start = i++;
			while (i < text.length) {
				const c = text[i++];
				if (c === '\\') { i++; continue; }
				if (c === quote) break;
			}
			out.push({ kind: 'str', value: text.slice(start, i), start, end: i });
			continue;
		}

		// numbers
		const n = reNum.exec(text.slice(i));
		if (n) {
			const start = i; i += n[0].length;
			out.push({ kind: 'num', value: n[0], start, end: i });
			continue;
		}

		// identifiers
		const id = reId.exec(text.slice(i));
		if (id) {
			const start = i; const val = id[0]; i += val.length;
			out.push({ kind: 'id', value: val, start, end: i });
			continue;
		}

		// punctuation / operators
		const start = i++;
		out.push({ kind: /[;:,()[\]{}]/.test(ch) ? 'punc' : 'op', value: ch, start, end: i });
	}
	return out;
}
