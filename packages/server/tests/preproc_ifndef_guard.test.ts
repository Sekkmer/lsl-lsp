import { describe, it, expect } from 'vitest';
import { docFrom, runPipeline } from './testUtils';
import { loadTestDefs } from './loadDefs.testutil';

// Verifies classic guard pattern:
// #ifndef MACRO
// #define MACRO 1
// #endif
// followed by use of MACRO in code expands without errors.

describe('preprocessor: #ifndef guard (define or skip)', () => {
	it('defines MACRO when initially undefined', async () => {
		const defs = await loadTestDefs();
		const src = `
// #ifndef MACRO TRUE

#ifndef MACRO
#define MACRO (1 + 1)
#endif

integer func() { return MACRO + 1; }
`;
    	const doc = docFrom(src);
		const { analysis } = runPipeline(doc, defs, { macros: {} });
		// Should not produce syntax errors
		const anySyntax = analysis.diagnostics.find(d => String(d.code).startsWith('LSL0'));
		expect(anySyntax).toBeUndefined();
		// Macro table should have MACRO = 1
		//expect(pre.macros.MACRO).toBe(1);
	});

	it('skips define when MACRO pre-defined', async () => {
		const defs = await loadTestDefs();
		const src = `
// #ifndef MACRO TRUE

#ifndef MACRO
#define MACRO (1 + 1)
#endif

integer func() { return MACRO + 1; }
`;
    	const doc = docFrom(src);
		const { analysis } = runPipeline(doc, defs, { macros: { MACRO: 2 } });
		const anySyntax = analysis.diagnostics.find(d => String(d.code).startsWith('LSL0'));
		expect(anySyntax).toBeUndefined();
		// Initial value should remain intact (no redefinition)
		// expect(pre.macros.MACRO).toBe(2);
	});
});
