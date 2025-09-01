import { describe, it, expect } from 'vitest';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { loadTestDefs } from './loadDefs.testutil';
import { runPipeline } from './testUtils';

// Essence of ARES macro: function-like define with line continuation (\\),
// casts, string concatenation, and an identifier parameter at the end.
// All identifiers are sanitized/generic to avoid coupling to external code.

describe('preprocessor: multi-line #define with \\\\ continuation', () => {
	it('captures function-like macro body across continued lines', async () => {
		const code = [
			'#define MY_IFACE(fn) call(CTX, SIG, \\\\',
			'                  (string)id + " " + (string)id + " iface " + fn)',
			'integer main(){ return 0; }',
			''
		].join('\n');

		const doc = TextDocument.create('file:///local-macro.lsl', 'lsl', 1, code);
		const defs = await loadTestDefs();
		const { pre } = runPipeline(doc, defs);
		expect(pre.funcMacros).toBeTruthy();
		// Macro should exist and include parameters
		expect(Object.prototype.hasOwnProperty.call(pre.funcMacros, 'MY_IFACE')).toBe(true);
		const body = pre.funcMacros['MY_IFACE'];
		// Expect the stored body to contain the params list and concatenated content
		expect(body.startsWith('(fn) ')).toBe(true);
		// Ensure newline from continuation was joined (we store a \n when stitching, acceptable)
		expect(body).toMatch(/call\(CTX, SIG,\s*[\s\S]*\(string\)id \+ .* \+ fn\)/);
	});
});
