import { describe, it, expect } from 'vitest';
import { docFrom, runPipeline, semToSpans } from './testUtils';
import { loadTestDefs } from './loadDefs.testutil';
import { semanticTokensLegend } from '../src/semtok';

function idx(name: string) {
	return (semanticTokensLegend.tokenTypes as string[]).indexOf(name);
}
function hasMod(mods: number, name: string) {
	const bit = 1 << (semanticTokensLegend.tokenModifiers as string[]).indexOf(name);
	return (mods & bit) !== 0;
}

describe('parameters are always readonly', () => {
	it('function parameter tokens have readonly at decl and uses', async () => {
		const defs = await loadTestDefs();
		const doc = docFrom(`
integer foo(integer p) {
	integer x = p;
	return p;
}

default {
	state_entry() {
		integer y = foo(42);
	}
}
`);
		const { sem } = runPipeline(doc, defs);
		const spans = semToSpans(doc, sem);
		const paramType = idx('parameter');
		const text = doc.getText();
		const lines = text.split(/\r?\n/);
		function textAt(s: { line: number; char: number; len: number }) { const line = lines[s.line] ?? ''; return line.slice(s.char, s.char + s.len); }
		const pSpans = spans.filter(s => s.type === paramType && textAt(s) === 'p');
		// Expect at least declaration + one use
		expect(pSpans.length).toBeGreaterThanOrEqual(2);
		expect(pSpans.every(s => hasMod(s.mod, 'readonly'))).toBe(true);
	});

	it('event parameter tokens have readonly at decl and uses', async () => {
		const defs = await loadTestDefs();
		const doc = docFrom(`
default {
	touch_start(integer n) {
		integer z = n;
		if (n > 0) { integer w = n; }
	}
}
`);
		const { sem } = runPipeline(doc, defs);
		const spans = semToSpans(doc, sem);
		const paramType = idx('parameter');
		const text = doc.getText();
		const lines = text.split(/\r?\n/);
		function textAt(s: { line: number; char: number; len: number }) { const line = lines[s.line] ?? ''; return line.slice(s.char, s.char + s.len); }
		const nSpans = spans.filter(s => s.type === paramType && textAt(s) === 'n');
		expect(nSpans.length).toBeGreaterThanOrEqual(2);
		expect(nSpans.every(s => hasMod(s.mod, 'readonly'))).toBe(true);
	});
});
