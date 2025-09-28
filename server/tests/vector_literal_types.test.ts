import { describe, it, expect } from 'vitest';
import path from 'node:path';
import { docFrom, runPipeline } from './testUtils';
import { loadDefs } from '../src/defs';

const defsPath = path.join(__dirname, '..', '..', 'third_party', 'lsl-definitions', 'lsl_definitions.yaml');

describe('VectorLiteral component typing', () => {
	it('flags non-numeric components in vector literal', async () => {
		const defs = await loadDefs(defsPath);
		const code = `
vector a = <"x", 1, 2>; // bad: string
list L = [];
vector b = <L, 1, 2>; // bad: list
`;
		const doc = docFrom(code, 'file:///vec_bad.lsl');
		const { analysis } = runPipeline(doc, defs, { macros: {}, includePaths: [] });
		const msgs = analysis.diagnostics.map(d => d.message);
		expect(msgs.filter(m => m.includes('Vector component must be numeric')).length).toBeGreaterThanOrEqual(2);
	});

	it('allows numeric variables and literals as components', async () => {
		const defs = await loadDefs(defsPath);
		const code = `
float f = 1.0;
integer i = 2;
vector ok1 = <1, 2.0, 3>; // all numeric literals
vector ok2 = <f, i, 3>;	 // numeric variables
`;
		const doc = docFrom(code, 'file:///vec_ok.lsl');
		const { analysis } = runPipeline(doc, defs, { macros: {}, includePaths: [] });
		const msgs = analysis.diagnostics.map(d => d.message);
		expect(msgs.some(m => m.includes('Vector component must be numeric'))).toBe(false);
	});
});
