import { TextDocument } from 'vscode-languageserver-textdocument';
import { TextEdit, Range } from 'vscode-languageserver/node';
import type { PreprocResult } from './core/preproc';

export interface FormatSettings {
	enabled: boolean;
	braceStyle: 'same-line' | 'next-line';
}

function inDisabled(offset: number, disabled: { start: number; end: number }[]): boolean {
	return disabled.some(r => offset >= r.start && offset <= r.end);
}

function gcd(a: number, b: number): number {
	while (b) { const t = b; b = a % b; a = t; }
	return Math.abs(a) || 0;
}

export function detectIndent(text: string): { useTabs: boolean; size: number; unit: string } {
	let tabLines = 0; let spaceLines = 0;
	const spaceIndents: number[] = [];
	const deltas: number[] = [];
	let prevSpaces: number | null = null;
	let i = 0;
	while (i < text.length) {
		let j = i;
		let spaces = 0; let tabs = 0;
		while (j < text.length) {
			const c = text[j];
			if (c === ' ') { spaces++; j++; continue; }
			if (c === '\t') { tabs++; j++; continue; }
			break;
		}
		const isBlank = (j >= text.length) || text[j] === '\n' || text[j] === '\r';
		if (!isBlank) {
			if (tabs > 0 && spaces === 0) tabLines++;
			if (spaces > 0 && tabs === 0) { spaceLines++; spaceIndents.push(spaces); }
			if (prevSpaces != null && spaces > prevSpaces) deltas.push(spaces - prevSpaces);
			prevSpaces = spaces;
		}
		while (j < text.length && text[j] !== '\n') j++;
		if (j < text.length && text[j] === '\n') j++;
		i = j;
	}
	const useTabs = tabLines > spaceLines;
	let size = 4;
	if (!useTabs) {
		let g = 0;
		for (const d of deltas) g = gcd(g || d, d);
		if (g >= 2 && g <= 8) size = g;
		else {
			const freq: Record<number, number> = { 2: 0, 4: 0, 8: 0 };
			for (const s of spaceIndents) {
				if (s % 2 === 0) freq[2] += 1;
				if (s % 4 === 0) freq[4] += 1;
				if (s % 8 === 0) freq[8] += 1;
			}
			size = [2, 4, 8].reduce((a, b) => (freq[b] > freq[a] ? b : a), 4);
		}
	}
	const unit = useTabs ? '\t' : ' '.repeat(size);
	return { useTabs, size, unit };
}

type InitialFormatState = { braceDepth: number; parenDepth: number; forHeaderDepth: number | null; pendingIndent: boolean };

