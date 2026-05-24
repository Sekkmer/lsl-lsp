import { describe, it, expect } from 'vitest';
import { docFrom, runPipeline } from './testUtils';
import { loadTestDefs } from './loadDefs.testutil';

describe('preprocessor-split else attachment', () => {
	const src = `
default
{
	state_entry()
	{
			if (1)
			{
				llSay(0, "A");

			#ifdef TEST
			} else if (0) {
				llSay(0, "B");
			}
			#else
			} else {
				llSay(0, "C");
			}
			#endif
	}
}
`;

	it('does not report unexpected else when TEST is defined', async () => {
		const defs = await loadTestDefs();
		const doc = docFrom(src);
		const { analysis } = runPipeline(doc, defs, { macros: { TEST: 1 } });
		const unexpectedElse = analysis.diagnostics.find(d => String(d.code) === 'LSL000' && /unexpected 'else' without matching 'if'/.test(d.message));
		expect(unexpectedElse).toBeUndefined();
		// Sanity: overall parser should not emit syntax errors here
		const anySyntax = analysis.diagnostics.find(d => String(d.code).startsWith('LSL0'));
		expect(anySyntax).toBeUndefined();
	});

	it('does not report unexpected else when TEST is undefined', async () => {
		const defs = await loadTestDefs();
		const doc = docFrom(src);
		const { analysis } = runPipeline(doc, defs, {});
		const unexpectedElse = analysis.diagnostics.find(d => String(d.code) === 'LSL000' && /unexpected 'else' without matching 'if'/.test(d.message));
		expect(unexpectedElse).toBeUndefined();
		const anySyntax = analysis.diagnostics.find(d => String(d.code).startsWith('LSL0'));
		expect(anySyntax).toBeUndefined();
	});
});
