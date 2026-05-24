import { describe, it, expect } from 'vitest';
import { docFrom, runPipeline } from './testUtils';
import { loadTestDefs } from './loadDefs.testutil';

describe('list values inside list literals', () => {
	it('warns that empty list literal inside list literal causes a runtime error', async () => {
		const defs = await loadTestDefs();
		const code = `
integer f(){
  list a = [1, []];
  return 0;
}
`;
		const doc = docFrom(code, 'file:///list_nested1.lsl');
		const { analysis } = runPipeline(doc, defs);
		const diag = analysis.diagnostics.find(d => d.code === 'LSL014');
		expect(diag?.message).toContain('runtime error');
	});

	it('warns that variable of type list inside list literal causes a runtime error', async () => {
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
		const diag = analysis.diagnostics.find(d => d.code === 'LSL014');
		expect(diag?.message).toContain('runtime error');
	});

	it('does not warn for ordinary scalar list elements', async () => {
		const defs = await loadTestDefs();
		const code = `
integer h(){
  list y = [1, "x", <1, 2, 3>];
  return 0;
}
`;
		const doc = docFrom(code, 'file:///list_nested3.lsl');
		const { analysis } = runPipeline(doc, defs);
		const diag = analysis.diagnostics.find(d => d.code === 'LSL014');
		expect(diag).toBeUndefined();
	});
});
