import { describe, it, expect } from 'vitest';
import { docFrom, runPipeline } from './testUtils';
import { loadTestDefs } from './loadDefs.testutil';

describe('unterminated block comments', () => {
	it('does not crash tokens/sem and yields analysis syntax error', async () => {
		const defs = await loadTestDefs();
		const code = 'integer a = 1;\n/* JSDoc like start\ninteger b = 2;';
		const doc = docFrom(code);
		const { analysis, sem, tokens } = runPipeline(doc, defs);
		// semantic tokens should be produced (non-throw), and tokens array exists
		expect(Array.isArray(tokens)).toBe(true);
		expect(sem && Array.isArray(sem.data)).toBe(true);
		// analysis should contain a syntax diagnostic for unterminated comment
		const hasDiag = analysis.diagnostics.some(d => /Unterminated block comment/i.test(d.message));
		expect(hasDiag).toBe(true);
	});

	it('recovers and continues parsing after unterminated comment', async () => {
		const defs = await loadTestDefs();
		const code = '/*\n* not closed\ninteger x = 3;\n';
		const doc = docFrom(code);
		const { analysis } = runPipeline(doc, defs);
		// Should still pick up unknown identifier diagnostic if any, but importantly should not throw
		expect(analysis.diagnostics.length).toBeGreaterThan(0);
	});
});
