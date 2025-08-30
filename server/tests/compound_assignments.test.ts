import { describe, it, expect } from 'vitest';
import { docFrom } from './testUtils';
import { loadDefs } from '../src/defs';
import path from 'node:path';
import { runPipeline } from './testUtils';

const defsPath = path.join(__dirname, '..', '..', 'common', 'lsl-defs.json');

describe('compound assignments', () => {
	it('validates LHS assignability and zero/type checks', async () => {
		const defs = await loadDefs(defsPath);
		const code = `
default {
	state_entry() {
		integer i; float f; vector v;
		(i) += 1; // bad lhs
		f /= 0; // division by zero
		integer a = 1; a %= 0; // modulus by zero
		v %= <1,2,3>; // ok type-wise
		v %= 2; // bad type
	}
}
`;
		const doc = docFrom(code, 'file:///compound.lsl');
		const { analysis } = runPipeline(doc, defs, { macros: {}, includePaths: [] });
		const msgs = analysis.diagnostics.map(d => d.message + ' @' + d.code);
		expect(msgs.some(m => m.includes('Left-hand side of assignment must be a variable') && m.includes('LSL050'))).toBe(true);
		expect(msgs.some(m => m.includes('Division by zero') && m.includes('LSL011'))).toBe(true);
		expect(msgs.some(m => m.includes('Modulus by zero') && m.includes('LSL011'))).toBe(true);
		expect(msgs.some(m => m.includes('Operator % expects integer%integer or vector%vector') && m.includes('LSL011'))).toBe(true);
	});
});
