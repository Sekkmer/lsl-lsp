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
});
