import { describe, it, expect } from 'vitest';
import { docFrom, runPipeline } from './testUtils';
import { loadTestDefs } from './loadDefs.testutil';

describe('missing commas', () => {
	it('errors on missing comma between list literal elements', async () => {
		const defs = await loadTestDefs();
		const doc = docFrom('default { state_entry() { list values = ["a" "b"]; } }');
		const { analysis } = runPipeline(doc, defs);
		expect(analysis.diagnostics.some(d => d.code === 'LSL000' && /Missing comma between list elements/.test(d.message))).toBe(true);
	});

	it('does not flag a single list element expression', async () => {
		const defs = await loadTestDefs();
		const doc = docFrom('default { state_entry() { list values = ["a" + "b"]; } }');
		const { analysis } = runPipeline(doc, defs);
		expect(analysis.diagnostics.some(d => d.code === 'LSL000' && /Missing comma/.test(d.message))).toBe(false);
	});

	it('errors on missing comma between call arguments', async () => {
		const defs = await loadTestDefs();
		const doc = docFrom('integer Foo(integer a, integer b) { return a + b; }\ndefault { state_entry() { Foo(1 2); } }');
		const { analysis } = runPipeline(doc, defs);
		expect(analysis.diagnostics.some(d => d.code === 'LSL000' && /Missing comma between arguments/.test(d.message))).toBe(true);
	});

	it('errors on missing comma between parameters', async () => {
		const defs = await loadTestDefs();
		const doc = docFrom('integer Foo(integer a integer b) { return a + b; }\ndefault { state_entry() { Foo(1, 2); } }');
		const { analysis } = runPipeline(doc, defs);
		expect(analysis.diagnostics.some(d => d.code === 'LSL000' && /Missing comma between parameters/.test(d.message))).toBe(true);
	});
});
