import { describe, it, expect } from 'vitest';
import { docFrom, runPipeline } from './testUtils';
import { loadDefs } from '../src/defs';
import path from 'node:path';

const defsPath = path.join(__dirname, '..', '..', 'third_party', 'lsl-definitions', 'lsl_definitions.yaml');

describe('for-loop header identifier usage', () => {
	it('does not flag local used only in for-header in function', async () => {
		const defs = await loadDefs(defsPath);
		const code = `
integer SumTo(integer n) {
	integer i; integer s = 0;
	for (i = 0; i < n; ++i) { s += i; }
	return s;
}
`;
		const doc = docFrom(code, 'file:///for_func.lsl');
		const { analysis } = runPipeline(doc, defs, { macros: {}, includePaths: [] });
		const msgs = analysis.diagnostics.map(d => d.message);
		expect(msgs.some(m => m.includes('Unused local variable'))).toBe(false);
	});

	it('does not flag local used only in for-header in event', async () => {
		const defs = await loadDefs(defsPath);
		const code = `
default {
	state_entry() {
	integer i; integer s = 0;
	for (i = 0; i < 10; ++i) { s += i; }
	llOwnerSay((string)s);
	}
}
`;
		const doc = docFrom(code, 'file:///for_event.lsl');
		const { analysis } = runPipeline(doc, defs, { macros: {}, includePaths: [] });
		const msgs = analysis.diagnostics.map(d => d.message);
		expect(msgs.some(m => m.includes('Unused local variable'))).toBe(false);
	});
});
