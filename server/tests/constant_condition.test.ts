import { describe, it, expect } from 'vitest';
import { LSL_DIAGCODES } from '../src/analysisTypes';
import { docFrom, runPipeline } from './testUtils';
import { loadTestDefs } from './loadDefs.testutil';

describe('constant condition diagnostics', () => {
	it('warns when an if-condition is always true', async () => {
		const defs = await loadTestDefs();
		const code = `
			default {
				state_entry() {
					if (1) { }
				}
			}
		`;
		const doc = docFrom(code, 'file:///const-if-true.lsl');
		const { analysis } = runPipeline(doc, defs);
		const codes = analysis.diagnostics.map(d => d.code);
		expect(codes).toContain(LSL_DIAGCODES.ALWAYS_TRUE_CONDITION);
	});

	it('warns when a loop condition is always false', async () => {
		const defs = await loadTestDefs();
		const code = `
			default {
				state_entry() {
					while (0) { }
				}
			}
		`;
		const doc = docFrom(code, 'file:///const-while-false.lsl');
		const { analysis } = runPipeline(doc, defs);
		const codes = analysis.diagnostics.map(d => d.code);
		expect(codes).toContain(LSL_DIAGCODES.ALWAYS_FALSE_CONDITION);
	});

	it('does not warn when condition depends on runtime values', async () => {
		const defs = await loadTestDefs();
		const code = `
			default {
				state_entry() {
					integer x = (integer)llGetTime();
					if (x) { }
				}
			}
		`;
		const doc = docFrom(code, 'file:///const-runtime.lsl');
		const { analysis } = runPipeline(doc, defs);
		const codes = analysis.diagnostics.map(d => d.code);
		expect(codes).not.toContain(LSL_DIAGCODES.ALWAYS_TRUE_CONDITION);
		expect(codes).not.toContain(LSL_DIAGCODES.ALWAYS_FALSE_CONDITION);
	});
});
