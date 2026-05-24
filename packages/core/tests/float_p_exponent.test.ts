import { describe, it, expect } from 'vitest';
import { docFrom, runPipeline } from './testUtils';
import { loadTestDefs } from './loadDefs.testutil';

describe('float literals with p-exponent', () => {
	it('parses decimal p-exponent like 2.2p04', async () => {
		const defs = await loadTestDefs();
		const doc = docFrom('default { state_entry(){ float f = 2.2p04; string s = (string)2.2p04; } }');
		const { analysis } = runPipeline(doc, defs);
		// No syntax errors
		const syntaxErr = analysis.diagnostics.find(d => String(d.code).startsWith('LSL0'));
		expect(syntaxErr).toBeFalsy();
	});

	it('parses hex float with p-exponent like 0x1.fp3', async () => {
		const defs = await loadTestDefs();
		const doc = docFrom('default { state_entry(){ float f = 0x1.fp3; string s = (string)0x1.fp3; } }');
		const { analysis } = runPipeline(doc, defs);
		const syntaxErr = analysis.diagnostics.find(d => String(d.code).startsWith('LSL0'));
		expect(syntaxErr).toBeFalsy();
	});
});
