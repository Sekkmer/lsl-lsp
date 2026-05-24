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

	it('does not treat loop-body variables as first-iteration constants', async () => {
		const defs = await loadTestDefs();
		const code = `
			Process(integer count) {
				integer out = 0;
				integer flag = FALSE;
				integer i;
				for (i = 0; i < count; ++i) {
					if (i & 1) {
						out = 1;
					}
					if (!flag) {
						out = 1;
					}
					if (out != 0) {
						flag = !flag;
					}
				}
			}
		`;
		const doc = docFrom(code, 'file:///const-loop-body-first-iteration.lsl');
		const { analysis } = runPipeline(doc, defs);
		const conditionDiagnostics = analysis.diagnostics.filter(d =>
			d.code === LSL_DIAGCODES.ALWAYS_TRUE_CONDITION ||
			d.code === LSL_DIAGCODES.ALWAYS_FALSE_CONDITION,
		);
		expect(conditionDiagnostics).toHaveLength(0);
	});

	it('does not fold while conditions before loop body mutations are considered', async () => {
		const defs = await loadTestDefs();
		const code = `
			default {
				state_entry() {
					list defaults = ["a", "b"];
					integer limit = llGetListLength(defaults);
					integer i;
					while (i < limit) {
						i = i + 1;
					}
				}
			}
		`;
		const doc = docFrom(code, 'file:///const-while-body-mutation.lsl');
		const { analysis } = runPipeline(doc, defs);
		const conditionDiagnostics = analysis.diagnostics.filter(d =>
			d.code === LSL_DIAGCODES.ALWAYS_TRUE_CONDITION ||
			d.code === LSL_DIAGCODES.ALWAYS_FALSE_CONDITION,
		);
		expect(conditionDiagnostics).toHaveLength(0);
	});

	it('does not treat variables assigned in loop conditions as constants inside the loop body', async () => {
		const defs = await loadTestDefs();
		const code = `
			default {
				state_entry() {
					integer found;
					while (~(found = llListFindList(["a", "b"], [llGetSubString("abc", 0, 0)]))) {
						if (found == 0) { }
						else if (found == 1) { }
					}
				}
			}
		`;
		const doc = docFrom(code, 'file:///const-loop-condition-assignment.lsl');
		const { analysis } = runPipeline(doc, defs);
		const conditionDiagnostics = analysis.diagnostics.filter(d =>
			d.code === LSL_DIAGCODES.ALWAYS_TRUE_CONDITION ||
			d.code === LSL_DIAGCODES.ALWAYS_FALSE_CONDITION,
		);
		expect(conditionDiagnostics).toHaveLength(0);
	});

	it('treats member assignments as mutations of the containing value', async () => {
		const defs = await loadTestDefs();
		const code = `
			default {
				state_entry() {
					vector gravity = <0, 0, -1>;
					gravity.z -= 0.1;
					if (gravity.z < -3.0) { }
				}
			}
		`;
		const doc = docFrom(code, 'file:///const-member-assignment-mutation.lsl');
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

	it('does not treat globals mutated by callable code as entry constants', async () => {
		const defs = await loadTestDefs();
		const code = `
			integer mutableMode = 0;
			integer stableMode = 0;

			CheckModes() {
				if (mutableMode == 0) { }
				if (stableMode == 0) { }
			}

			default {
				state_entry() {
					mutableMode = 1;
					CheckModes();
				}
			}
		`;
		const doc = docFrom(code, 'file:///const-mutated-global-entry.lsl');
		const { analysis } = runPipeline(doc, defs);
		const conditionLines = analysis.diagnostics
			.filter(d =>
				d.code === LSL_DIAGCODES.ALWAYS_TRUE_CONDITION ||
				d.code === LSL_DIAGCODES.ALWAYS_FALSE_CONDITION,
			)
			.map(d => d.range.start.line);
		expect(conditionLines).toEqual([6]);
	});

	it('does not leak global assignments from one callable into another callable', async () => {
		const defs = await loadTestDefs();
		const code = `
			integer mutableMode = 0;

			SetMode() {
				mutableMode = 1;
			}

			CheckMode() {
				if (mutableMode == 1) { }
			}

			default {
				state_entry() {
					SetMode();
					CheckMode();
				}
			}
		`;
		const doc = docFrom(code, 'file:///const-callable-global-leak.lsl');
		const { analysis } = runPipeline(doc, defs);
		const conditionDiagnostics = analysis.diagnostics.filter(d =>
			d.code === LSL_DIAGCODES.ALWAYS_TRUE_CONDITION ||
			d.code === LSL_DIAGCODES.ALWAYS_FALSE_CONDITION,
		);
		expect(conditionDiagnostics).toHaveLength(0);
	});
});
