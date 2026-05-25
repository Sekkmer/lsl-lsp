import type { Token } from './tokens';
import type { FormatSettings } from '../format';
import { formatDocumentEdits } from '../format';
import { TextDocument } from '../protocol';
import type { PreprocResult } from './preproc';

export function renderExpandedTokens(tokens: ReadonlyArray<Token>): string {
	let out = '';
	let indent = 0;
	let atLineStart = true;
	let previous: Token | undefined;
	for (const token of tokens) {
		if (token.kind === 'eof') continue;
		if (token.value === '}') {
			if (!atLineStart) {
				out = out.trimEnd();
				out += '\n';
			}
			indent = Math.max(0, indent - 1);
		}
		if (atLineStart) {
			out += '\t'.repeat(indent);
		} else if (previous && needsSpace(previous, token)) {
			out += ' ';
		}
		out += token.value;
		atLineStart = false;
		if (token.value === '{') {
			indent++;
			out += '\n';
			atLineStart = true;
		} else if (token.value === ';' || token.value === '}') {
			out += '\n';
			atLineStart = true;
		}
		previous = token;
	}
	return out.trimEnd();
}

export function formatLslText(text: string, settings: FormatSettings = { enabled: true, braceStyle: 'same-line' }): string {
	const doc = TextDocument.create('lsl-output:/script.lsl', 'lsl', 0, text);
	const emptyPre: PreprocResult = {
		disabledRanges: [],
		inactiveRanges: [],
		macros: {},
		funcMacros: {},
		includes: [],
	};
	const edits = formatDocumentEdits(doc, emptyPre, { ...settings, enabled: true });
	if (edits.length === 0) return text;
	let out = text;
	for (const edit of [...edits].sort((a, b) => doc.offsetAt(b.range.start) - doc.offsetAt(a.range.start))) {
		const start = doc.offsetAt(edit.range.start);
		const end = doc.offsetAt(edit.range.end);
		out = `${out.slice(0, start)}${edit.newText}${out.slice(end)}`;
	}
	return out;
}

function needsSpace(left: Token, right: Token): boolean {
	const leftWord = left.kind === 'id' || left.kind === 'keyword' || left.kind === 'number' || left.kind === 'string';
	const rightWord = right.kind === 'id' || right.kind === 'keyword' || right.kind === 'number' || right.kind === 'string';
	if (leftWord && rightWord) return true;
	if (left.value === ')' && (right.kind === 'id' || right.kind === 'keyword' || right.kind === 'number' || right.kind === 'string')) return true;
	if (right.value === '(') return left.kind === 'keyword';
	if (right.value === '{') return true;
	if (left.value === '{' || left.value === ';' || left.value === '}') return true;
	if (right.value === '}' || right.value === ';' || right.value === ',' || right.value === ')' || right.value === ']') return false;
	if (left.value === '(' || left.value === '[' || left.value === '<') return false;
	return left.kind === 'op' || right.kind === 'op';
}
