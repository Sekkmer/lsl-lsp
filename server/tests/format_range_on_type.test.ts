import { describe, it, expect } from 'vitest';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { Range } from 'vscode-languageserver/node';
import { PreprocResult } from '../src/preproc';
import { formatRangeEdits, type FormatSettings } from '../src/format';

function mkDoc(text: string) {
	return TextDocument.create('file:///t.lsl', 'lsl', 1, text);
}

function mkPre(): PreprocResult {
	return { disabledRanges: [], includeTargets: [], includeSymbols: new Map(), missingIncludes: [] } as any;
}

const fmtSettings: FormatSettings = { enabled: true, braceStyle: 'same-line' };

describe('range and on-type formatting', () => {
	it('range formatting: fixes comma spacing only in selection', () => {
		const src = 'default {\n\tllOwnerSay("a,b,c");\n}\n';
		const doc = mkDoc(src);
		const pre = mkPre();
		// Select just inside the parentheses to avoid changing indentation or other lines
		const start = doc.positionAt(src.indexOf('a,b,c'));
		const end = { line: start.line, character: start.character + 'a,b,c'.length };
		const range: Range = { start, end };
		const edits = formatRangeEdits(doc, pre, fmtSettings, range);
		expect(edits.length).toBe(1);
		expect(edits[0].range).toEqual(range);
		expect(edits[0].newText).toBe('a, b, c');
	});

	it('range formatting: adds space after if before ( within selection', () => {
		const src = '\tif(true) llOwnerSay("x");\n';
		const doc = mkDoc(src);
		const pre = mkPre();
		const start = doc.positionAt(0);
		const end = doc.positionAt(src.indexOf(')') + 1);
		const range: Range = { start, end };
		const edits = formatRangeEdits(doc, pre, fmtSettings, range);
		expect(edits.length).toBe(1);
		expect(edits[0].newText).toContain('if (true)');
	});

	it('on-type formatting (simulated): normalizes for-header spacing on current line', () => {
		const line = 'for(i=0;i<10;i++){\n';
		const doc = mkDoc(line);
		const pre = mkPre();
		// Simulate on-type by formatting the whole current line
		const range: Range = { start: { line: 0, character: 0 }, end: { line: 0, character: Number.MAX_SAFE_INTEGER } };
		const edits = formatRangeEdits(doc, pre, fmtSettings, range);
		expect(edits.length).toBe(1);
		const out = edits[0].newText;
		expect(out).toContain('for (i = 0; i < 10; i++)');
		// ensure space before opening brace on same line style
		expect(out).toContain(') {');
	});
});
