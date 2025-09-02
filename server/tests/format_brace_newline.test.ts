import { describe, it, expect } from 'vitest';
import { TextDocument } from 'vscode-languageserver-textdocument';
import type { PreprocResult } from '../src/core/preproc';
import { formatDocumentEdits, type FormatSettings } from '../src/format';

function fmt(input: string, braceStyle: 'same-line' | 'next-line' = 'same-line') {
	const doc = TextDocument.create('file:///t.lsl', 'lsl', 1, input);
	const pre: PreprocResult = { disabledRanges: [], macros: {}, funcMacros: {}, includes: [], includeTargets: [], includeSymbols: new Map() } as any;
	const settings: FormatSettings = { enabled: true, braceStyle };
	const edits = formatDocumentEdits(doc, pre, settings);
	return edits.length ? edits[0].newText : input;
}

describe('brace newline rule', () => {
	it('splits } else { to next line for next-line style', () => {
		const src = 'if (x) { do(); } else { more(); }\n';
		const out = fmt(src, 'next-line');
		expect(out).toContain('}\nelse {');
	});
	it('keeps } else { on same line for same-line style', () => {
		const src = 'if (x){ do(); }else{ more(); }\n';
		const out = fmt(src, 'same-line');
		// normalize spaces: expect single spaces around tokens
		expect(out).toContain('} else {');
	});
	it('keeps } else if (...) { on same line for same-line style', () => {
		const src = 'if (x){ do(); }else if(y){ more(); }\n';
		const out = fmt(src, 'same-line');
		expect(out).toContain('} else if (y) {');
	});
	it('splits } else if (...) { to next line for next-line style', () => {
		const src = 'if (x) { do(); } else if (y) { more(); }\n';
		const out = fmt(src, 'next-line');
		expect(out).toContain('}\nelse if (y) {');
	});
	it('moves statement after } to next line', () => {
		const src = '{ do(); } return;\n';
		const out = fmt(src);
		expect(out).toContain('}\nreturn;');
	});
});
