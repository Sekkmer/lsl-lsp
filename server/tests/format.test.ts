import { describe, it, expect } from 'vitest';
import { TextDocument } from 'vscode-languageserver-textdocument';
import type { PreprocResult } from '../src/core/preproc';
import { formatDocumentEdits, type FormatSettings } from '../src/format';

function fmt(input: string, settings?: Partial<FormatSettings>, pre?: Partial<PreprocResult>) {
	const doc = TextDocument.create('file:///t.lsl', 'lsl', 1, input);
	const preFull: PreprocResult = {
		disabledRanges: pre?.disabledRanges ?? [],
		macros: {},
		funcMacros: {},
		includes: [],
		includeTargets: [],
		includeSymbols: new Map(),
	};
	const fmtSettings: FormatSettings = {
		enabled: true,
		braceStyle: (settings?.braceStyle ?? 'same-line'),
	};
	const edits = formatDocumentEdits(doc, preFull, fmtSettings);
	if (edits.length === 0) return input;
	return edits[0].newText;
}

describe('formatter basics', () => {
	it('adds space after commas', () => {
		const src = 'llSay(0,"a,b",x,y,\n	z);\n';
		const out = fmt(src);
		expect(out).toContain('x, y');
		// does not touch inside strings
		expect(out).toContain('"a,b"');
	});

	it('spaces after if/while/for before (', () => {
		const src = 'if(true){while(1){for(i=0;i<10;i++){}}}\n';
		const out = fmt(src);
		expect(out).toContain('if (true)');
		expect(out).toContain('while (1)');
		expect(out).toContain('for (i = 0; i < 10; i++)');
	});

	it('spaces after ; inside for header', () => {
		const src = 'for(i=0;i<10;i++){\n}\n';
		const out = fmt(src);
		expect(out).toContain('for (i = 0; i < 10; i++)');
	});

	it('respects next-line brace style', () => {
		const src = 'if (true){\nreturn;\n}\n';
		const out = fmt(src, { braceStyle: 'next-line' });
		expect(out).toContain('if (true)\n{');
	});

	it('reindents with detected style (tabs)', () => {
		const src = 'state default{\n\t\tif (true) {\n\treturn;\n\t}\n}\n';
		const out = fmt(src);
		// initial used tabs, formatter will detect tabs and reindent consistently
		expect(out).toContain('\n\t\tif (true) {');
	});

	it('does not format inside disabled ranges', () => {
		const src = '#if 0\nif(true){a,b;}\n#endif\n';
		const out = fmt(src, undefined, { disabledRanges: [{ start: 0, end: src.length - 1 }] });
		expect(out).toBe(src);
	});

	it('adds newline after ; outside for header', () => {
		const src = 'llOwnerSay("hi"); llOwnerSay("bye");\n';
		const out = fmt(src);
		expect(out).toContain('llOwnerSay("hi");\nllOwnerSay("bye");');
	});

	it('indents braces on their own line and inserts newline after opening brace', () => {
		const src = 'default {\n\ton_rez(integer start_param) { llResetScript();\n}\n}\n';
		const out = fmt(src);
		// Ensure newline after the opening brace of on_rez
		expect(out).toContain('on_rez(integer start_param) {\n');
		// Ensure two closing braces are on their own lines (ignore indentation, last newline optional)
		expect(/\n\s*}\n\s*}\n?$/.test(out)).toBe(true);
	});

	it('indents only first statement line to scope, keeps multiline continuations', () => {
		const src = 'default {\nreturn;\nllOwnerSay(\n"hi");\n}\n';
		const out = fmt(src);
		// First statement under the block should be indented (any whitespace)
		expect(/\n\s+return;/.test(out)).toBe(true);
		// Next statement first line should also be indented (any whitespace)
		expect(/\n\s+llOwnerSay\(/.test(out)).toBe(true);
		// Continuation line inside parentheses should not be forcibly indented to scope (allow 0 or existing)
		// In this synthetic example, it should remain at column 0
		expect(/\n"hi"\);/.test(out)).toBe(true);
	});

	it('does not split "+=" in for-header increment', () => {
		const src = 'for(i=0;i<len;i+=2){}\n';
		const out = fmt(src);
		expect(out).toContain('for (i = 0; i < len; i += 2)');
		// Ensure no stray space separates + and =
		expect(out).not.toMatch(/\+\s+=/);
	});
});
