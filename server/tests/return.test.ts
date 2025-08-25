import { describe, it, expect } from 'vitest';
import { docFrom, runPipeline } from './testUtils';
import { loadTestDefs } from './loadDefs.testutil';
import { LSL_DIAGCODES } from '../src/parser';

describe('return diagnostics', () => {
	it('reports missing return in non-void', async () => {
		const defs = await loadTestDefs();
		const doc = docFrom(`integer foo(){ integer x = 1; } default{ state_entry(){} }`);
		const { analysis } = runPipeline(doc, defs);
		const d = analysis.diagnostics.find(di => di.code === LSL_DIAGCODES.MISSING_RETURN);
		expect(d).toBeTruthy();
	});

	it('reports wrong return type', async () => {
		const defs = await loadTestDefs();
		const doc = docFrom(`string foo(){ return 123; } default{ state_entry(){} }`);
		const { analysis } = runPipeline(doc, defs);
		const d = analysis.diagnostics.find(di => di.code === LSL_DIAGCODES.RETURN_WRONG_TYPE);
		expect(d).toBeTruthy();
	});

	it('warns when returning value in void function', async () => {
		const defs = await loadTestDefs();
		const doc = docFrom(`foo(){ return 1; } default{ state_entry(){} }`);
		const { analysis } = runPipeline(doc, defs);
		const d = analysis.diagnostics.find(di => di.code === LSL_DIAGCODES.RETURN_IN_VOID);
		expect(d).toBeTruthy();
	});

	it('accepts correct return type', async () => {
		const defs = await loadTestDefs();
		const doc = docFrom(`vector foo(){ return <1.0,2.0,3.0>; } default{ state_entry(){} }`);
		const { analysis } = runPipeline(doc, defs);
		const hasReturnProblems = analysis.diagnostics.some(di => (
			di.code === LSL_DIAGCODES.MISSING_RETURN ||
      di.code === LSL_DIAGCODES.RETURN_WRONG_TYPE ||
      di.code === LSL_DIAGCODES.RETURN_IN_VOID
		));
		expect(hasReturnProblems).toBe(false);
	});

	it('accepts if/else where both branches return', async () => {
		const defs = await loadTestDefs();
		const doc = docFrom(`integer foo(){ if (TRUE) { return 1; } else { return 2; } } default{ state_entry(){} }`);
		const { analysis } = runPipeline(doc, defs);
		const hasMissing = analysis.diagnostics.some(di => di.code === LSL_DIAGCODES.MISSING_RETURN);
		expect(hasMissing).toBe(false);
	});

	it('flags missing return when only one branch returns', async () => {
		const defs = await loadTestDefs();
		const doc = docFrom(`integer foo(){ if (TRUE) { return 1; } else { integer x = 0; } } default{ state_entry(){} }`);
		const { analysis } = runPipeline(doc, defs);
		const hasMissing = analysis.diagnostics.some(di => di.code === LSL_DIAGCODES.MISSING_RETURN);
		expect(hasMissing).toBe(true);
	});
});
