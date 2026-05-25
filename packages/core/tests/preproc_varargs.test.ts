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

	it('does not expand __VA_OPT__ for an empty trailing variadic argument', async () => {
		const defs = await loadTestDefs();
		const code = [
			'#define LOG(fmt, ...) llSay(0, fmt __VA_OPT__(,) __VA_ARGS__)',
			'default { state_entry() { LOG("A",); } }',
		].join('\n');
		const doc = docFrom(code);
		const { pre } = runPipeline(doc, defs);
		const asText = (pre.expandedTokens ?? []).map(t => t.value).join(' ');
		expect(asText).toContain('"A"');
		expect(asText).not.toContain('"A" ,');
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

	it('drops comments while collecting multiline macro arguments', async () => {
		const defs = await loadTestDefs();
		const code = [
			'#define TO_JSON(...) llList2Json(JSON_OBJECT, (list)(__VA_ARGS__))',
			'#define STORE(id, payload) { string data = TO_JSON(payload); llOwnerSay(data); }',
			'default {',
			'\tstate_entry() {',
			'\t\tSTORE("id", [',
			'\t\t\t"name", "value", // inline note',
			'\t\t\t"count", 1',
			'\t\t]);',
			'\t}',
			'}',
		].join('\n');
		const doc = docFrom(code);
		const { expandedTokens, analysis } = runPipeline(doc, defs);
		const asText = expandedTokens?.map(t => t.value).join(' ') ?? '';
		expect(asText).toContain('"count"');
		expect(asText).not.toContain('// inline note');
		expect(analysis.diagnostics.map(d => `${d.code}: ${d.message}`).join('\n')).not.toMatch(/LSL000/);
	});

	it('expands nested macro calls inside function macro arguments', async () => {
		const defs = await loadTestDefs();
		const code = [
			'#define GET(section, key) llJsonGetValue(llLinksetDataRead(section), key)',
			'#define REPLACE(haystack, old, value, start) llReplaceSubString(haystack, old, value, start)',
			'default {',
			'\tstate_entry() {',
			'\t\tstring value = REPLACE(GET("id", ["model"]), ".", "-", 0);',
			'\t\tllOwnerSay(value);',
			'\t}',
			'}',
		].join('\n');
		const doc = docFrom(code);
		const { expandedTokens, analysis } = runPipeline(doc, defs);
		const asText = expandedTokens?.map(t => t.value).join(' ') ?? '';
		expect(asText).toContain('llJsonGetValue');
		expect(asText).not.toContain('GET');
		expect(analysis.diagnostics.some(d => d.code === 'LSL001' && d.message.includes('GET'))).toBe(false);
	});
});
