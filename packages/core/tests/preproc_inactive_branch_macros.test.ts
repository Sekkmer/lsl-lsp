import { describe, it, expect } from 'vitest';
import { docFrom, runPipeline } from './testUtils';
import { loadTestDefs } from './loadDefs.testutil';

// Regression test: function-like macro in an inactive branch should not leak
// and expand identifiers in the active branch.
describe('preprocessor inactive branch macro isolation', () => {
	it('does not expand function-like macro from disabled #ifdef branch', async () => {
		const defs = await loadTestDefs();
		const doc = docFrom(`
// header-style file
#ifdef INLINE_OCCUR
// function-like macro present in an inactive branch; body content intentionally minimal
#define macro_function(arg1, arg2) (0)
#else
// active branch provides a regular function declaration/definition
integer macro_function(list arg1, string arg2) {
	return 0;
}
#endif
`);
		const { analysis, tokens, pre } = runPipeline(doc, defs, { macros: {} });
		// No errors should be produced (ignore hints like unused params)
		const errs = analysis.diagnostics.filter(d => (d.severity ?? 3) === 1);
		expect(errs.length).toBe(0);
		// The identifier 'macro_function' should appear as a function name token (not macro-expanded text)
		const hasFuncId = tokens.some(t => t.kind === 'id' && t.value === 'macro_function');
		expect(hasFuncId).toBe(true);
		// Ensure the inactive branch was actually disabled
		expect(pre.disabledRanges.length).toBeGreaterThan(0);
	});
});
