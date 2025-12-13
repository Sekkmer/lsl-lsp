import { describe, it, expect } from 'vitest';
import { docFrom, runPipeline } from './testUtils';
import { loadTestDefs } from './loadDefs.testutil';

describe('string relational operator type errors', () => {
	it('flags string < string as WRONG_TYPE', async () => {
		const defs = await loadTestDefs();
		const code = `

default {
	state_entry() {
		if ("a" < "b") {
			// no-op
		}
	}
}
`;
		const doc = docFrom(code, 'file:///string_rel_cmp.lsl');
		const { analysis } = runPipeline(doc, defs);
		const msg = analysis.diagnostics.map(d => d.message).join('\n');
		expect(msg).toMatch(/Operator </);
		expect(msg).toMatch(/expects numeric operands/);
	});
});
