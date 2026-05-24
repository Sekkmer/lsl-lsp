import { describe, it, expect } from 'vitest';
import { docFrom, runPipeline } from './testUtils';
import { loadTestDefs } from './loadDefs.testutil';
import { DiagnosticSeverity } from '../src/protocol';

// Empty structure validation tests

describe('empty structures: functions, events, if/else', () => {
	it('allows empty event handler body', async () => {
		const defs = await loadTestDefs();
		const doc = docFrom('default { touch_start(integer n) { } }');
		const { analysis } = runPipeline(doc, defs);
		const e = analysis.diagnostics.find(d => d.code === 'LSL024');
		expect(e).toBeUndefined();
	});

	it('no error on non-empty event handler body', async () => {
		const defs = await loadTestDefs();
		const doc = docFrom('default { touch_start(integer n) { integer a; a = n; } }');
		const { analysis } = runPipeline(doc, defs);
		const e = analysis.diagnostics.find(d => d.code === 'LSL024');
		expect(e).toBeUndefined();
	});

	it('allows empty typed function body', async () => {
		const defs = await loadTestDefs();
		const doc = docFrom('integer foo(){ }');
		const { analysis } = runPipeline(doc, defs);
		const e = analysis.diagnostics.find(d => d.code === 'LSL025');
		expect(e).toBeUndefined();
	});

	it('no error on non-empty typed function body', async () => {
		const defs = await loadTestDefs();
		const doc = docFrom('integer foo(){ return 1; }');
		const { analysis } = runPipeline(doc, defs);
		const e = analysis.diagnostics.find(d => d.code === 'LSL025');
		expect(e).toBeUndefined();
	});

	it('allows empty void function body', async () => {
		const defs = await loadTestDefs();
		const doc = docFrom('foo(){ }');
		const { analysis } = runPipeline(doc, defs);
		const e = analysis.diagnostics.find(d => d.code === 'LSL025');
		expect(e).toBeUndefined();
	});

	it('no error on non-empty void function body', async () => {
		const defs = await loadTestDefs();
		const doc = docFrom('foo(){ return; }');
		const { analysis } = runPipeline(doc, defs);
		const e = analysis.diagnostics.find(d => d.code === 'LSL025');
		expect(e).toBeUndefined();
	});

	it('warns on if with empty statement', async () => {
		const defs = await loadTestDefs();
		const doc = docFrom('default { touch_start(integer n) { integer a; if (a) ; } }');
		const { analysis } = runPipeline(doc, defs);
		const e = analysis.diagnostics.find(d => d.code === 'LSL026');
		expect(e?.severity).toBe(DiagnosticSeverity.Warning);
	});

	it('no error when if branch has non-empty statement', async () => {
		const defs = await loadTestDefs();
		const doc = docFrom('default { touch_start(integer n) { integer a; if (a) { a = 1; } } }');
		const { analysis } = runPipeline(doc, defs);
		const e = analysis.diagnostics.find(d => d.code === 'LSL026');
		expect(e).toBeUndefined();
	});

	it('warns on else with empty statement', async () => {
		const defs = await loadTestDefs();
		const doc = docFrom('default { touch_start(integer n) { if (n) { } else ; } }');
		const { analysis } = runPipeline(doc, defs);
		const e = analysis.diagnostics.find(d => d.code === 'LSL027');
		expect(e?.severity).toBe(DiagnosticSeverity.Warning);
	});

	it('warns on else with empty block', async () => {
		const defs = await loadTestDefs();
		const doc = docFrom('default { touch_start(integer n) { if (n) { integer x; } else { } } }');
		const { analysis } = runPipeline(doc, defs);
		const e = analysis.diagnostics.find(d => d.code === 'LSL027');
		expect(e?.severity).toBe(DiagnosticSeverity.Warning);
	});

	it('no error when else branch has non-empty statement', async () => {
		const defs = await loadTestDefs();
		const doc = docFrom('default { touch_start(integer n) { if (n) { integer x; x = n; } else { integer y; y = 0; } } }');
		const { analysis } = runPipeline(doc, defs);
		const e = analysis.diagnostics.find(d => d.code === 'LSL027');
		expect(e).toBeUndefined();
	});

	it('warns when if-block is empty even with else if following', async () => {
		const defs = await loadTestDefs();
		const doc = docFrom('default { touch_start(integer n) { if (n) { } else if (n) { integer z; z = n; } } }');
		const { analysis } = runPipeline(doc, defs);
		const e = analysis.diagnostics.find(d => d.code === 'LSL026');
		expect(e?.severity).toBe(DiagnosticSeverity.Warning);
	});
});
