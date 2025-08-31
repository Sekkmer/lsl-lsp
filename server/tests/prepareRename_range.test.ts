import { describe, it, expect } from 'vitest';
import { docFrom, runPipeline } from './testUtils';
import { loadTestDefs } from './loadDefs.testutil';
import { prepareRename } from '../src/navigation';

function offsetOf(doc: any, needle: string): number {
	const idx = doc.getText().indexOf(needle);
	if (idx < 0) throw new Error(`needle not found: ${needle}`);
	return idx;
}

describe('prepareRename: identifier-only range', () => {
	it('returns tight range for function declaration name', async () => {
		const defs = await loadTestDefs();
		const doc = docFrom('integer RequestUrl() { return 0; }');
		const { analysis, pre } = runPipeline(doc, defs);
		const off = offsetOf(doc, 'RequestUrl');
		const range = prepareRename(doc, off, analysis, pre, defs);
		expect(range).toBeTruthy();
		const start = doc.offsetAt(range!.start);
		const end = doc.offsetAt(range!.end);
		expect(end - start).toBe('RequestUrl'.length);
	});

	it('returns tight range for local variable declaration name', async () => {
		const defs = await loadTestDefs();
		const doc = docFrom('default { state_entry() { integer request_url = 1; llSay(0, (string)request_url); } }');
		const { analysis, pre } = runPipeline(doc, defs);
		const off = offsetOf(doc, 'request_url =');
		const range = prepareRename(doc, off, analysis, pre, defs);
		expect(range).toBeTruthy();
		const start = doc.offsetAt(range!.start);
		const end = doc.offsetAt(range!.end);
		expect(end - start).toBe('request_url'.length);
	});

	it('returns tight range for reference inside a call', async () => {
		const defs = await loadTestDefs();
		const doc = docFrom('integer MyFn() { return 1; } default { state_entry() { integer x = MyFn(); } }');
		const { analysis, pre } = runPipeline(doc, defs);
		const off = offsetOf(doc, 'MyFn();');
		const range = prepareRename(doc, off, analysis, pre, defs);
		expect(range).toBeTruthy();
		const start = doc.offsetAt(range!.start);
		const end = doc.offsetAt(range!.end);
		expect(end - start).toBe('MyFn'.length);
	});
});
