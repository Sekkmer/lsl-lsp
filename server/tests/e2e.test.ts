import path from 'node:path';
import { describe, it, expect } from 'vitest';
import { readFixture, runPipeline, docFrom } from './testUtils';
import { loadTestDefs } from './loadDefs.testutil';
import { loadDefs } from '../src/defs';

describe('e2e fixtures', () => {
	it('sample.lsl produces stable outputs', async () => {
		const defs = await loadTestDefs();
		const code = await readFixture('e2e/sample.lsl');
		const doc = docFrom(code, 'file:///proj/sample.lsl');
		const { pre, tokens, analysis } = runPipeline(doc, defs, {
			macros: { DEBUG: 1 },
			includePaths: [path.join(__dirname, 'fixtures', 'includes')]
		});

		// Golden-ish assertions (no snapshots): resilient to whitespace edits
		expect(pre.includes.length).toBe(1);
		expect(tokens.some(t => t.kind === 'str' && t.value.includes('"dbg"'))).toBe(true);
		// analysis sanity
		expect(analysis.calls.find(c => c.name === 'llSay' && c.args === 2)).toBeTruthy();
		// Only assert no errors; hints like unused vars may be present
		const errorDiags = analysis.diagnostics.filter(d => d.severity === 1 || d.severity === 2);
		// ensure no unexpected parser / analyzer errors
		expect(errorDiags.length).toBe(0);
	});
	it('big.lsl produces stable outputs', async () => {
		const defs = await loadDefs(path.join(__dirname, '..', '..', 'common', 'lsl-defs.json'));
		const code = await readFixture('e2e/big.lsl');
		const doc = docFrom(code, 'file:///proj/big.lsl');
		const { analysis } = runPipeline(doc, defs, {
			macros: { DEBUG: 1 },
			includePaths: [path.join(__dirname, 'fixtures', 'includes')]
		});

		// Looser assertions: big.lsl may have unused vars; ensure parser and analyzer work
		// Must have at least one state declared
		expect(Array.from(analysis.states.keys()).length).toBeGreaterThan(0);
		// Should have parsed some function calls
		expect(analysis.calls.length).toBeGreaterThan(0);
		const errorOrWarn = analysis.diagnostics.filter(d => d.severity === 1 || d.severity === 2);
		// ensure base compiles cleanly
		expect(errorOrWarn.length).toBe(0);
	});
	it('base.lsl compiles cleanly and provides Sign/Verify/XorValue', async () => {
		const defs = await loadDefs(path.join(__dirname, '..', '..', 'common', 'lsl-defs.json'));
		const code = await readFixture('e2e/base.lsl');
		const doc = docFrom(code, 'file:///proj/base.lsl');
		const { analysis } = runPipeline(doc, defs, { includePaths: [path.join(__dirname, 'fixtures', 'e2e')] });
		// Ensure functions are declared
		expect(analysis.functions.has('Sign')).toBe(true);
		expect(analysis.functions.has('Verify')).toBe(true);
		expect(analysis.functions.has('XorValue')).toBe(true);
		// No errors/warnings expected in a clean base
		const errorOrWarn = analysis.diagnostics.filter(d => d.severity === 1 || d.severity === 2);
		expect(errorOrWarn.length).toBe(0);
	});
	it('derive.lsl includes base and uses its API without errors', async () => {
		const defs = await loadDefs(path.join(__dirname, '..', '..', 'common', 'lsl-defs.json'));
		const code = await readFixture('e2e/derive.lsl');
		const doc = docFrom(code, 'file:///proj/derive.lsl');
		const { pre, analysis } = runPipeline(doc, defs, { includePaths: [path.join(__dirname, 'fixtures', 'e2e')] });
		// Should include base
		expect(pre.includes.some(p => p.endsWith('base.lsl'))).toBe(true);
		// Derive fixture may intentionally omit some declarations (e.g., undefined state), so we don't assert zero errors here.
		// Ensure we detected some states and calls
		expect(Array.from(analysis.states.keys()).length).toBeGreaterThan(0);
		expect(analysis.calls.length).toBeGreaterThan(0);
	});
});
