import { describe, it, expect } from 'vitest';
import { docFrom, runPipeline } from './testUtils';
import { loadTestDefs } from './loadDefs.testutil';

describe('trailing commas', () => {
	it('errors on trailing comma in function parameters', async () => {
		const defs = await loadTestDefs();
		const doc = docFrom('integer Foo(integer value,) { return value; }\ndefault { state_entry() { Foo(1); } }');
		const { analysis } = runPipeline(doc, defs);
		expect(analysis.diagnostics.some(d => d.code === 'LSL000' && /Trailing comma/.test(d.message))).toBe(true);
	});

	it('errors on trailing comma in event parameters', async () => {
		const defs = await loadTestDefs();
		const doc = docFrom('default { touch_start(integer total_number,) { llOwnerSay((string)total_number); } }');
		const { analysis } = runPipeline(doc, defs);
		expect(analysis.diagnostics.some(d => d.code === 'LSL000' && /Trailing comma/.test(d.message))).toBe(true);
	});

	it('errors on trailing comma in call arguments', async () => {
		const defs = await loadTestDefs();
		const doc = docFrom('integer Foo(integer value) { return value; }\ndefault { state_entry() { Foo(1,); } }');
		const { analysis } = runPipeline(doc, defs);
		expect(analysis.diagnostics.some(d => d.code === 'LSL000' && /Trailing comma/.test(d.message))).toBe(true);
	});

	it('errors on trailing comma in list literals', async () => {
		const defs = await loadTestDefs();
		const doc = docFrom('default { state_entry() { list values = [1,]; } }');
		const { analysis } = runPipeline(doc, defs);
		expect(analysis.diagnostics.some(d => d.code === 'LSL000' && /Trailing comma/.test(d.message))).toBe(true);
	});
});
