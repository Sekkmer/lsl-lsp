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

	it('preserves LSL boolean constant spelling in object-like macro expansion', async () => {
		const defs = await loadTestDefs();
		const code = [
			'#define ALLOWED TRUE',
			'integer check() { return ALLOWED; }',
			'default { state_entry() { } }',
		].join('\n');
		const doc = docFrom(code, 'file:///proj/main.lsl');
		const { expandedTokens } = runPipeline(doc, defs, {});
		const values = expandedTokens?.map(t => t.value) ?? [];
		expect(values).toContain('TRUE');
		expect(values).not.toContain('true');
	});

	it('preserves parenthesized object-like macro grouping in bitmask expressions', async () => {
		const defs = await loadTestDefs();
		const code = [
			'#define MOVE_CONTROLS (CONTROL_FWD | CONTROL_BACK | CONTROL_LEFT)',
			'integer HasMoveControl(integer controls) { return (controls & MOVE_CONTROLS) != 0; }',
			'default { state_entry() { } }',
		].join('\n');
		const doc = docFrom(code, 'file:///proj/main.lsl');
		const { expandedTokens } = runPipeline(doc, defs, {});
		const values = expandedTokens?.map(t => t.value) ?? [];
		const returnIndex = values.indexOf('return');
		expect(values.slice(returnIndex + 1, returnIndex + 14)).toEqual([
			'(', 'controls', '&', '(', 'CONTROL_FWD', '|', 'CONTROL_BACK', '|', 'CONTROL_LEFT', ')', ')', '!=', '0',
		]);
	});
});
