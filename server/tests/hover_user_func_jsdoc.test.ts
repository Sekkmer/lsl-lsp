import { describe, it, expect } from 'vitest';
import { docFrom, runPipeline } from './testUtils';
import { lslHover } from '../src/hover';
import { loadTestDefs } from './loadDefs.testutil';

describe('hover: user-defined function JSDoc', async () => {
	const defs = await loadTestDefs();

	it('shows /** */ doc above function', () => {
		const code = [
			'/**',
			' * Adds two integers.',
			' * Returns their sum.',
			' */',
			'integer add(integer a, integer b) {',
			'  return a + b;',
			'}',
			'default { state_entry() { integer x = add(1,2); } }'
		].join('\n');
		const doc = docFrom(code);
		const { analysis, pre } = runPipeline(doc, defs);
		const hoverPos = doc.positionAt(code.indexOf('add(') + 1);
		const hv = lslHover(doc, { position: hoverPos }, defs, analysis, pre);
		expect(hv).toBeTruthy();
		const md = (hv!.contents as any).value as string;
		expect(md).toContain('integer add(integer a, integer b)');
		expect(md).toMatch(/Adds two integers\./);
		expect(md).toMatch(/Returns their sum\./);
	});

	it('does not use regular /* */ block as doc', () => {
		const code = [
			'/* Not a JSDoc */',
			'integer foo(integer n) { return n; }',
			'default { state_entry() { integer x = foo(3); } }'
		].join('\n');
		const doc = docFrom(code);
		const { analysis, pre } = runPipeline(doc, defs);
		const hoverPos = doc.positionAt(code.indexOf('foo(') + 1);
		const hv = lslHover(doc, { position: hoverPos }, defs, analysis, pre);
		expect(hv).toBeTruthy();
		const md = (hv!.contents as any).value as string;
		expect(md).toContain('integer foo(integer n)');
		expect(md).not.toContain('Not a JSDoc');
	});
});
