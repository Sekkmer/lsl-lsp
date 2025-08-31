import { describe, it, expect } from 'vitest';
import { docFrom, runPipeline } from './testUtils';
import { loadTestDefs } from './loadDefs.testutil';
import { LSL_DIAGCODES } from '../src/parser';

describe('jump label handling', () => {
	it('does not flag jump target when label exists', async () => {
		const defs = await loadTestDefs();
		const doc = docFrom('default{ state_entry(){ jump L; @L; }}');
		const { analysis } = runPipeline(doc, defs);
		const unk = analysis.diagnostics.find(d => d.code === LSL_DIAGCODES.UNKNOWN_IDENTIFIER);
		expect(unk).toBeFalsy();
	});

	it('flags unknown jump target when missing label', async () => {
		const defs = await loadTestDefs();
		const doc = docFrom('default{ state_entry(){ jump M; @L; }}');
		const { analysis } = runPipeline(doc, defs);
		const unk = analysis.diagnostics.find(d => d.code === LSL_DIAGCODES.UNKNOWN_IDENTIFIER);
		expect(unk).toBeTruthy();
	});
});
