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
	const original = doc.getText();
	// Phase 1: splice line continuations (backslash + CR? + LF) while mapping indices
	let sText = '';
	const mapToOrig: number[] = [];
	for (let k = 0; k < original.length; ) {
		const ch = original[k];
		if (ch === '\\') {
			// Handle line splicing with optional trailing spaces/tabs before newline
			// Patterns: \\\n , \\ \t* \n , or \\ \t* \r\n
			let j = k + 1;
			while (j < original.length && (original[j] === ' ' || original[j] === '\t')) j++;
			if (original[j] === '\n') { k = j + 1; continue; }
			if (original[j] === '\r' && original[j + 1] === '\n') { k = j + 2; continue; }
		}
		sText += ch;
		mapToOrig.push(k);
		k++;
	}

	const out: Token[] = [];
	let i = 0; // index into sText
	const N = sText.length;

	function origAt(idx: number): number { return mapToOrig[Math.max(0, Math.min(idx, mapToOrig.length - 1))] ?? 0; }
	function pushTok(kind: TokKind, startI: number, endI: number, value: string) {
		if (endI <= startI) return;
		const start = origAt(startI);
		const end = origAt(endI - 1) + 1;
		out.push({ kind, value, start, end });
	}

	while (i < N) {
		// Use original offsets for disabled range checks
		const origIdx = origAt(i);
		if (inDisabled(origIdx, disabled)) { i++; continue; }

		const ch = sText[i];

		// whitespace
		if (/\s/.test(ch)) { i++; continue; }

		// comments
		if (ch === '/' && sText[i + 1] === '/') {
			const startI = i; while (i < N && sText[i] !== '\n') i++;
			pushTok('comment', startI, i, sText.slice(startI, i));
			continue;
		}
		if (ch === '/' && sText[i + 1] === '*') {
			const startI = i; i += 2;
			// Scan until closing */ or EOF; do not overshoot past the end
			let j = i;
			while (j < N && !(sText[j - 1] === '*' && sText[j] === '/')) j++;
			const closed = j < N;
			const endI = closed ? (j + 1) : j;
			i = endI;
			pushTok('comment', startI, endI, sText.slice(startI, endI));
			continue;
		}

		// preprocessor lines (for semantic tokens)
		if (ch === '#') {
			const startI = i; while (i < N && sText[i] !== '\n') i++;
			pushTok('pp', startI, i, sText.slice(startI, i));
			continue;
		}

		// strings
		if (ch === '"' || ch === '\'') {
			const quote = ch; const startI = i++;
			while (i < N) {
				const c = sText[i++];
				if (c === '\\') { i++; continue; }
				if (c === quote) break;
			}
			pushTok('str', startI, i, sText.slice(startI, i));
			continue;
		}

		// numbers
		const n = reNum.exec(sText.slice(i));
		if (n) {
			const startI = i; i += n[0].length;
			pushTok('num', startI, i, n[0]);
			continue;
		}

		// identifiers
		const id = reId.exec(sText.slice(i));
		if (id) {
			const startI = i; const val = id[0]; i += val.length;
			pushTok('id', startI, i, val);
			continue;
		}

		// punctuation / operators
		// combine two-char operators when applicable (==, !=, <=, >=, &&, ||, <<, >>, +=, -=, *=, /=, %=, ++, --)
		const startI = i;
		let val = ch;
		const next = sText[i + 1];
		if (
			(ch === '=' && next === '=') ||
			(ch === '!' && next === '=') ||
			(ch === '<' && (next === '=' || next === '<')) ||
			(ch === '>' && (next === '=' || next === '>')) ||
			(ch === '&' && next === '&') ||
			(ch === '|' && next === '|') ||
			((ch === '+' || ch === '-' || ch === '*' || ch === '/' || ch === '%') && next === '=') ||
			((ch === '+' && next === '+') || (ch === '-' && next === '-'))
		) {
			val = ch + next;
			i += 2;
		} else {
			i++;
		}
		pushTok(/[;:,()[\]{}]/.test(val) ? 'punc' : 'op', startI, i, val);
	}
	return out;
}
