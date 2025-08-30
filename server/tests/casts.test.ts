import { describe, it, expect } from 'vitest';
import { docFrom, runPipeline } from './testUtils';
import { loadDefs } from '../src/defs';
import path from 'node:path';

const defsPath = path.join(__dirname, '..', '..', 'common', 'lsl-defs.json');

describe('casts validation', () => {
	it('redundant cast warns', async () => {
		const defs = await loadDefs(defsPath);
		const code = `integer a; integer b = (integer)a;`;
		const doc = docFrom(code, 'file:///casts1.lsl');
		const { analysis } = runPipeline(doc, defs, { macros: {}, includePaths: [] });
		const codes = analysis.diagnostics.map(d => d.code);
		expect(codes).toContain('LSL080');
	});
	it('int <-> float allowed', async () => {
		const defs = await loadDefs(defsPath);
		const code = `integer a = (integer)1.2; float f = (float)1;`;
		const doc = docFrom(code, 'file:///casts2.lsl');
		const { analysis } = runPipeline(doc, defs, { macros: {}, includePaths: [] });
		const errWarn = analysis.diagnostics.filter(d => d.severity === 1 || d.severity === 2);
		expect(errWarn.length).toBe(0);
	});
	it('everything to string and list allowed', async () => {
		const defs = await loadDefs(defsPath);
		const code = `string s = (string)<1,2,3>; list l = (list)1;`;
		const doc = docFrom(code, 'file:///casts3.lsl');
		const { analysis } = runPipeline(doc, defs, { macros: {}, includePaths: [] });
		const errWarn = analysis.diagnostics.filter(d => d.severity === 1 || d.severity === 2);
		expect(errWarn.length).toBe(0);
	});
	it('forbidden casts flagged', async () => {
		const defs = await loadDefs(defsPath);
		const code = `vector v = (vector)1; rotation r = (rotation)1; key k = (key)1;`;
		const doc = docFrom(code, 'file:///casts4.lsl');
		const { analysis } = runPipeline(doc, defs, { macros: {}, includePaths: [] });
		const msgs = analysis.diagnostics.map(d => d.message);
		expect(msgs.some(m => m.includes('Cannot cast integer to vector'))).toBe(true);
	});
	it('string literal extra validation hints', async () => {
		const defs = await loadDefs(defsPath);
		const code = `
		integer i = (integer)"abc"; // hint
		float f = (float)"abc"; // hint
		vector v = (vector)"<1, 2>"; // hint
		rotation r = (rotation)"<1, 2, 3>"; // hint
		key k = (key)"not-a-uuid"; // hint
		`;
		const doc = docFrom(code, 'file:///casts5.lsl');
		const { analysis } = runPipeline(doc, defs, { macros: {}, includePaths: [] });
		const infos = analysis.diagnostics.filter(d => d.severity === 3 || d.severity === 2); // Information or Warning
		expect(infos.length).toBeGreaterThanOrEqual(4);
	});
});