function formatCore(text: string, disabledRanges: { start: number; end: number }[], settings: FormatSettings, indentInfo?: { useTabs: boolean; size: number; unit: string }, initialState?: InitialFormatState) {
	const indent = indentInfo ?? detectIndent(text);
	let out = '';
	let i = 0;
	let _lastNonWs = '';
	let pendingIndent = initialState?.pendingIndent ?? true;
	let braceDepth = initialState?.braceDepth ?? 0;
	let parenDepth = initialState?.parenDepth ?? 0;
	let forHeaderDepth: number | null = initialState?.forHeaderDepth ?? null;
	while (i < text.length) {
		// If we're at the beginning of a line, and the line (ignoring leading ws) starts with a '#',
		// it's a preprocessor directive. Copy the whole line verbatim and do not format it.
		if (pendingIndent) {
			let j = i;
			while (j < text.length && (text[j] === ' ' || text[j] === '\t')) j++;
			if (j < text.length && text[j] === '#') {
				// Copy up to and including newline if present
				let k = j;
				while (k < text.length && text[k] !== '\n') k++;
				// Preserve the original leading whitespace too
				out += text.slice(i, k);
				i = k;
				if (i < text.length && text[i] === '\n') { out += '\n'; i++; }
				pendingIndent = true;
				continue;
			}
		}
		if (pendingIndent && !inDisabled(i, disabledRanges)) {
			let j = i;
			let spaces = 0, tabs = 0;
			while (j < text.length && (text[j] === ' ' || text[j] === '\t')) {
				if (text[j] === ' ') spaces++; else tabs++;
				j++;
			}
			const firstNonWs = j < text.length ? text[j] : '';
			const isBlankLine = (j >= text.length) || firstNonWs === '\n' || firstNonWs === '\r';
			const isContinuation = parenDepth > 0;
			let units = 0;
			if (indent.useTabs) units = tabs + Math.floor(spaces / indent.size);
			else units = Math.floor((tabs * indent.size + spaces) / indent.size);
			const expectedDepth = firstNonWs === '}' ? Math.max(0, braceDepth - 1) : braceDepth;
			let targetUnits = units;
			if (!isBlankLine && !isContinuation && firstNonWs !== '') {
				if (units < expectedDepth) targetUnits = expectedDepth;
			}
			if (!isBlankLine) {
				if (indent.useTabs) out += '\t'.repeat(targetUnits);
				else out += ' '.repeat(targetUnits * indent.size + (spaces + tabs * indent.size) % indent.size);
			}
			i = j;
			pendingIndent = false;
		}
		if (inDisabled(i, disabledRanges)) {
			const chd = text[i++];
			out += chd;
			if (chd === '\n') pendingIndent = true;
			continue;
		}
		const ch = text[i];
		if (ch === '"' || ch === '\'') {
			i++; out += ch;
			while (i < text.length) {
				const c = text[i++]; out += c;
				if (c === '\\') { if (i < text.length) { out += text[i++]; } continue; }
				if (c === ch) break;
			}
			_lastNonWs = ch;
			continue;
		}
		if (ch === '/' && text[i+1] === '/') {
			const s = i; while (i < text.length && text[i] !== '\n') i++;
			out += text.slice(s, i);
			_lastNonWs = '/';
			continue;
		}
		if (ch === '/' && text[i+1] === '*') {
			const s = i; i += 2;
			while (i < text.length && !(text[i-1] === '*' && text[i] === '/')) i++;
			i++;
			out += text.slice(s, i);
			_lastNonWs = '/';
			continue;
		}
		if (ch === ',') {
			out += ',';
			i++;
			let j = i;
			let sawNewline = false;
			while (j < text.length && (text[j] === ' ' || text[j] === '\t')) j++;
			if (text[j] === '\n' || text[j] === '\r') { sawNewline = true; }
			if (!sawNewline) {
				out += ' ';
			}
			i = j;
			_lastNonWs = ',';
			continue;
		}
		if (ch === '(') {
			let k = out.length - 1;
			let hasNewlineBetween = false;
			while (k >= 0 && (out[k] === ' ' || out[k] === '\t')) { k--; }
			if (k >= 0 && (out[k] === '\n' || out[k] === '\r')) {
				hasNewlineBetween = true;
			}
			const tEnd = k;
			while (k >= 0 && /[A-Za-z_]/.test(out[k])) k--;
			const tStart = k + 1;
			const token = out.slice(tStart, tEnd + 1);
			const isCtrl = token === 'if' || token === 'while' || token === 'for';
			if (isCtrl && !hasNewlineBetween) {
				out = out.slice(0, tEnd + 1) + ' ';
			}
			out += '(';
			i++;
			parenDepth++;
			if (token === 'for' && isCtrl) {
				forHeaderDepth = parenDepth;
			}
			_lastNonWs = '(';
			continue;
		}
		if (ch === ')') {
			out += ')';
			i++;
			if (forHeaderDepth !== null && parenDepth === forHeaderDepth) {
				forHeaderDepth = null;
			}
			parenDepth = Math.max(0, parenDepth - 1);
			_lastNonWs = ')';
			continue;
		}
		if (ch === ';') {
			out += ';';
			i++;
			if (forHeaderDepth !== null && parenDepth === forHeaderDepth) {
				let j = i;
				while (j < text.length && (text[j] === ' ' || text[j] === '\t')) j++;
				const nextCh = text[j];
				if (nextCh !== '\n' && nextCh !== '\r' && nextCh !== ')') {
					out += ' ';
				}
				i = j;
			} else {
				let j = i;
				while (j < text.length && (text[j] === ' ' || text[j] === '\t')) j++;
				if (j < text.length && text[j] !== '\n' && text[j] !== '\r') {
					out += '\n';
					pendingIndent = true;
					i = j;
				}
			}
			_lastNonWs = ';';
			continue;
		}
		if (forHeaderDepth !== null && parenDepth === forHeaderDepth) {
			if (ch === '=' || ch === '<' || ch === '>' ) {
				let op = '';
				if (ch === '<' || ch === '>') {
					// support <, <=, <<, <<= and similarly for '>'
					const c = ch;
					if (text[i+1] === c && text[i+2] === '=') { op = c + c + '='; i += 3; }
					else if (text[i+1] === c) { op = c + c; i += 2; }
					else if (text[i+1] === '=') { op = c + '='; i += 2; }
					else { op = c; i += 1; }
				} else if (ch === '=') {
					// '=' or '==' or compound assignment like +=, -=, *=, etc.
					if (text[i+1] === '=') { op = '=='; i += 2; }
					else {
						// Look behind in output for an operator to merge with '=' (e.g., '+', '-', '*', '/', '%', '&', '|', '^', '<<', '>>')
						let k = out.length - 1;
						while (k >= 0 && (out[k] === ' ' || out[k] === '\t')) k--;
						let prefix = '';
						if (k >= 0 && (out[k] === '<' || out[k] === '>')) {
							const first = out[k];
							let k2 = k - 1; while (k2 >= 0 && (out[k2] === ' ' || out[k2] === '\t')) k2--;
							if (k2 >= 0 && out[k2] === first) { prefix = first + first; k = k2 - 0; }
							else { prefix = first; }
						} else if (k >= 0 && '+-*/%&|^'.includes(out[k]!)) {
							prefix = out[k] as string;
						}
						// Remove any trailing spaces and the prefix operator (if any) from out
						let trimIdx = out.length - 1; while (trimIdx >= 0 && (out[trimIdx] === ' ' || out[trimIdx] === '\t')) trimIdx--;
						if (prefix.length > 0) {
							let pLeft = trimIdx;
							for (let m = prefix.length - 1; m >= 0 && pLeft >= 0; m--) {
								if (out[pLeft] === prefix[m]) { pLeft--; }
								else { break; }
							}
							out = out.slice(0, pLeft + 1);
						} else {
							out = out.slice(0, trimIdx + 1);
						}
						op = (prefix || '') + '=';
						i += 1;
						while (i < text.length && (text[i] === ' ' || text[i] === '\t')) i++;
					}
				}
				// emit with spaces around combined operator
				let k2 = out.length - 1; while (k2 >= 0 && (out[k2] === ' ' || out[k2] === '\t')) k2--;
				out = out.slice(0, k2 + 1);
				out += ' ' + op + ' ';
				_lastNonWs = op[op.length - 1];
				continue;
			}
		}
		if (ch === '{') {
			if (settings.braceStyle === 'next-line') {
				let k = out.length - 1;
				while (k >= 0 && (out[k] === ' ' || out[k] === '\t')) k--;
				const idEnd = k;
				while (k >= 0 && /[A-Za-z_]/.test(out[k])) k--;
				const token = out.slice(k + 1, idEnd + 1);
				let keepSameLine = token === 'else';
				if (!keepSameLine) {
					const lookbehind = out.slice(Math.max(0, out.length - 100));
					if (/else\s+if\s*\([^\n]*$/.test(lookbehind)) keepSameLine = true;
				}
				if (keepSameLine) {
					out = out.slice(0, idEnd + 1) + ' ' + '{';
				} else {
					k = out.length - 1;
					while (k >= 0 && (out[k] === ' ' || out[k] === '\t')) k--;
					if (k >= 0 && out[k] !== '\n') {
						out = out.slice(0, k + 1) + '\n';
					}
					const braceUnits = braceDepth;
					if (indent.useTabs) out += '\t'.repeat(braceUnits); else out += ' '.repeat(braceUnits * indent.size);
					out += '{';
				}
			} else {
				let k = out.length - 1;
				while (k >= 0 && (out[k] === ' ' || out[k] === '\t')) k--;
				const prevIsNewline = k < 0 || out[k] === '\n' || out[k] === '\r';
				const prevIsBrace = k >= 0 && out[k] === '{';
				const needSpace = !prevIsNewline && !prevIsBrace;
				if (needSpace) {
					out = out.slice(0, k + 1) + ' ';
				}
				out += '{';
			}
			i++;
			braceDepth++;
			_lastNonWs = '{';
			{
				let j2 = i;
				while (j2 < text.length && (text[j2] === ' ' || text[j2] === '\t')) j2++;
				const nextCh = text[j2];
				if (nextCh && nextCh !== '\n' && nextCh !== '\r' && nextCh !== '}') {
					out += '\n';
					pendingIndent = true;
					i = j2;
				}
			}
			continue;
		}
		if (ch === '}') {
			out += '}';
			i++;
			braceDepth = Math.max(0, braceDepth - 1);
			let j = i;
			while (j < text.length && (text[j] === ' ' || text[j] === '\t')) j++;
			const ahead = text.slice(j, j + 4);
			if (j < text.length && text[j] !== '\n' && text[j] !== '\r') {
				const isElse = ahead === 'else';
				if (isElse) {
					if (settings.braceStyle === 'same-line') {
						out += ' ';
						i = j;
					} else {
						out += '\n';
						pendingIndent = true;
						i = j;
					}
				} else {
					out += '\n';
					pendingIndent = true;
					i = j;
				}
			}
			_lastNonWs = '}';
			continue;
		}
		out += ch;
		if (!/\s/.test(ch)) _lastNonWs = ch;
		if (ch === '\n') pendingIndent = true;
		i++;
	}
	return { out, indent };
}

export function formatDocumentEdits(doc: TextDocument, pre: PreprocResult, settings: FormatSettings): TextEdit[] {
	const text = doc.getText();
	const { out } = formatCore(text, pre.disabledRanges, settings);
	if (out === text) return [];
	const full: Range = { start: doc.positionAt(0), end: doc.positionAt(text.length) };
	return [{ range: full, newText: out }];
}

function computeInitialStateBefore(text: string, disabled: { start: number; end: number }[], endOffset: number): InitialFormatState {
	let i = 0;
	let braceDepth = 0;
	let parenDepth = 0;
	const forHeaderDepth: number | null = null;
	function inDis(pos: number) { return disabled.some(r => pos >= r.start && pos < r.end); }
	while (i < endOffset) {
		if (inDis(i)) { const r = disabled.find(r => i >= r.start && i < r.end)!; i = Math.min(endOffset, r.end); continue; }
		// Skip directive lines starting at BOL
		let bol = i;
		while (bol > 0 && text[bol - 1] !== '\n') bol--;
		let j = bol;
		while (j < endOffset && (text[j] === ' ' || text[j] === '\t')) j++;
		if (j < endOffset && text[j] === '#') { while (j < endOffset && text[j] !== '\n') j++; i = j; if (i < endOffset && text[i] === '\n') i++; continue; }
		const ch = text[i]!;
		// strings
		if (ch === '"' || ch === '\'') { const q = ch; i++; while (i < endOffset) { const c = text[i++]; if (c === '\\') { if (i < endOffset) i++; continue; } if (c === q) break; } continue; }
		// line comment
		if (ch === '/' && i + 1 < endOffset && text[i+1] === '/') { while (i < endOffset && text[i] !== '\n') i++; continue; }
		// block comment
		if (ch === '/' && i + 1 < endOffset && text[i+1] === '*') { i += 2; while (i < endOffset && !(text[i-1] === '*' && text[i] === '/')) i++; if (i < endOffset) i++; continue; }
		if (ch === '{') { braceDepth++; i++; continue; }
		if (ch === '}') { braceDepth = Math.max(0, braceDepth - 1); i++; continue; }
		if (ch === '(') { parenDepth++; i++; continue; }
		if (ch === ')') { parenDepth = Math.max(0, parenDepth - 1); i++; continue; }
		i++;
	}
	// pendingIndent is true if at BOL
	let pendingIndent = false;
	if (endOffset === 0) pendingIndent = true; else pendingIndent = text[endOffset - 1] === '\n' || text[endOffset - 1] === '\r';
	return { braceDepth, parenDepth, forHeaderDepth, pendingIndent };
}

export function formatRangeEdits(doc: TextDocument, pre: PreprocResult, settings: FormatSettings, range: Range): TextEdit[] {
	const text = doc.getText();
	const start = doc.offsetAt(range.start);
	const end = doc.offsetAt(range.end);
	const target = text.slice(start, end);
	// Compute initial state before the range using the whole doc, skipping disabled ranges
	const init = computeInitialStateBefore(text, pre.disabledRanges, start);
	// In a targeted range format, we intentionally allow formatting inside disabled ranges.
	// So we pass an empty disabledRanges array for the slice, but still preserve directives.
	const { out } = formatCore(target, [], settings, detectIndent(text), init);
	if (out === target) return [];
	return [{ range, newText: out }];
}
