import { describe, it, expect } from 'vitest';
import { docFrom, runPipeline } from './testUtils';
import { loadTestDefs } from './loadDefs.testutil';

// Helper to run analysis on code
async function analyze(code: string) {
	const defs = await loadTestDefs();
	const doc = docFrom(code);
	const { pre, tokens, analysis } = runPipeline(doc, defs, { macros: {}, includePaths: [] });
	return { doc, pre, tokens, analysis };
}

describe('unused locals/params', () => {
	it('flags unused local variable', async () => {
		const code = 'integer foo() { integer x = 1; return 0; }';
		const { analysis } = await analyze(code);
		const diag = analysis.diagnostics.find(d => d.code === 'LSL101');
		expect(diag).toBeTruthy();
		expect(diag?.message).toContain('Unused local variable');
	});
	it('flags unused param (no underscore)', async () => {
		const code = 'integer f(integer a) { return 0; }';
		const { analysis } = await analyze(code);
		const diag = analysis.diagnostics.find(d => d.code === 'LSL102');
		expect(diag).toBeTruthy();
		expect(diag?.message).toContain('Unused parameter');
	});
	it('does not flag underscore param when unused; warns when used', async () => {
		const code1 = 'integer f(integer _a) { return 0; }';
		const { analysis: a1 } = await analyze(code1);
		expect(a1.diagnostics.find(d => d.code === 'LSL102')).toBeFalsy();
		expect(a1.diagnostics.find(d => d.code === 'LSL103')).toBeFalsy();

		const code2 = 'integer f(integer _a) { return _a; }';
		const { analysis: a2 } = await analyze(code2);
		expect(a2.diagnostics.find(d => d.code === 'LSL102')).toBeFalsy();
		const warn = a2.diagnostics.find(d => d.code === 'LSL103');
		expect(warn).toBeTruthy();
		expect(warn?.message).toContain('underscore-prefixed');
	});
	it('flags unused locals/params in events', async () => {
		const code = 'default { touch_start(integer _c) { integer x; llOwnerSay("hi"); } }';
		const { analysis } = await analyze(code);
		// underscore param used? not used -> ok
		expect(analysis.diagnostics.find(d => d.code === 'LSL102')).toBeFalsy();
		const local = analysis.diagnostics.find(d => d.code === 'LSL101');
		expect(local).toBeTruthy();
	});
});
