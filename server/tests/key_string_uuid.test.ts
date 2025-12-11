import { describe, it, expect } from 'vitest';
import { docFrom, runPipeline } from './testUtils';
import { loadTestDefs } from './loadDefs.testutil';

const UUID = '00000000-0000-0000-0000-000000000000';

describe('string literal UUID to key', () => {
	it('accepts UUID-like string literal for key parameter', async () => {
		const defs = await loadTestDefs();
		const code = `
integer foo(key _k) { return 0; }

default {
	state_entry() {
		foo("${UUID}");
	}
}
`;
		const doc = docFrom(code);
		const { analysis } = runPipeline(doc, defs);
		const wrongType = analysis.diagnostics.find(d => d.code === 'LSL011');
		expect(wrongType).toBeFalsy();
	});

	it('rejects non-UUID string literal for key parameter', async () => {
		const defs = await loadTestDefs();
		const code = `
integer foo(key _k) { return 0; }

default {
	state_entry() {
		foo("not-a-uuid");
	}
}
`;
		const doc = docFrom(code);
		const { analysis } = runPipeline(doc, defs);
		const wrongTypeMessages = analysis.diagnostics
			.filter(d => d.code === 'LSL011')
			.map(d => d.message)
			.join('\n');
		expect(wrongTypeMessages).toMatch(/expects key.*got string/);
	});
});
