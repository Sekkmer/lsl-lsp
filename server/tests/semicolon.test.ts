import { describe, it, expect } from 'vitest';
import { docFrom, runPipeline } from './testUtils';
import { loadTestDefs } from './loadDefs.testutil';
import { LSL_DIAGCODES } from '../src/parser';

// Repro from issue: missing semicolon after return causes error on next function
//
// list GetCurrentEditPermissionButtons()
// {
// 	if (g_CurrentEditType == "Public")
// 	return []
// }


describe('semicolon diagnostics', () => {
	it('reports missing semicolon after return and recovers', async () => {
		const defs = await loadTestDefs();
		const doc = docFrom(`
list GetCurrentEditPermissionButtons()
{
  if (g_CurrentEditType == "Public")
    return []
}

integer Next(){ return 1; }
`);
		const { analysis } = runPipeline(doc, defs);
		const missing = analysis.diagnostics.find(d => d.code === LSL_DIAGCODES.SYNTAX && /Missing semicolon after return/.test(d.message));
		expect(missing).toBeTruthy();
		// Ensure we did not produce a cascade into the next function as UNKNOWN_IDENTIFIER on 'integer' or similar
		const hasSpurious = analysis.diagnostics.some(d => d.code === LSL_DIAGCODES.UNKNOWN_IDENTIFIER && /integer|Next/.test((doc.getText().slice(doc.offsetAt(d.range.start), doc.offsetAt(d.range.end)))));
		expect(hasSpurious).toBe(false);
	});
});
