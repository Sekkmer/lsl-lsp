import { describe, it, expect } from 'vitest';
import { docFrom, runPipeline } from './testUtils';
import { loadTestDefs } from './loadDefs.testutil';

// Regression: nested chain inside include guard must select only one MACRO declaration.

describe('preprocessor nested chain active branch only', () => {
	it('emits only one MACRO list from nested chain (fallback branch when macro undefined)', async () => {
		const src = `#ifndef _GUARD_
#define A1 1
#define A2 2
#define A3 3
#define A4 4
// MACRO selection nested chain
#if MACRO_STYLE == A1
list MACRO = [1];
#elif MACRO_STYLE == A2
list MACRO = [2];
#elif MACRO_STYLE == A3
list MACRO = [3];
#elif MACRO_STYLE == A4 || !defined(MACRO_STYLE)
list MACRO = [4];
#endif
#endif
`;
		const doc = docFrom(src);
		const defs = await loadTestDefs();
		const { analysis } = runPipeline(doc, defs, { macros: {} });
		// The analyzeAst result exposes declarations via analysis.decls; script.globals are not on analysis.
		// Filter variable declarations named MACRO from decls (kind 'var'). Expect exactly one.
		const macroDecls = analysis.decls.filter(d => d.kind === 'var' && d.name === 'MACRO');
		expect(macroDecls.length).toBe(1);
	});
});
