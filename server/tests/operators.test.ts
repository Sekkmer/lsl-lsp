import { describe, it, expect } from 'vitest';
import { docFrom } from './testUtils';
import { loadDefs } from '../src/defs';
import path from 'node:path';
import { runPipeline } from './testUtils';

const defsPath = path.join(__dirname, '..', '..', 'common', 'lsl-defs.json');

describe('operator/type checks', () => {
	it('division/modulus by zero', async () => {
		const defs = await loadDefs(defsPath);
		const code = `
integer a = 4 / 0;
integer b = 4 % 0;
`;
		const doc = docFrom(code, 'file:///ops1.lsl');
		const { analysis } = runPipeline(doc, defs, { macros: {}, includePaths: [] });
		const msgs = analysis.diagnostics.map(d => d.message);
		expect(msgs.some(m => m.includes('Division by zero'))).toBe(true);
		expect(msgs.some(m => m.includes('Modulus by zero'))).toBe(true);
	});

	it('modulus types: only integer%integer or vector%vector', async () => {
		const defs = await loadDefs(defsPath);
		const code = `
integer a;
float b;
a = a % b; // bad
vector v;
vector w;
v = v % w; // ok
`;
		const doc = docFrom(code, 'file:///ops2.lsl');
		const { analysis } = runPipeline(doc, defs, { macros: {}, includePaths: [] });
		const msgs = analysis.diagnostics.map(d => d.message);
		expect(msgs.some(m => m.includes('Operator % expects integer%integer or vector%vector'))).toBe(true);
	});

	it('bitwise and shifts require integer', async () => {
		const defs = await loadDefs(defsPath);
		const code = `
float f;
integer i;
integer a = i & 3; // ok
integer b = f & 3; // bad
integer c = i << 1; // ok
integer d = f >> 1; // bad
`;
		const doc = docFrom(code, 'file:///ops3.lsl');
		const { analysis } = runPipeline(doc, defs, { macros: {}, includePaths: [] });
		const msgs = analysis.diagnostics.map(d => d.message + ' @' + d.code);
		expect(msgs.filter(m => m.includes('expects integer operands')).length).toBeGreaterThanOrEqual(2);
	});

	it('does not flag integer shifts inside parentheses and bitwise or', async () => {
		const defs = await loadDefs(defsPath);
		const code = `
integer XorValue(string input) {
	string h8 = llGetSubString(llSHA256String(input), 0, 7);
	integer i; integer v = 0;
	for (i = 0; i < 8; ++i) {
		string ch = llToLower(llGetSubString(h8, i, i));
		integer n = llSubStringIndex("0123456789abcdef", ch);
		if (n < 0) return 0;
		v = (v << 4) | n;
	}
	return v;
}
`;
		const doc = docFrom(code, 'file:///ops4.lsl');
		const { analysis } = runPipeline(doc, defs, { macros: {}, includePaths: [] });
		const msgs = analysis.diagnostics.map(d => d.message + ' @' + d.code);
		expect(msgs.some(m => m.includes('expects integer operands') && m.includes('LSL011'))).toBe(false);
	});

	it('addition combos: list ok, string ok, numeric ok; mismatch flagged', async () => {
		const defs = await loadDefs(defsPath);
		const code = `
list L = [] + [1]; // ok
string s = "a" + "b"; // ok
float f = 1 + 2.0; // ok
vector v = <1,2,3> + <4,5,6>; // ok
integer bad = <1,2,3> + 1; // bad
`;
		const doc = docFrom(code, 'file:///ops4.lsl');
		const { analysis } = runPipeline(doc, defs, { macros: {}, includePaths: [] });
		const msgs = analysis.diagnostics.map(d => d.message);
		expect(msgs.some(m => m.includes('Operator + type mismatch'))).toBe(true);
	});
});
