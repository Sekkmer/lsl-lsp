import { describe, it, expect } from 'vitest';
import { docFrom, runPipeline } from './testUtils';
import { loadTestDefs } from './loadDefs.testutil';

const UUID = '00000000-0000-0000-0000-000000000000';

describe('string literal UUID to key', () => {
	it('allows UUID-like string literal for key parameter without warning', async () => {
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
		const warning = analysis.diagnostics.find(d => d.code === 'LSL013');
		expect(warning).toBeFalsy();
	});

	it('allows non-UUID string literal for key parameter but still warns', async () => {
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
		const warnings = analysis.diagnostics.filter(d => d.code === 'LSL013');
		expect(warnings.length).toBeGreaterThan(0);
		const wrongType = analysis.diagnostics.find(d => d.code === 'LSL011');
		expect(wrongType).toBeFalsy();
	});
});
