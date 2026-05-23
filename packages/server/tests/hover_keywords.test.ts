import { describe, it, expect } from 'vitest';
import { docFrom, runPipeline } from './testUtils';
import { lslHover } from '../src/hover';
import { loadTestDefs } from './loadDefs.testutil';

describe('hover: keywords', async () => {
	const defs = await loadTestDefs();

	it('does not show hover for "for"', () => {
		const code = 'default { state_entry() { for (integer i = 0; i < 3; i++) {} } }';
		const doc = docFrom(code);
		const { analysis, pre } = runPipeline(doc, defs);
		const idx = code.indexOf('for');
		const pos = doc.positionAt(idx + 1);
		const hv = lslHover(doc, { position: pos }, defs, analysis, pre);
		expect(hv).toBeNull();
	});
});
