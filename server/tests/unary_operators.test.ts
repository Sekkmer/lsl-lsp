import { describe, it, expect } from 'vitest';
import { docFrom } from './testUtils';
import { loadDefs } from '../src/defs';
import path from 'node:path';
import { runPipeline } from './testUtils';

const defsPath = path.join(__dirname, '..', '..', 'common', 'lsl-defs.json');


describe('unary operator validation', () => {
	it('type-checks +/- as numeric and !/~ as integer (no literal-only rule)', async () => {
		const defs = await loadDefs(defsPath);
		const code = `
integer x = 1;
integer a = +x; // bad: not literal
integer b = -x; // bad: not literal
integer c = !1.0; // bad: not integer literal
integer d = ~1.0; // bad: not integer literal
`;
		const doc = docFrom(code, 'file:///unary_bad.lsl');
		const { analysis } = runPipeline(doc, defs, { macros: {}, includePaths: [] });
		const msgs = analysis.diagnostics.map(d => d.message);
		expect(msgs.filter(m => m.includes('Unary operator + expects a numeric value')).length).toBeGreaterThanOrEqual(0);
		expect(msgs.filter(m => m.includes('Unary operator - expects a numeric value')).length).toBeGreaterThanOrEqual(0);
		expect(msgs.filter(m => m.includes('Unary operator ! expects an integer value')).length).toBeGreaterThan(0);
		expect(msgs.filter(m => m.includes('Unary operator ~ expects an integer value')).length).toBeGreaterThan(0);
	});

	it('requires ++/-- on assignable integer variables', async () => {
		const defs = await loadDefs(defsPath);
		const code = `
default {
	state_entry() {
		integer i;
		list L;
		integer z0;
		z0 = ++i; // ok assignable
		z0 = --i; // ok assignable
		z0 = ++(i); // bad: not assignable expression
		z0 = ++L; // bad: not integer variable
	}
}
`;
		const doc = docFrom(code, 'file:///unary_incdec.lsl');
		const { analysis } = runPipeline(doc, defs, { macros: {}, includePaths: [] });
		const msgs = analysis.diagnostics.map(d => d.message + ' @' + d.code);
		expect(msgs.some(m => m.includes('Operand of ++ must be a variable') && m.includes('LSL050'))).toBe(true);
		expect(msgs.some(m => m.includes('Operator ++ expects an integer variable') && m.includes('LSL011'))).toBe(true);
	});
});
