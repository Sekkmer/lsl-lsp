import { describe, it, expect } from 'vitest';
import { docFrom, runPipeline } from './testUtils';
import { loadTestDefs } from './loadDefs.testutil';
import { LSL_DIAGCODES } from '../src/parser';

describe('parser/analyzer', () => {
	it('finds states, events, functions, variables', async () => {
		const defs = await loadTestDefs();
		const doc = docFrom(`
default {
	state_entry() {
	integer g = 1;
	llSay(0, "ok");
	}
}

key f() {
	return llGetOwner();
}
`);
		const { analysis } = runPipeline(doc, defs);
		const names = analysis.decls.map(d => d.name);
		expect(names).toContain('default');	 // state
		expect(names).toContain('g');		 // local var
		expect(names).toContain('f');		 // function
		expect(analysis.calls.some(c => c.name === 'llSay' && c.args === 2)).toBe(true);
	});

	it('reports event outside state', async () => {
		const defs = await loadTestDefs();
		const doc = docFrom('touch_start(integer n) { }');
		const { analysis } = runPipeline(doc, defs);
		expect(analysis.diagnostics.some(d => d.code === LSL_DIAGCODES.EVENT_OUTSIDE_STATE)).toBe(true);
	});

	it('reports wrong arity', async () => {
		const defs = await loadTestDefs();
		const doc = docFrom('default{state_entry(){ llSay(0); }}');
		const { analysis } = runPipeline(doc, defs);
		const wrong = analysis.diagnostics.find(d => d.code === LSL_DIAGCODES.WRONG_ARITY);
		expect(wrong).toBeTruthy();
	});

	it('reports unknown identifier', async () => {
		const defs = await loadTestDefs();
		const doc = docFrom('default{state_entry(){ fooBar(1,2,3); }} ');
		const { analysis } = runPipeline(doc, defs);
		expect(analysis.diagnostics.some(d => d.code === LSL_DIAGCODES.UNKNOWN_IDENTIFIER)).toBe(true);
	});

	it('marks unused globals', async () => {
		const defs = await loadTestDefs();
		const doc = docFrom('integer X; default{state_entry(){}}');
		const { analysis } = runPipeline(doc, defs);
		expect(analysis.diagnostics.some(d => d.code === LSL_DIAGCODES.UNUSED_VAR)).toBe(true);
	});
});

describe('parser', () => {
	it('forbids using reserved identifier "event" as variable name', async () => {
		const defs = await loadTestDefs();
		const doc = docFrom('integer event = 0;');
		const { analysis } = runPipeline(doc, defs);
		const msg = analysis.diagnostics.map(d => d.message).join('\n');
		expect(msg).toMatch(/reserved/);
	});

	it('forbids using reserved identifier "event" as function name', async () => {
		const defs = await loadTestDefs();
		const doc = docFrom('integer event() { return 0; }');
		const { analysis } = runPipeline(doc, defs);
		const msg = analysis.diagnostics.map(d => d.message).join('\n');
		expect(msg).toMatch(/reserved/);
	});

	it('forbids using reserved identifier "event" as parameter name', async () => {
		const defs = await loadTestDefs();
		const doc = docFrom('integer ok(integer event) { return event; }');
		const { analysis } = runPipeline(doc, defs);
		const msg = analysis.diagnostics.map(d => d.message).join('\n');
		expect(msg).toMatch(/reserved/);
	});

	it('forbids using keyword as variable name', async () => {
		const defs = await loadTestDefs();
		const doc = docFrom('integer state = 0;');
		const { analysis } = runPipeline(doc, defs);
		const msg = analysis.diagnostics.map(d => d.message).join('\n');
		expect(msg).toMatch(/reserved/);
	});

	it('forbids using keyword as function name', async () => {
		const defs = await loadTestDefs();
		const doc = docFrom('integer if() { return 0; }');
		const { analysis } = runPipeline(doc, defs);
		const msg = analysis.diagnostics.map(d => d.message).join('\n');
		expect(msg).toMatch(/reserved/);
	});

	it('forbids using type as parameter name', async () => {
		const defs = await loadTestDefs();
		const doc = docFrom('integer ok(integer integer) { return 0; }');
		const { analysis } = runPipeline(doc, defs);
		const msg = analysis.diagnostics.map(d => d.message).join('\n');
		expect(msg).toMatch(/reserved/);
	});
});
