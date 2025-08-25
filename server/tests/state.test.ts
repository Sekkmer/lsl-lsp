import { describe, it, expect } from 'vitest';
import { docFrom, runPipeline } from './testUtils';
import { loadTestDefs } from './loadDefs.testutil';

describe('state transitions', () => {
	it('errors on unknown state', async () => {
		const defs = await loadTestDefs();
		const code = `default { state_entry() { state ready; } } state known { state_entry(){} }`;
		const doc = docFrom(code);
		const { analysis } = runPipeline(doc, defs);
		const err = analysis.diagnostics.find(d => d.code === 'LSL030');
		expect(err).toBeTruthy();
	});

	it('no error when state declared', async () => {
		const defs = await loadTestDefs();
		const code = `state ready { state_entry(){} } default { state_entry() { state ready; } }`;
		const doc = docFrom(code);
		const { analysis } = runPipeline(doc, defs);
		const err = analysis.diagnostics.find(d => d.code === 'LSL030');
		expect(err).toBeFalsy();
	});
});
