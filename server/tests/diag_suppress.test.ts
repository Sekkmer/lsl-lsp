import { describe, it, expect } from 'vitest';
import { docFrom, runPipeline } from './testUtils';
import { loadTestDefs } from './loadDefs.testutil';

async function analyze(code: string) {
	const defs = await loadTestDefs();
	const doc = docFrom(code);
	const { pre, tokens, analysis } = runPipeline(doc, defs, { macros: {}, includePaths: [] });
	return { doc, pre, tokens, analysis };
}

describe('diagnostic suppression directives', () => {
	it('disables on the same line with lsl-disable-line', async () => {
		const code = `integer f(){
		return x; // lsl-disable-line LSL001
	}`;
		const { analysis } = await analyze(code);
		expect(analysis.diagnostics.find(d => d.code === 'LSL001')).toBeFalsy();
	});

	it('disables on the next line with lsl-disable-next-line', async () => {
		const code = `integer f(){
		// lsl-disable-next-line LSL001
		return x;
	}`;
		const { analysis } = await analyze(code);
		expect(analysis.diagnostics.find(d => d.code === 'LSL001')).toBeFalsy();
	});

	it('disables all until lsl-enable (no codes)', async () => {
		const code = `integer f(){
		// lsl-disable
		return x; // unknown id
		// lsl-enable
		return y; // unknown id, should warn again
	}`;
		const { analysis } = await analyze(code);
		const diagY = analysis.diagnostics.find(d => d.code === 'LSL001');
		expect(diagY).toBeTruthy();
		// Should only have the second unknown identifier (y)
		const unknowns = analysis.diagnostics.filter(d => d.code === 'LSL001');
		expect(unknowns.length).toBe(1);
	});

	it('disables multiple specific codes in block', async () => {
		const code = `integer f(integer a){
		// lsl-disable LSL102, LSL101
		integer x; // unused local suppressed
		return 0; // unused param suppressed
		// lsl-enable
	}`;
		const { analysis } = await analyze(code);
		expect(analysis.diagnostics.find(d => d.code === 'LSL101')).toBeFalsy();
		expect(analysis.diagnostics.find(d => d.code === 'LSL102')).toBeFalsy();
	});
});
