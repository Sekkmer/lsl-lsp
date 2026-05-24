import { describe, it, expect } from 'vitest';
import { docFrom, runPipeline } from './testUtils';
import { loadTestDefs } from './loadDefs.testutil';

describe('Syntax error on index operator', () => {
	it('treats list indexing as syntax error (no list[number] operator in LSL)', async () => {
		const defs = await loadTestDefs();
		const code = 'list L; default { state_entry() { integer x = L[0]; } }';
		const doc = docFrom(code, 'file:///lhs_list_index.lsl');
		const { analysis } = runPipeline(doc, defs, { macros: {}, includePaths: [] });
		const msgs = analysis.diagnostics.map(d => `${d.message} @${d.code}`);
		expect(msgs.some(m => m.includes('Indexing with [] is not supported') && m.includes('LSL000'))).toBe(true);
	});
});
