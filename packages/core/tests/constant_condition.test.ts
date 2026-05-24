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

	it('folds deterministic built-in calls in conditions', async () => {
		const defs = await loadTestDefs();
		const code = `
			default {
				state_entry() {
					if (llGetSubString("abcd", 1, 2) == "bc") { }
				}
			}
		`;
		const doc = docFrom(code, 'file:///const-builtin-call.lsl');
		const { analysis } = runPipeline(doc, defs);
		const codes = analysis.diagnostics.map(d => d.code);
		expect(codes).toContain(LSL_DIAGCODES.ALWAYS_TRUE_CONDITION);
	});

	it('propagates deterministic built-in call folds through local variables', async () => {
		const defs = await loadTestDefs();
		const code = `
			default {
				state_entry() {
					string s = llGetSubString("abcd", 1, 2);
					if (s == "bc") { }
				}
			}
		`;
		const doc = docFrom(code, 'file:///const-builtin-local.lsl');
		const { analysis } = runPipeline(doc, defs);
		const codes = analysis.diagnostics.map(d => d.code);
		expect(codes).toContain(LSL_DIAGCODES.ALWAYS_TRUE_CONDITION);
	});

	it('does not fold unknown runtime-returning built-ins as constants', async () => {
		const defs = await loadTestDefs();
		const code = `
			default {
				state_entry() {
					key owner = llGetOwner();
					if (owner == NULL_KEY) { }
				}
			}
		`;
		const doc = docFrom(code, 'file:///const-runtime-key.lsl');
		const { analysis } = runPipeline(doc, defs);
		const codes = analysis.diagnostics.map(d => d.code);
		expect(codes).not.toContain(LSL_DIAGCODES.ALWAYS_TRUE_CONDITION);
		expect(codes).not.toContain(LSL_DIAGCODES.ALWAYS_FALSE_CONDITION);
	});

	it('does not leak uncertain branch or loop assignments into later conditions', async () => {
		const defs = await loadTestDefs();
		const code = `
			default {
				state_entry() {
					integer branchValue = 0;
					if (llGetTime())
						branchValue = 1;
					if (branchValue) { }

					integer loopValue = 0;
					while (llGetTime())
						loopValue = 1;
					if (loopValue) { }

					integer updateValue = 0;
					for (; llGetTime(); updateValue = 1) { }
					if (updateValue) { }
				}
			}
		`;
		const doc = docFrom(code, 'file:///const-control-flow-leak.lsl');
		const { analysis } = runPipeline(doc, defs);
		const conditionDiagnostics = analysis.diagnostics.filter(d =>
			d.code === LSL_DIAGCODES.ALWAYS_TRUE_CONDITION ||
			d.code === LSL_DIAGCODES.ALWAYS_FALSE_CONDITION,
		);
		expect(conditionDiagnostics).toHaveLength(0);
	});

	it('folds assignment-valued if conditions and keeps LSL non-short-circuit logic side effects', async () => {
		const defs = await loadTestDefs();
		const code = `
			default {
				state_entry() {
					integer a = 0;
					integer b = 0;
					integer c = 0;
					integer d = 0;
					integer e = 0;
					integer f = 0;
					if (a = 1) { }
					if ((b = 1) == 2) { }
					if ((c = 1) || (d = 1)) { }
					if ((e = 0) && (f = 1)) { }
					if (a == 1) { }
					if (c == 1) { }
					if (d == 1) { }
					if (f == 1) { }
				}
			}
		`;
		const doc = docFrom(code, 'file:///const-assignment-condition.lsl');
		const { analysis } = runPipeline(doc, defs);
		const linesWithCode = (code: string) =>
			analysis.diagnostics
				.filter(d => d.code === code)
				.map(d => d.range.start.line)
				.sort((a, b) => a - b);
		expect(linesWithCode(LSL_DIAGCODES.ALWAYS_TRUE_CONDITION)).toEqual([9, 11, 13, 14, 15, 16]);
		expect(linesWithCode(LSL_DIAGCODES.ALWAYS_FALSE_CONDITION)).toEqual([10, 12]);
	});
});
