import { describe, it, expect } from 'vitest';
import { docFrom, runPipeline } from './testUtils';
import { loadTestDefs } from './loadDefs.testutil';

// Validate function-like macros with varargs: __VA_ARGS__ and __VA_OPT__
describe('preprocessor: varargs macros', () => {
	it('expands __VA_OPT__ content only when varargs present', async () => {
		const defs = await loadTestDefs();
		const code = [
			'#define LOG(fmt, ...) llSay(0, fmt __VA_OPT__(,) __VA_ARGS__)',
			'default {',
			'\tstate_entry() {',
			'\t\tLOG("A");', // no varargs -> no comma emitted
			'\t\tLOG("B %d", 42);', // has varargs -> comma emitted and args spliced
			'\t}',
			'}'
		].join('\n');
		const doc = docFrom(code);
		const { tokens } = runPipeline(doc, defs);
		const asText = tokens.map(t => t.value).join(' ');
		// Should contain two llSay calls, one without extra comma/args and one with
		expect(asText.includes('llSay')).toBe(true);
		// The pattern "A" ) ; should appear (no comma, no extra)
		expect(asText.includes('"A"')).toBe(true);
		// The literal 42 should be present from second expansion
		expect(asText.includes('42')).toBe(true);
	});

	it('joins __VA_ARGS__ with commas for multiple args', async () => {
		const defs = await loadTestDefs();
		const code = [
			'#define SUM3(fmt, ...) llSay(0, fmt, __VA_ARGS__)',
			'default {',
			'\tstate_entry() {',
			'\t\tSUM3("S", 1, 2, 3);',
			'\t}',
			'}'
		].join('\n');
		const doc = docFrom(code);
		const { tokens } = runPipeline(doc, defs);
		const asText = tokens.map(t => t.value).join(' ');
		expect(asText.includes('1')).toBe(true);
		expect(asText.includes('2')).toBe(true);
		expect(asText.includes('3')).toBe(true);
	});
});
