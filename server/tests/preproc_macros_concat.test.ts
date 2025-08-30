import { describe, it, expect } from 'vitest';
import { docFrom, runPipeline } from './testUtils';
import { loadTestDefs } from './loadDefs.testutil';

describe('preprocessor: string macro concat', () => {
	it('does not flag string macro + string concat after include', async () => {
		const defs = await loadTestDefs();
		const code = [
			'#include "macros_str.lslh"',
			'default {',
			'\tstate_entry() {',
			'\t\tstring msg = BUTTON_YES + "/" + BUTTON_NO;',
			'\t\tllSay(0, msg);',
			'\t}',
			'}'
		].join('\n');
		const doc = docFrom(code, 'file:///proj/main.lsl');
		const { analysis } = runPipeline(doc, defs, { includePaths: [__dirname + '/fixtures/includes'] });
		const msgs = analysis.diagnostics.map(d => d.message);
		expect(msgs.some(m => m.includes('Operator + type mismatch'))).toBe(false);
	});
});
