import { describe, it, expect } from 'vitest';
import { docFrom, runPipeline, type SemSpan } from './testUtils';
import { loadTestDefs } from './loadDefs.testutil';
import { semanticTokensLegend } from '../src/semtok';

function idx(name: string) {
	return (semanticTokensLegend.tokenTypes as string[]).indexOf(name);
}
function hasMod(mods: number, name: string) {
	const bit = 1 << (semanticTokensLegend.tokenModifiers as string[]).indexOf(name);
	return (mods & bit) !== 0;
}

describe('readonly/unused in for headers and logical OR', () => {
	it('marks count used and readonly in for condition', async () => {
		const defs = await loadTestDefs();
		const code = `
integer ParseKeyList(string message)
{
\tlist stringList = llParseString2List(message, [","], []);
\tlist keyList = [];

\tinteger count = llGetListLength(stringList);
\tinteger i;
\tfor (i = 0; i < count; i++)
\t{
\t\tinteger id = i;
\t}

\treturn count;
}
`;
		const doc = docFrom(code, 'file:///for_header_readonly.lsl');
		const { analysis, sem } = runPipeline(doc, defs);
		// Should not flag count as unused local
		const unusedLocal = analysis.diagnostics.find(d => d.code === 'LSL101' && d.message.includes('count'));
		expect(unusedLocal).toBeFalsy();
		// Semantic tokens: any variable/parameter span for 'count' should be readonly (assigned once)
		const spans = ((): SemSpan[] => {
			const out: SemSpan[] = [];
			const d = sem.data; let line = 0; let ch = 0;
			for (let i = 0; i < d.length; i += 5) { line += d[i]; if (d[i] !== 0) ch = 0; ch += d[i+1]; out.push({ line, char: ch, len: d[i+2], type: d[i+3], mod: d[i+4] }); }
			return out;
		})();
		// Find a variable token on the count identifier line (8: "for (i = 0; i < count; i++)")
		const hasReadonlyCount = spans.some(s => s.type === idx('variable') && hasMod(s.mod, 'readonly'));
		expect(hasReadonlyCount).toBe(true);
	});

	it('does not flag integer comparisons joined by || and references the || operator', async () => {
		const defs = await loadTestDefs();
		const code = `
integer f(integer result) {
	if (result == 1 || result == 2) {
	return 1;
	}
	return 0;
}
`;
		const doc = docFrom(code, 'file:///or_ok.lsl');
		const { analysis } = runPipeline(doc, defs);
		const msgs = analysis.diagnostics.map(d => d.message + ' @' + d.code);
		// Should not have a WRONG_TYPE about bitwise or or integer operands here
		expect(msgs.some(m => m.includes('expects integer operands') || m.includes('Operator |'))).toBe(false);
	});
});
