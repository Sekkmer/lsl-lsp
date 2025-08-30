import { describe, it, expect } from 'vitest';
import { docFrom, runPipeline, tokensToDebug } from './testUtils';
import { loadTestDefs } from './loadDefs.testutil';

describe('lexer', () => {
	it('tokenizes strings, numbers, ids, ops', async () => {
		const defs = await loadTestDefs();
		const doc = docFrom(`integer x = 42; llSay(0, "hi"); // end`);
		const { tokens } = runPipeline(doc, defs);
		const dbg = tokensToDebug(tokens);
		expect(dbg.some(t => t.k === 'id' && t.v === 'integer')).toBe(true);
		expect(dbg.some(t => t.k === 'num' && t.v === '42')).toBe(true);
		expect(dbg.some(t => t.k === 'str' && t.v.includes('"hi"'))).toBe(true);
		expect(dbg.some(t => t.k === 'comment')).toBe(true);
	});

	it('scans hex integer literals including 0x000', async () => {
		const defs = await loadTestDefs();
		const doc = docFrom(`integer a = 0x0; integer b = 0x000; integer c = 0x1f; integer d = 0XDEAD;`);
		const { tokens } = runPipeline(doc, defs);
		const dbg = tokensToDebug(tokens).filter(t => t.k === 'num').map(t => t.v);
		expect(dbg).toContain('0x0');
		expect(dbg).toContain('0x000');
		expect(dbg).toContain('0x1f');
		expect(dbg).toContain('0XDEAD');
	});
});
