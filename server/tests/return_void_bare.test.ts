import { describe, it, expect } from 'vitest';
import { docFrom, runPipeline } from './testUtils';
import { loadTestDefs } from './loadDefs.testutil';
import { LSL_DIAGCODES } from '../src/analysisTypes';

describe('return: bare return in void contexts', () => {
	it('allows bare return in void function (no warning, no semicolon error)', async () => {
		const defs = await loadTestDefs();
		const doc = docFrom(`
foo(){
  llOwnerSay("ok");
  return;
}
default{ state_entry(){} }
`);
		const { analysis } = runPipeline(doc, defs);
		// no "Missing semicolon after return" syntax diagnostic
		const hasMissingSemi = analysis.diagnostics.some(d => d.code === LSL_DIAGCODES.SYNTAX && /Missing semicolon after return/.test(d.message));
		expect(hasMissingSemi).toBe(false);
		// no warning about returning a value in a void function for a bare return
		const hasVoidValueWarning = analysis.diagnostics.some(d => d.code === LSL_DIAGCODES.RETURN_IN_VOID);
		expect(hasVoidValueWarning).toBe(false);
	});

	it('allows bare return inside nested block in event handler', async () => {
		const defs = await loadTestDefs();
		const doc = docFrom(`
default
{
  state_entry()
  {
    if (TRUE) { llSetMemoryLimit(65536); return; }
  }
}
`);
		const { analysis } = runPipeline(doc, defs);
		const hasMissingSemi = analysis.diagnostics.some(d => d.code === LSL_DIAGCODES.SYNTAX && /Missing semicolon after return/.test(d.message));
		expect(hasMissingSemi).toBe(false);
	});
});
