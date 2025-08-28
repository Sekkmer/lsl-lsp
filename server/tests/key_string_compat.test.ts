import { describe, it, expect } from 'vitest';
import { docFrom, runPipeline } from './testUtils';
import { loadTestDefs } from './loadDefs.testutil';

describe('key <-> string compatibility', () => {
	it('accepts passing key to string parameter (llSay)', async () => {
		const defs = await loadTestDefs();
		const code = `default { state_entry() { string s = (string)llGetOwner(); llSay(0, s); } }`;
		const doc = docFrom(code);
		const { analysis } = runPipeline(doc, defs);
		const wrong = analysis.diagnostics.find(d => d.code === 'LSL011');
		expect(wrong).toBeFalsy();
	});

	it('accepts passing string to key parameter via explicit cast location target', async () => {
		const defs = await loadTestDefs();
		// llGetObjectDetails(key id, list params) normally expects key; ensure string cast is accepted by our relaxed rules in general type checks
		const code = `default { state_entry() { list x = llGetObjectDetails((key)"00000000-0000-0000-0000-000000000000", [OBJECT_NAME]); } }`;
		const doc = docFrom(code);
		const { analysis } = runPipeline(doc, defs);
		const wrong = analysis.diagnostics.find(d => d.code === 'LSL011');
		expect(wrong).toBeFalsy();
	});
});
