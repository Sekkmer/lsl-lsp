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
		const doc = docFrom('default { } state S { }');
		const { analysis } = runPipeline(doc, defs);
		const e = analysis.diagnostics.find(d => d.code === 'LSL022');
		expect(e).toBeFalsy();
	});

	it('errors when a non-default state appears before the default state', async () => {
		const defs = await loadTestDefs();
		const doc = docFrom('state S { } default { }');
		const { analysis } = runPipeline(doc, defs);
		const e = analysis.diagnostics.find(d => d.code === 'LSL000' && /default state must be declared before other states/i.test(d.message));
		expect(e).toBeTruthy();
	});

	it('errors when declaring default with the state keyword', async () => {
		const defs = await loadTestDefs();
		const doc = docFrom('state default { }');
		const { analysis } = runPipeline(doc, defs);
		const e = analysis.diagnostics.find(d => d.code === 'LSL000' && /use `default \{`/i.test(d.message));
		expect(e).toBeTruthy();
	});

	it('errors when using state change in function', async () => {
		const defs = await loadTestDefs();
		const doc = docFrom('integer foo(){ state A; return 0; } default { } state A { }');
		const { analysis } = runPipeline(doc, defs);
		const e = analysis.diagnostics.find(d => d.code === 'LSL023');
		expect(e).toBeTruthy();
	});

	it('errors when using state change at global scope', async () => {
		const defs = await loadTestDefs();
		const doc = docFrom('default { } state A { } state A;');
		const { analysis } = runPipeline(doc, defs);
		const e = analysis.diagnostics.find(d => d.code === 'LSL023');
		expect(e).toBeTruthy();
	});

	it('errors on global declarations after state declarations', async () => {
		const defs = await loadTestDefs();
		const doc = docFrom('default { }\ninteger lateGlobal;\ninteger lateFunction() { return 1; }');
		const { analysis } = runPipeline(doc, defs);
		const errors = analysis.diagnostics.filter(d => d.code === 'LSL000' && /Global declarations must appear before state declarations/.test(d.message));
		expect(errors.length).toBeGreaterThanOrEqual(2);
	});

	it('allows state change inside an event handler', async () => {
		const defs = await loadTestDefs();
		const doc = docFrom('default { } state A { touch_start(integer n){ state default; } }');
		const { analysis } = runPipeline(doc, defs);
		const e = analysis.diagnostics.find(d => d.code === 'LSL023');
		expect(e).toBeFalsy();
	});

	it('allows state change inside zero-parameter event handler', async () => {
		const defs = await loadTestDefs();
		const doc = docFrom('default { state_entry(){ } } state inUpdate { state_entry(){ state default; } }');
		const { analysis } = runPipeline(doc, defs);
		const e = analysis.diagnostics.find(d => d.code === 'LSL023');
		expect(e).toBeFalsy();
	});

	it('errors when state change is missing a semicolon', async () => {
		const defs = await loadTestDefs();
		const doc = docFrom('default { state_entry(){ state ready } } state ready { state_entry(){ } }');
		const { analysis } = runPipeline(doc, defs);
		const e = analysis.diagnostics.find(d => d.code === 'LSL000' && /expected ';'/.test(d.message));
		expect(e).toBeTruthy();
	});
});
