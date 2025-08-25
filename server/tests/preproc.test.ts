import { describe, it, expect } from 'vitest';
import { docFrom, runPipeline } from './testUtils';
import { loadTestDefs } from './loadDefs.testutil';

describe('preprocessor', () => {
	it('#ifdef masks code when macro missing', async () => {
		const defs = await loadTestDefs();
		const doc = docFrom(`
default
{
	state_entry()
	{
		#ifdef DEBUG
		llSay(0, "debug");
		#endif
		llSay(0, "live");
	}
}
`);
		const { pre, tokens } = runPipeline(doc, defs, { macros: {} });
		// Ensure the debug llSay is skipped by lexer (masked range)
		const hasDebug = tokens.some(t => t.kind === 'str' && t.value.includes('debug'));
		const hasLive = tokens.some(t => t.kind === 'str' && t.value.includes('live'));
		expect(hasDebug).toBe(false);
		expect(hasLive).toBe(true);
		expect(pre.disabledRanges.length).toBeGreaterThan(0);
	});

	it('#include search path works', async () => {
		const defs = await loadTestDefs();
		const doc = docFrom(`#include "inc.lsl"\nllSay(0,"hi");`, 'file:///proj/main.lsl');
		const { pre } = runPipeline(doc, defs, { includePaths: [__dirname + '/fixtures/includes'] });
		expect(pre.includes[0].endsWith('inc.lsl')).toBe(true);
	});
});
