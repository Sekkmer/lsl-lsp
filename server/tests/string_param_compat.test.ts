import { describe, it, expect } from 'vitest';
import { docFrom } from './testUtils';
import { loadDefs } from '../src/defs';
import path from 'node:path';
import { runPipeline } from './testUtils';

const defsPath = path.join(__dirname, '..', '..', 'common', 'lsl-defs.json');

describe('string parameter implicit conversions', () => {
	it('accepts integer/float/key where string is expected', async () => {
		const defs = await loadDefs(defsPath);
		const code = `default { state_entry() {
			integer i = 5; float f = 1.5; key k = (key)"00000000-0000-0000-0000-000000000000";
			llSay(0, i); llSay(0, f); llSay(0, k);
		} }`;
		const doc = docFrom(code, 'file:///string_param_compat.lsl');
		const { analysis } = runPipeline(doc, defs, { macros: {}, includePaths: [] });
		const wrong = analysis.diagnostics.filter(d => d.code === 'LSL011');
		expect(wrong.length).toBe(0);
	});
});
