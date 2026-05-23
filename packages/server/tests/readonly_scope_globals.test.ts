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

describe('readonly semantics across scopes', () => {
	it('global assigned in one event is not readonly anywhere; shadowed local can be readonly', async () => {
		const defs = await loadTestDefs();
		const doc = docFrom(`
integer g = 1; // init only, but reassigned later

default {
	state_entry() {
		integer x = g; // use global
	}

	touch_start(integer n) {
		g = g + 1; // write to global
		integer g = 5; // shadowing local with only initializer -> readonly
		integer y = g; // use shadowed local (readonly)
	}
}
`);
		const { sem } = runPipeline(doc, defs);
		const spans = semToSpans(doc, sem);
		const varType = idx('variable');
		const globals = spans.filter(s => s.type === varType);
		// Expect at least one variable span without readonly (the global uses)
		expect(globals.some(s => !hasMod(s.mod, 'readonly'))).toBe(true);
		// Expect at least one variable span with readonly (the shadowed local)
		expect(globals.some(s => hasMod(s.mod, 'readonly'))).toBe(true);
	});

	it('locals are uniformly readonly or not per declaration (no pre-first-write readonly)', async () => {
		const defs = await loadTestDefs();
		const doc = docFrom(`
default {
	state_entry() {
		integer a = 0; // write #1
		integer b = a; // use a
		a = a + 1; // write #2
		integer c = a; // use a again
	}
}
`);
		const { sem } = runPipeline(doc, defs);
		const spans = semToSpans(doc, sem);
		const varType = idx('variable');
		// Narrow to spans whose text is exactly 'a'
		const text = doc.getText();
		const lines = text.split(/\r?\n/);
		function textAt(s: { line: number; char: number; len: number }) {
			const line = lines[s.line] ?? '';
			return line.slice(s.char, s.char + s.len);
		}
		const aSpans = spans.filter(s => s.type === varType && textAt(s) === 'a');
		// All occurrences of 'a' should be non-readonly since it's assigned more than once in its scope
		expect(aSpans.length).toBeGreaterThanOrEqual(3);
		expect(aSpans.every(s => !hasMod(s.mod, 'readonly'))).toBe(true);
	});
});
