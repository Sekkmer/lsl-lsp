import { describe, it, expect } from 'vitest';
import { LSL_DIAGCODES } from '../src/analysisTypes';
import { docFrom, runPipeline } from './testUtils';
import { loadTestDefs } from './loadDefs.testutil';

async function analyze(code: string) {
	const defs = await loadTestDefs();
	const doc = docFrom(code);
	const { analysis } = runPipeline(doc, defs, { macros: {}, includePaths: [] });
	return analysis;
}

function hasMustUseDiag(analysis: Awaited<ReturnType<typeof analyze>>) {
	return analysis.diagnostics.some(d => d.code === LSL_DIAGCODES.MUST_USE_RESULT);
}

describe('mustUse function results', () => {
	it('flags bare expression statement that drops result', async () => {
		const analysis = await analyze('default { state_entry() { llGetOwner(); } }');
		expect(hasMustUseDiag(analysis)).toBe(true);
	});

	it('considers assignment a valid use', async () => {
		const analysis = await analyze('default { state_entry() { key owner = llGetOwner(); } }');
		expect(hasMustUseDiag(analysis)).toBe(false);
	});

	it('treats if-condition usage as consuming the result', async () => {
		const analysis = await analyze('default { state_entry() { if (llGetOwner()) { llOwnerSay("ok"); } } }');
		expect(hasMustUseDiag(analysis)).toBe(false);
	});

	it('treats for-condition usage as consuming the result', async () => {
		const analysis = await analyze('default { state_entry() { for (; llGetOwner() == NULL_KEY; ) { llOwnerSay("waiting"); break; } } }');
		expect(hasMustUseDiag(analysis)).toBe(false);
	});

	it('flags for-initializer if result is dropped', async () => {
		const analysis = await analyze('default { state_entry() { for (llGetOwner(); ; ) { break; } } }');
		expect(hasMustUseDiag(analysis)).toBe(true);
	});

	it('treats usage as argument as consuming the result', async () => {
		const analysis = await analyze('default { state_entry() { llOwnerSay((string)llGetOwner()); } }');
		expect(hasMustUseDiag(analysis)).toBe(false);
	});
});

