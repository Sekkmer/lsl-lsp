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

	it('preserves double-slash inside string macro bodies', async () => {
		const defs = await loadTestDefs();
		const code = [
			'#define URL "http://example.com/path"',
			'#define LABEL "ok" // trailing macro comment',
			'default {',
			'\tstate_entry() {',
			'\t\tllOwnerSay(URL);',
			'\t\tllOwnerSay(LABEL);',
			'\t}',
			'}'
		].join('\n');
		const doc = docFrom(code, 'file:///proj/string_macro_url.lsl');
		const { expandedTokens, analysis } = runPipeline(doc, defs);
		expect(expandedTokens?.some(t => t.kind === 'string' && t.value === '"http://example.com/path"')).toBe(true);
		expect(expandedTokens?.some(t => t.kind === 'string' && t.value === '"ok"')).toBe(true);
		expect(expandedTokens?.some(t => String(t.value).includes('trailing macro comment'))).toBe(false);
		expect(analysis.diagnostics.some(d => d.code === 'LSL000')).toBe(false);
	});
});
