import { describe, it, expect } from 'vitest';
import { docFrom, runPipeline } from './testUtils';
import { loadTestDefs } from './loadDefs.testutil';
import { LSL_DIAGCODES } from '../src/parser';
import { DiagnosticSeverity } from '../src/protocol';

describe('return diagnostics', () => {
	it('reports missing return in non-void', async () => {
		const defs = await loadTestDefs();
		const doc = docFrom('integer foo(){ integer x = 1; } default{ state_entry(){} }');
		const { analysis } = runPipeline(doc, defs);
		const d = analysis.diagnostics.find(di => di.code === LSL_DIAGCODES.MISSING_RETURN);
		expect(d).toBeTruthy();
	});

	it('reports wrong return type', async () => {
		const defs = await loadTestDefs();
		const doc = docFrom('string foo(){ return 123; } default{ state_entry(){} }');
		const { analysis } = runPipeline(doc, defs);
		const d = analysis.diagnostics.find(di => di.code === LSL_DIAGCODES.RETURN_WRONG_TYPE);
		expect(d).toBeTruthy();
	});

	it('reports wrong return type when returning float from integer function', async () => {
		const defs = await loadTestDefs();
		const doc = docFrom('integer foo(){ return 1.5; } default{ state_entry(){} }');
		const { analysis } = runPipeline(doc, defs);
		const d = analysis.diagnostics.find(di => di.code === LSL_DIAGCODES.RETURN_WRONG_TYPE);
		expect(d).toBeTruthy();
	});

	it('accepts returning integer from float function', async () => {
		const defs = await loadTestDefs();
		const doc = docFrom('float foo(){ return 1; } default{ state_entry(){} }');
		const { analysis } = runPipeline(doc, defs);
		const d = analysis.diagnostics.find(di => di.code === LSL_DIAGCODES.RETURN_WRONG_TYPE);
		expect(d).toBeFalsy();
	});

	it('accepts returning string/key across key-string-compatible functions', async () => {
		const defs = await loadTestDefs();
		const doc = docFrom('key k(){ return "00000000-0000-0000-0000-000000000000"; } string s(){ key id = "00000000-0000-0000-0000-000000000000"; return id; } default{ state_entry(){} }');
		const { analysis } = runPipeline(doc, defs);
		const wrongReturns = analysis.diagnostics.filter(di => di.code === LSL_DIAGCODES.RETURN_WRONG_TYPE);
		expect(wrongReturns.length).toBe(0);
	});

	it('errors when returning value in void function', async () => {
		const defs = await loadTestDefs();
		const doc = docFrom('foo(){ return 1; } default{ state_entry(){} }');
		const { analysis } = runPipeline(doc, defs);
		const d = analysis.diagnostics.find(di => di.code === LSL_DIAGCODES.RETURN_IN_VOID);
		expect(d).toBeTruthy();
		expect(d?.severity).toBe(DiagnosticSeverity.Error);
	});

	it('errors when returning value in event handler', async () => {
		const defs = await loadTestDefs();
		const doc = docFrom('default{ state_entry(){ return 1; } }');
		const { analysis } = runPipeline(doc, defs);
		const d = analysis.diagnostics.find(di => di.code === LSL_DIAGCODES.RETURN_IN_VOID);
		expect(d).toBeTruthy();
		expect(d?.severity).toBe(DiagnosticSeverity.Error);
	});

	it('accepts correct return type', async () => {
		const defs = await loadTestDefs();
		const doc = docFrom('vector foo(){ return <1.0,2.0,3.0>; } default{ state_entry(){} }');
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
		const doc = docFrom('integer foo(){ if (TRUE) { return 1; } else { return 2; } } default{ state_entry(){} }');
		const { analysis } = runPipeline(doc, defs);
		const hasMissing = analysis.diagnostics.some(di => di.code === LSL_DIAGCODES.MISSING_RETURN);
		expect(hasMissing).toBe(false);
	});

	it('flags missing return when only one branch returns', async () => {
		const defs = await loadTestDefs();
		const doc = docFrom('integer foo(){ if (TRUE) { return 1; } else { integer x = 0; } } default{ state_entry(){} }');
		const { analysis } = runPipeline(doc, defs);
		const hasMissing = analysis.diagnostics.some(di => di.code === LSL_DIAGCODES.MISSING_RETURN);
		expect(hasMissing).toBe(true);
	});

	it('flags missing return when only a while body returns', async () => {
		const defs = await loadTestDefs();
		const doc = docFrom('integer foo(){ while (FALSE) { return 1; } } default{ state_entry(){} }');
		const { analysis } = runPipeline(doc, defs);
		const hasMissing = analysis.diagnostics.some(di => di.code === LSL_DIAGCODES.MISSING_RETURN);
		expect(hasMissing).toBe(true);
	});

	it('flags missing return when only a for body returns', async () => {
		const defs = await loadTestDefs();
		const doc = docFrom('integer foo(){ integer i; for (i = 0; i < 0; ++i) { return 1; } } default{ state_entry(){} }');
		const { analysis } = runPipeline(doc, defs);
		const hasMissing = analysis.diagnostics.some(di => di.code === LSL_DIAGCODES.MISSING_RETURN);
		expect(hasMissing).toBe(true);
	});

	it('flags missing return when only a do-while body returns', async () => {
		const defs = await loadTestDefs();
		const doc = docFrom('integer foo(){ do { return 1; } while (FALSE); } default{ state_entry(){} }');
		const { analysis } = runPipeline(doc, defs);
		const hasMissing = analysis.diagnostics.some(di => di.code === LSL_DIAGCODES.MISSING_RETURN);
		expect(hasMissing).toBe(true);
	});
});
