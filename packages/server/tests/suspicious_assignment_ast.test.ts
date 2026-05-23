import { describe, it, expect } from 'vitest';
import { docFrom } from './testUtils';
import { loadTestDefs } from './loadDefs.testutil';
import { runPipeline } from './testUtils';

describe('suspicious assignment in conditions (AST)', () => {
	it('warns on x = 1 inside if condition', async () => {
		const defs = await loadTestDefs();
		const code = `
integer foo(integer x) {
	if (x = 1) return 1; // suspicious
	return 0;
}
`;
		const doc = docFrom(code, 'file:///suspicious1.lsl');
		const { analysis } = runPipeline(doc, defs);
		const msgs = analysis.diagnostics.map(d => d.message);
		expect(msgs.some(m => m.includes('Suspicious assignment in condition'))).toBe(true);
	});


	it('does not warn on ==', async () => {
		const defs = await loadTestDefs();
		const code = `
integer foo(integer x) {
	if (x == 1) return 1; // ok
	return 0;
}
`;
		const doc = docFrom(code, 'file:///suspicious2.lsl');
		const { analysis } = runPipeline(doc, defs);
		const msgs = analysis.diagnostics.map(d => d.message);
		expect(msgs.some(m => m.includes('Suspicious assignment in condition'))).toBe(false);
	});
});
