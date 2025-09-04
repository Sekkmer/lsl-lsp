import { describe, it, expect } from 'vitest';
import { docFrom, runPipeline } from './testUtils';
import { loadTestDefs } from './loadDefs.testutil';

// Validate vararg macros expanding into list literals [ ... ]
describe('preprocessor: varargs into list literals', () => {
	it('expands to empty list when no varargs', async () => {
		const defs = await loadTestDefs();
		const code = [
			'#define MAKE_LIST(...) list a = [ __VA_ARGS__ ];',
			'default {',
			'\tstate_entry() {',
			'\t\tMAKE_LIST();', // should become: list a = [];
			'\t}',
			'}'
		].join('\n');
		const doc = docFrom(code);
		const { tokens, analysis } = runPipeline(doc, defs);
		const asText = tokens.map(t => t.value).join(' ');
		// Diagnostics: no generic syntax errors and no leaked __VA_ARGS__ identifier
		const msgs = analysis.diagnostics.map(d => `${d.code}: ${d.message}`).join('\n');
		expect(msgs).not.toMatch(/LSL000/);
		expect(msgs).not.toMatch(/Unknown identifier "__VA_ARGS__"/);
		// Ensure no dangling comma before closing bracket
		expect(asText).not.toContain(', ]');
		// Presence of list brackets in the expansion
		expect(asText.includes('[')).toBe(true);
		expect(asText.includes(']')).toBe(true);
	});

	it('handles head + optional varargs with __VA_OPT__ inside list', async () => {
		const defs = await loadTestDefs();
		const code = [
			'#define MAKE_LIST2(head, ...) list b = [ head __VA_OPT__(,) __VA_ARGS__ ];',
			'default {',
			'\tstate_entry() {',
			'\t\tMAKE_LIST2(1);', // -> list b = [ 1 ];
			'\t\tMAKE_LIST2(1, 2, 3);', // -> list b = [ 1, 2, 3 ];
			'\t}',
			'}'
		].join('\n');
		const doc = docFrom(code);
		const { tokens, analysis } = runPipeline(doc, defs);
		const asText = tokens.map(t => t.value).join(' ');
		const msgs = analysis.diagnostics.map(d => `${d.code}: ${d.message}`).join('\n');
		// No parser errors; no leaked __VA_ARGS__ identifier
		expect(msgs).not.toMatch(/LSL000/);
		expect(msgs).not.toMatch(/Unknown identifier "__VA_ARGS__"/);
		// For the second call, ensure the numbers appear
		expect(asText.includes('1')).toBe(true);
		expect(asText.includes('2')).toBe(true);
		expect(asText.includes('3')).toBe(true);
		// Ensure no dangling comma before closing bracket
		expect(asText).not.toContain(', ]');
	});
});
