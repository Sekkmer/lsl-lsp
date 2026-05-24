import { describe, it, expect } from 'vitest';
import { docFrom, runPipeline } from './testUtils';
import { loadTestDefs } from './loadDefs.testutil';

describe('float literals with exponents', () => {
	it('treats decimal exponent literals as floats', async () => {
		const defs = await loadTestDefs();
		const doc = docFrom('default { state_entry(){ float f = 1e2; integer i = 1e2; } }');
		const { analysis } = runPipeline(doc, defs);
		const msg = analysis.diagnostics.map(d => `${d.code}:${d.message}`).join('\n');
		expect(msg).not.toContain('Cannot assign integer to float');
		expect(msg).toContain('Cannot assign float to integer');
	});

	it('rejects decimal p-exponent like SL does', async () => {
		const defs = await loadTestDefs();
		const doc = docFrom('default { state_entry(){ float f = 2.2p04; } }');
		const { analysis } = runPipeline(doc, defs);
		expect(analysis.diagnostics.some(d => String(d.code).startsWith('LSL0'))).toBe(true);
	});

	it('parses hex float with p-exponent like 0x1.fp3', async () => {
		const defs = await loadTestDefs();
		const doc = docFrom('default { state_entry(){ float f = 0x1.fp3; string s = (string)0x1.fp3; } }');
		const { analysis } = runPipeline(doc, defs);
		const syntaxErr = analysis.diagnostics.find(d => String(d.code).startsWith('LSL0'));
		expect(syntaxErr).toBeFalsy();
	});
});
