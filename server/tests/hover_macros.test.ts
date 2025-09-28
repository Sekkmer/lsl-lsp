import { describe, it, expect } from 'vitest';
import { docFrom, runPipeline, hoverToString } from './testUtils';
import { lslHover } from '../src/hover';
import { loadTestDefs } from './loadDefs.testutil';

describe('hover: macros', async () => {
	const defs = await loadTestDefs();

	it('renders object-like macro expressions without JSON string quotes', () => {
		const code = [
			'#define X (1 + 1)',
			'default { state_entry() { integer a = X; } }',
		].join('\n');
		const doc = docFrom(code);
		const { analysis, pre } = runPipeline(doc, defs);
		const pos = doc.positionAt(code.indexOf('X;') + 1);
		const hv = lslHover(doc, { position: pos }, defs, analysis, pre);
		expect(hv).toBeTruthy();
		const md = hoverToString(hv!);
		expect(md).toContain('#define X (1 + 1)');
		expect(md).not.toContain(String.raw`\"(1 + 1)\"`); // no JSON.stringify-style quoting
	});

	it('renders quoted string literal as-is (no extra escapes)', () => {
		const code = [
			'#define STR "hello"',
			'default { state_entry() { llSay(0, STR); } }',
		].join('\n');
		const doc = docFrom(code);
		const { analysis, pre } = runPipeline(doc, defs);
		const pos = doc.positionAt(code.indexOf('STR') + 1);
		const hv = lslHover(doc, { position: pos }, defs, analysis, pre);
		expect(hv).toBeTruthy();
		const md = hoverToString(hv!);
		// Should show the literal with quotes, but not escaped with backslashes
		expect(md).toContain('"hello"');
		expect(md).not.toContain(String.raw`\"hello\"`);
	});

	it('renders mixed string + expr via #define form', () => {
		const code = [
			'#define MSG "something" + val + "val"',
			'default { state_entry() { string s = MSG; } }',
		].join('\n');
		const doc = docFrom(code);
		const { analysis, pre } = runPipeline(doc, defs);
		const pos = doc.positionAt(code.indexOf('MSG') + 1);
		const hv = lslHover(doc, { position: pos }, defs, analysis, pre);
		expect(hv).toBeTruthy();
		const md = hoverToString(hv!);
		expect(md).toContain('#define MSG "something" + val + "val"');
	});

	it('macro alias hover includes function metadata', () => {
		const code = [
			'#define SAYIT llSay',
			'default { state_entry() { SAYIT(0, "hi"); } }',
		].join('\n');
		const doc = docFrom(code);
		const { analysis, pre } = runPipeline(doc, defs);
		const pos = doc.positionAt(code.indexOf('SAYIT(') + 2);
		const hv = lslHover(doc, { position: pos }, defs, analysis, pre);
		expect(hv).toBeTruthy();
		const md = hoverToString(hv!);
		expect(md).toContain('llSay(');
		expect(md).toContain('Alias: #define SAYIT llSay');
		expect(md).toContain('**Cost:**');
		expect(md).toContain('Energy: 10');
		expect(md).toContain('Sleep: 0.1s');
		expect(md).toContain('Experience-only');
	});
});
