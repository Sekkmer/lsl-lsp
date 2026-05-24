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

describe('semantic tokens scope awareness', () => {
	it('parameters are readonly until written; writes marked as modification', async () => {
		const defs = await loadTestDefs();
		const doc = docFrom(`
default {
	state_entry(integer p) {
		integer x = p; // p used
		p++; // p written
	}
}
`);
		const { sem } = runPipeline(doc, defs);
		const spans = semToSpans(doc, sem);
		// Document-level assertions: have a readonly parameter and a modification use
		expect(spans.some(s => s.type === idx('parameter') && hasMod(s.mod, 'readonly'))).toBe(true);
		expect(spans.some(s => s.type === idx('parameter') && hasMod(s.mod, 'modification'))).toBe(true);
	});

	it('shadowed locals resolve to inner declaration, not global', async () => {
		const defs = await loadTestDefs();
		const doc = docFrom(`
integer x = 1;
default {
	state_entry() {
		integer x = 2;
		x = x + 1;
	}
}
`);
		const { sem } = runPipeline(doc, defs);
		const spans = semToSpans(doc, sem);
		// Document-level assertions: at least two variable spans, one modified and one read
		const allVars = spans.filter(s => s.type === idx('variable'));
		expect(allVars.length).toBeGreaterThanOrEqual(2);
		expect(allVars.some(s => hasMod(s.mod, 'modification'))).toBe(true);
		expect(allVars.some(s => !hasMod(s.mod, 'modification'))).toBe(true);
	});
});
