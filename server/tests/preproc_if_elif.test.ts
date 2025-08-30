import { describe, it, expect } from 'vitest';
import { docFrom, runPipeline } from './testUtils';
import { loadTestDefs } from './loadDefs.testutil';

describe('#if / #elif expressions', () => {
	it('#if arithmetic truthiness selects correct branch', async () => {
		const defs = await loadTestDefs();
		const doc = docFrom(`
default
{
	state_entry()
	{
	#if 1 + 2 > 2
	llSay(0, "A");
	#else
	llSay(0, "B");
	#endif
	}
}
`);
		const { tokens, pre } = runPipeline(doc, defs, {});
		const hasA = tokens.some(t => t.kind === 'str' && t.value.includes('A'));
		const hasB = tokens.some(t => t.kind === 'str' && t.value.includes('B'));
		expect(hasA).toBe(true);
		expect(hasB).toBe(false);
		expect(pre.disabledRanges.length).toBeGreaterThan(0);
	});

	it('#elif chain: only first true branch is taken', async () => {
		const defs = await loadTestDefs();
		const doc = docFrom(`
default
{
	state_entry()
	{
	#if 0
	llSay(0, "A");
	#elif 1
	llSay(0, "B");
	#elif 1
	llSay(0, "C");
	#else
	llSay(0, "D");
	#endif
	}
}
`);
		const { tokens } = runPipeline(doc, defs, {});
		const hasA = tokens.some(t => t.kind === 'str' && t.value.includes('A'));
		const hasB = tokens.some(t => t.kind === 'str' && t.value.includes('B'));
		const hasC = tokens.some(t => t.kind === 'str' && t.value.includes('C'));
		const hasD = tokens.some(t => t.kind === 'str' && t.value.includes('D'));
		expect(hasA).toBe(false);
		expect(hasB).toBe(true);
		expect(hasC).toBe(false);
		expect(hasD).toBe(false);
	});

	it('defined(NAME) and negation works', async () => {
		const defs = await loadTestDefs();
		const doc = docFrom(`
default
{
	state_entry()
	{
	#if defined(DEBUG) && !defined(TRACE)
	llSay(0, "ON");
	#else
	llSay(0, "OFF");
	#endif
	}
}
`);
		const { tokens } = runPipeline(doc, defs, { macros: { DEBUG: 1 } });
		const hasON = tokens.some(t => t.kind === 'str' && t.value.includes('ON'));
		const hasOFF = tokens.some(t => t.kind === 'str' && t.value.includes('OFF'));
		expect(hasON).toBe(true);
		expect(hasOFF).toBe(false);
	});

	it('nested #if inside disabled outer remains disabled', async () => {
		const defs = await loadTestDefs();
		const doc = docFrom(`
default
{
	state_entry()
	{
	#if 0
		#if 1
		llSay(0, "IN");
		#endif
	#else
		llSay(0, "OUT");
	#endif
	}
}
`);
		const { tokens } = runPipeline(doc, defs, {});
		const hasIN = tokens.some(t => t.kind === 'str' && t.value.includes('IN'));
		const hasOUT = tokens.some(t => t.kind === 'str' && t.value.includes('OUT'));
		expect(hasIN).toBe(false);
		expect(hasOUT).toBe(true);
	});
});
