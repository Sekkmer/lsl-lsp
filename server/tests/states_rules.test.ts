import { describe, it, expect } from 'vitest';
import { docFrom, runPipeline } from './testUtils';
import { loadTestDefs } from './loadDefs.testutil';

// Tests for state declaration scope and state change usage rules

describe('states: declaration and change rules', () => {
	it('errors when declaring a state inside a function', async () => {
		const defs = await loadTestDefs();
		const doc = docFrom('integer g; integer foo(){ state S { } return 0; }');
		const { analysis } = runPipeline(doc, defs);
		const e = analysis.diagnostics.find(d => d.code === 'LSL022');
		expect(e).toBeTruthy();
	});

	it('errors when declaring default block inside a function', async () => {
		const defs = await loadTestDefs();
		const doc = docFrom('integer foo(){ default { } return 0; }');
		const { analysis } = runPipeline(doc, defs);
		const e = analysis.diagnostics.find(d => d.code === 'LSL022');
		expect(e).toBeTruthy();
	});

	it('allows state declarations at global scope', async () => {
		const defs = await loadTestDefs();
		const doc = docFrom('state S { } default { }');
		const { analysis } = runPipeline(doc, defs);
		const e = analysis.diagnostics.find(d => d.code === 'LSL022');
		expect(e).toBeFalsy();
	});

	it('errors when using state change in function', async () => {
		const defs = await loadTestDefs();
		const doc = docFrom('state A { } integer foo(){ state A; return 0; }');
		const { analysis } = runPipeline(doc, defs);
		const e = analysis.diagnostics.find(d => d.code === 'LSL023');
		expect(e).toBeTruthy();
	});

	it('errors when using state change at global scope', async () => {
		const defs = await loadTestDefs();
		const doc = docFrom('state A { } state A;');
		const { analysis } = runPipeline(doc, defs);
		const e = analysis.diagnostics.find(d => d.code === 'LSL023');
		expect(e).toBeTruthy();
	});

	it('allows state change inside an event handler', async () => {
		const defs = await loadTestDefs();
		const doc = docFrom('state A { touch_start(integer n){ state default; } } default { }');
		const { analysis } = runPipeline(doc, defs);
		const e = analysis.diagnostics.find(d => d.code === 'LSL023');
		expect(e).toBeFalsy();
	});
});
