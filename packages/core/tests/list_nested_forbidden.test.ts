import { describe, it, expect } from 'vitest';
import { docFrom, runPipeline } from './testUtils';
import { loadTestDefs } from './loadDefs.testutil';

describe('list values inside list literals', () => {
	it('allows empty list literal inside list literal', async () => {
		const defs = await loadTestDefs();
		const code = `
integer f(){
  list a = [1, []];
  return 0;
}
`;
		const doc = docFrom(code, 'file:///list_nested1.lsl');
		const { analysis } = runPipeline(doc, defs);
		const diag = analysis.diagnostics.find(d => d.message.includes('List element cannot be a list'));
		expect(diag).toBeUndefined();
	});

	it('allows variable of type list inside list literal', async () => {
		const defs = await loadTestDefs();
		const code = `
integer g(){
  list x = [];
  list y = [x];
  return 0;
}
`;
		const doc = docFrom(code, 'file:///list_nested2.lsl');
		const { analysis } = runPipeline(doc, defs);
		const diag = analysis.diagnostics.find(d => d.message.includes('List element cannot be a list'));
		expect(diag).toBeUndefined();
	});
});
