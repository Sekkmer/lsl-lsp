import { describe, it, expect } from 'vitest';
import { docFrom, runPipeline } from './testUtils';
import { loadTestDefs } from './loadDefs.testutil';

describe('duplicate declarations', () => {
	it('errors on duplicate global vars', async () => {
		const defs = await loadTestDefs();
		const { analysis } = runPipeline(docFrom('integer a; integer a;\n'), defs);
		const dup = analysis.diagnostics.find(d => d.code === 'LSL070');
		expect(dup).toBeTruthy();
	});

	it('errors on duplicate functions', async () => {
		const defs = await loadTestDefs();
		const src = 'integer f() { return 0; }\ninteger f() { return 1; }\n';
		const { analysis } = runPipeline(docFrom(src), defs);
		const dup = analysis.diagnostics.find(d => d.code === 'LSL070');
		expect(dup).toBeTruthy();
	});

	it('errors on duplicate local in same block, but allows shadowing', async () => {
		const defs = await loadTestDefs();
		const src = 'default { state_entry() { integer x; integer x; { integer x; } } }\n';
		const { analysis } = runPipeline(docFrom(src), defs);
		const sameBlock = analysis.diagnostics.find(d => d.code === 'LSL070');
		expect(sameBlock).toBeTruthy();
	});

	it('does not leak nested block locals into the enclosing block', async () => {
		const defs = await loadTestDefs();
		const src = 'default { state_entry() { if (TRUE) { integer hidden = 1; } hidden = 2; } }\n';
		const { analysis } = runPipeline(docFrom(src), defs);
		expect(analysis.diagnostics.some(d => d.message === 'Unknown identifier hidden')).toBe(true);
	});

	it('errors on duplicate function parameter names', async () => {
		const defs = await loadTestDefs();
		const src = 'integer probe(integer value, integer value) { return value; }\n';
		const { analysis } = runPipeline(docFrom(src), defs);
		expect(analysis.diagnostics.some(d => d.code === 'LSL070')).toBe(true);
	});

	it('errors on duplicate state names in the same script', async () => {
		const defs = await loadTestDefs();
		const src = 'default { state_entry() { } }\nstate S { state_entry() { } }\nstate S { touch_start(integer n) { } }\n';
		const { analysis } = runPipeline(docFrom(src), defs);
		expect(analysis.diagnostics.some(d => d.code === 'LSL070' && /Duplicate declaration of state S/.test(d.message))).toBe(true);
	});
});
