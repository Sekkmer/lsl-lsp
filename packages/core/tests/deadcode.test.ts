import { describe, it, expect } from 'vitest';
import { docFrom, runPipeline } from './testUtils';
import { loadTestDefs } from './loadDefs.testutil';
import { LSL_DIAGCODES } from '../src/parser';

describe('dead code diagnostics', () => {
	it('flags code after return on same line', async () => {
		const defs = await loadTestDefs();
		const doc = docFrom('integer f(){ return 0; integer x = 1; }');
		const { analysis } = runPipeline(doc, defs);
		const dead = analysis.diagnostics.find(d => d.code === LSL_DIAGCODES.DEAD_CODE);
		expect(dead).toBeTruthy();
	});

	it('flags code after state on same line', async () => {
		const defs = await loadTestDefs();
		const doc = docFrom('default{state_entry(){ state ready; integer x = 1; }} state ready { state_entry(){} }');
		const { analysis } = runPipeline(doc, defs);
		const dead = analysis.diagnostics.find(d => d.code === LSL_DIAGCODES.DEAD_CODE);
		expect(dead).toBeTruthy();
	});

	it('flags code after jump on same line', async () => {
		const defs = await loadTestDefs();
		const doc = docFrom('default{state_entry(){ jump L; integer x = 1; @L; }}');
		const { analysis } = runPipeline(doc, defs);
		const dead = analysis.diagnostics.find(d => d.code === LSL_DIAGCODES.DEAD_CODE);
		expect(dead).toBeTruthy();
	});

	it('does not flag code on next line', async () => {
		const defs = await loadTestDefs();
		const doc = docFrom('integer f(){ return 0;\ninteger x = 1; }');
		const { analysis } = runPipeline(doc, defs);
		const dead = analysis.diagnostics.find(d => d.code === LSL_DIAGCODES.DEAD_CODE);
		expect(dead).toBeFalsy();
	});
});
