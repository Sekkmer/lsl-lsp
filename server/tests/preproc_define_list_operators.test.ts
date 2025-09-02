import { describe, it, expect } from 'vitest';
import { docFrom, runPipeline } from './testUtils';
import { loadTestDefs } from './loadDefs.testutil';

// Verifies that an object-like macro with a bracketed list of string operators
// is preserved verbatim by the preprocessor and available in pre.macros.
describe('preprocessor: macro list of operators', () => {
	it('keeps SYMBOLS list macro as-is', async () => {
		const defs = await loadTestDefs();
		const code = [
			'#define SYMBOLS ["<<", ">>", "+", "-", "**", "*", "/", "%", "^", "~", "&&", "||", "&", "|", "(", ")"]',
			'default { state_entry() { llSay(0, "ok"); } }'
		].join('\n');
		const doc = docFrom(code, 'file:///proj/main.lsl');
		const { pre } = runPipeline(doc, defs, {});
		// Expect macro to exist and match exactly (string value)
		expect(Object.prototype.hasOwnProperty.call(pre.macros, 'SYMBOLS')).toBe(true);
		const v = pre.macros.SYMBOLS;
		expect(typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean').toBe(true);
		// Our parser treats quoted strings and non-numeric tokens as strings, so assert exact text
		expect(v).toBe('["<<", ">>", "+", "-", "**", "*", "/", "%", "^", "~", "&&", "||", "&", "|", "(", ")"]');
	});
});
