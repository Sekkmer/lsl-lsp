import { describe, it, expect } from 'vitest';
import { docFrom, runPipeline } from './testUtils';
import { loadTestDefs } from './loadDefs.testutil';
import { lslHover } from '../src/hover';

describe('events: strict validation and hovers', () => {
	it('errors on unknown event', async () => {
		const defs = await loadTestDefs();
		const doc = docFrom('default { touch_starrt(integer n) { } }');
		const { analysis } = runPipeline(doc, defs);
		const err = analysis.diagnostics.find(d => d.code === 'LSL021');
		expect(err).toBeTruthy();
	});

	it('errors on wrong arity', async () => {
		const defs = await loadTestDefs();
		const doc = docFrom('default { touch_start() { } }');
		const { analysis } = runPipeline(doc, defs);
		const err = analysis.diagnostics.find(d => d.code === 'LSL010');
		expect(err).toBeTruthy();
	});

	it('errors on wrong param type', async () => {
		const defs = await loadTestDefs();
		const doc = docFrom('default { touch_start(string n) { } }');
		const { analysis } = runPipeline(doc, defs);
		const err = analysis.diagnostics.find(d => d.code === 'LSL011');
		expect(err).toBeTruthy();
	});

	it("doesn't enforce parameter names (only types)", async () => {
		const defs = await loadTestDefs();
		// Use a different parameter name than the defs provide; type is still integer
		const doc = docFrom('default { touch_start(integer foo) { } }');
		const { analysis } = runPipeline(doc, defs);
		// Should have no WRONG_TYPE/WRONG_ARITY just due to name mismatch
		const wrongType = analysis.diagnostics.find(d => d.code === 'LSL011');
		const wrongArity = analysis.diagnostics.find(d => d.code === 'LSL010');
		expect(wrongType).toBeFalsy();
		expect(wrongArity).toBeFalsy();
	});

	it('errors when extra parameters are provided', async () => {
		const defs = await loadTestDefs();
		// touch_start expects 1 integer param; provide two params
		const doc = docFrom('default { touch_start(integer a, integer b) { } }');
		const { analysis } = runPipeline(doc, defs);
		const err = analysis.diagnostics.find(d => d.code === 'LSL010');
		expect(err).toBeTruthy();
	});

	it('hover shows event param type/name', async () => {
		const defs = await loadTestDefs();
		const code = 'default { touch_start(integer total_number) { } }';
		const doc = docFrom(code);
		const { analysis, pre } = runPipeline(doc, defs);
		const idx = code.indexOf('total_number');
		const hv = lslHover(doc, { position: doc.positionAt(idx + 1) }, defs, analysis, pre);
		expect(hv).toBeTruthy();
		const md = hv!.contents.value as string;
		expect(md).toContain('integer total_number');
		expect(md).toMatch(/Parameter:\s*total_number/i);
		expect(md).toContain('Number of detected touches.');
	});
});
