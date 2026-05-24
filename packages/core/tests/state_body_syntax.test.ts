import { describe, it, expect } from 'vitest';
import { docFrom, runPipeline } from './testUtils';
import { loadTestDefs } from './loadDefs.testutil';

describe('state body syntax', () => {
	it('errors on stray top-level semicolons', async () => {
		const defs = await loadTestDefs();
		const doc = docFrom(';\ndefault { state_entry() { } }');
		const { analysis } = runPipeline(doc, defs);
		expect(analysis.diagnostics.some(d => d.code === 'LSL000' && /unexpected ';' at top-level/.test(d.message))).toBe(true);
	});

	it('errors on stray semicolons directly inside a state body', async () => {
		const defs = await loadTestDefs();
		const doc = docFrom('default { ; state_entry() { } }');
		const { analysis } = runPipeline(doc, defs);
		expect(analysis.diagnostics.some(d => d.code === 'LSL000' && /Only event handlers/.test(d.message))).toBe(true);
	});

	it('errors on variable declarations directly inside a state body', async () => {
		const defs = await loadTestDefs();
		const doc = docFrom('default { integer x; state_entry() { } }');
		const { analysis } = runPipeline(doc, defs);
		expect(analysis.diagnostics.some(d => d.code === 'LSL000' && /Only event handlers/.test(d.message))).toBe(true);
	});

	it('errors on statements directly inside a state body', async () => {
		const defs = await loadTestDefs();
		const doc = docFrom('default { x = 1; state_entry() { } }');
		const { analysis } = runPipeline(doc, defs);
		expect(analysis.diagnostics.some(d => d.code === 'LSL000' && /Only event handlers/.test(d.message))).toBe(true);
	});
});
