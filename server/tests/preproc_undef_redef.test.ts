import { describe, it, expect } from 'vitest';
import { docFrom, runPipeline } from './testUtils';
import { loadTestDefs } from './loadDefs.testutil';

describe('preprocessor: #undef and redefinition', () => {
	it('removes macro for subsequent defined() and branches', async () => {
		const defs = await loadTestDefs();
		const code = [
			'#define FLAG 1',
			'#undef FLAG',
			'default {',
			'\tstate_entry() {',
			'\t\t#if defined(FLAG)',
			'\t\tllSay(0, "ON");',
			'\t\t#else',
			'\t\tllSay(0, "OFF");',
			'\t\t#endif',
			'\t}',
			'}'
		].join('\n');
		const doc = docFrom(code);
		const { tokens } = runPipeline(doc, defs);
		const hasON = tokens.some(t => t.kind === 'str' && t.value.includes('ON'));
		const hasOFF = tokens.some(t => t.kind === 'str' && t.value.includes('OFF'));
		expect(hasON).toBe(false);
		expect(hasOFF).toBe(true);
	});

	it('redefinition updates macro value used in #if expression', async () => {
		const defs = await loadTestDefs();
		const code = [
			'#define X 1',
			'#define X 0',
			'default {',
			'\tstate_entry() {',
			'\t\t#if X',
			'\t\tllSay(0, "YES");',
			'\t\t#else',
			'\t\tllSay(0, "NO");',
			'\t\t#endif',
			'\t}',
			'}'
		].join('\n');
		const doc = docFrom(code);
		const { tokens } = runPipeline(doc, defs);
		const hasYES = tokens.some(t => t.kind === 'str' && t.value.includes('YES'));
		const hasNO = tokens.some(t => t.kind === 'str' && t.value.includes('NO'));
		expect(hasYES).toBe(false);
		expect(hasNO).toBe(true);
	});
});
