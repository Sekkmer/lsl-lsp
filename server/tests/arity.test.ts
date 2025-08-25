import { describe, it, expect } from 'vitest';
import { docFrom, runPipeline } from './testUtils';
import { loadTestDefs } from './loadDefs.testutil';

describe('arity counting', () => {
	it('counts nested call expression as one arg', async () => {
		const defs = await loadTestDefs();
		const code = `default { state_entry() { if (llAbs(llList2Integer(parts, -2) - llGetUnixTime()) > 30) { llOwnerSay("x"); } } }`;
		const doc = docFrom(code);
		const { analysis } = runPipeline(doc, defs);
		// ensure we saw llAbs call with one arg
		const absCall = analysis.calls.find(c => c.name === 'llAbs');
		expect(absCall).toBeTruthy();
		expect(absCall!.args).toBe(1);
		// no wrong arity diagnostic for llAbs
		expect(analysis.diagnostics.find(d => d.message.includes('llAbs') && d.code === 'LSL010')).toBeFalsy();
	});

	it('reports WRONG_TYPE for builtin mismatch', async () => {
		const defs = await loadTestDefs();
		// llSay(integer, string) -> pass integer for string
		const code = `default { state_entry() { llSay(0, 1); } }`;
		const doc = docFrom(code);
		const { analysis } = runPipeline(doc, defs);
		const wrong = analysis.diagnostics.find(d => d.code === 'LSL011');
		expect(wrong).toBeTruthy();
	});

	it('reports WRONG_TYPE for user-defined mismatch', async () => {
		const defs = await loadTestDefs();
		const code = `integer foo(string s){ return 0; } default { state_entry() { foo(123); } }`;
		const doc = docFrom(code);
		const { analysis } = runPipeline(doc, defs);
		const wrong = analysis.diagnostics.find(d => d.code === 'LSL011');
		expect(wrong).toBeTruthy();
	});
});
