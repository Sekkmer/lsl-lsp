import { describe, it, expect } from 'vitest';
import { docFrom, runPipeline, semToSpans } from './testUtils';
import { loadTestDefs } from './loadDefs.testutil';
import { semanticTokensLegend } from '../src/semtok';

function idx(name: string) {
	return (semanticTokensLegend.tokenTypes as string[]).indexOf(name);
}
function hasMod(mods: number, name: string) {
	const bit = 1 << (semanticTokensLegend.tokenModifiers as string[]).indexOf(name);
	return (mods & bit) !== 0;
}

describe('readonly for locals used only in equality checks', () => {
	it('local initialized once and only compared stays readonly', async () => {
		const defs = await loadTestDefs();
		const code = `
integer SaveData() {
	integer result = 0;
	if (result == 1 || result == 2) {
	return 1;
	}
	return result;
}
`;
		const doc = docFrom(code, 'file:///readonly_equality_only.lsl');
		const { sem } = runPipeline(doc, defs);
		const spans = semToSpans(doc, sem);
		const varSpans = spans.filter(s => s.type === idx('variable'));
		expect(varSpans.length).toBeGreaterThanOrEqual(3); // decl + 2 comparisons + return use
		// All occurrences of the variable should be readonly (no writes after initializer)
		expect(varSpans.every(s => hasMod(s.mod, 'readonly'))).toBe(true);
	});
});
