import { describe, it, expect } from 'vitest';
import { docFrom } from './testUtils';
import { loadDefs } from '../src/defs';
import path from 'node:path';
import { runPipeline } from './testUtils';

const defsPath = path.join(__dirname, 'fixtures', 'lsl-defs.yaml');

describe('suspicious assignment in if()', () => {
	it('warns on if (a = 1)', async () => {
		const defs = await loadDefs(defsPath);
		const code = `
integer a;
default { state_entry() {
	if (a = 1) {
		a = 2;
	}
} }
`;
		const doc = docFrom(code, 'file:///assign1.lsl');
		const { analysis } = runPipeline(doc, defs, { macros: {}, includePaths: [] });
		const msgs = analysis.diagnostics.map(d => d.message + ' @' + d.code);
		expect(msgs.some(m => m.includes('Suspicious assignment') && m.includes('LSL051'))).toBe(true);
	});

	it('does not warn on if (a == 1)', async () => {
		const defs = await loadDefs(defsPath);
		const code = `
integer a;
default { state_entry() {
	if (a == 1) {
		a = 2;
	}
} }
`;
		const doc = docFrom(code, 'file:///assign2.lsl');
		const { analysis } = runPipeline(doc, defs, { macros: {}, includePaths: [] });
		const msgs = analysis.diagnostics.map(d => d.code);
		expect(msgs.filter(c => c === 'LSL051').length).toBe(0);
	});
});
