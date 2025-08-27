import { describe, it, expect } from 'vitest';
import { docFrom, runPipeline } from './testUtils';
import { loadTestDefs } from './loadDefs.testutil';

// Minimal tests to ensure we warn on list==list and allow list==[] checks

describe('list equality/inequality behavior checks', () => {
	it('warns when comparing two lists with == (length-only)', async () => {
		const defs = await loadTestDefs();
		const code = `
integer f() {
  list a = [1,2];
  list b = [3,4];
  if (a == b) return 1;
  return 0;
}
`;
		const doc = docFrom(code, 'file:///list_eq1.lsl');
		const { analysis } = runPipeline(doc, defs);
		const msg = analysis.diagnostics.find(d => d.message.includes('compares only length'));
		expect(msg).toBeTruthy();
	});

	it('allows comparing a list to empty list literal []', async () => {
		const defs = await loadTestDefs();
		const code = `
integer f() {
  list a = [];
  if (a == []) return 1; // allowed emptiness check
  if ([] == a) return 2; // allowed emptiness check
  if (a != []) return 2; // allowed emptiness check
  if ([] != a) return 2; // allowed emptiness check
  return 0;
}
`;
		const doc = docFrom(code, 'file:///list_eq2.lsl');
		const { analysis } = runPipeline(doc, defs);
		const anyWarn = analysis.diagnostics.find(d => d.message.includes('compares only length'));
		expect(anyWarn).toBeFalsy();
	});
});
