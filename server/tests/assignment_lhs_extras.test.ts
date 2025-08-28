import { describe, it, expect } from 'vitest';
import { docFrom, runPipeline } from './testUtils';
import { loadTestDefs } from './loadDefs.testutil';

describe('assignment LHS extras', () => {
	it('flags list index assignment as invalid LHS', async () => {
		const defs = await loadTestDefs();
		const code = `list L; default { state_entry() { L[0] = 1; } }`;
		const doc = docFrom(code, 'file:///lhs_list_index.lsl');
		const { analysis } = runPipeline(doc, defs, { macros: {}, includePaths: [] });
		const msgs = analysis.diagnostics.map(d => `${d.message} @${d.code}`);
		expect(msgs.some(m => m.includes('List elements are not assignable') && m.includes('LSL050'))).toBe(true);
	});
});
