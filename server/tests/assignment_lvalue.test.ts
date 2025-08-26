import { describe, it, expect } from 'vitest';
import { docFrom, runPipeline } from './testUtils';
import { loadDefs } from '../src/defs';
import path from 'node:path';

const defsPath = path.join(__dirname, 'fixtures', 'lsl-defs.json');

describe('assignment left-hand side must be a variable', () => {
	it('flags string literal on LHS', async () => {
		const defs = await loadDefs(defsPath);
		const code = `
"" = "";
`;
		const doc = docFrom(code, 'file:///lhs_str.lsl');
		const { analysis } = runPipeline(doc, defs, { macros: {}, includePaths: [] });
		const msgs = analysis.diagnostics.map(d => `${d.message} @${d.code}`);
		expect(msgs.some(m => m.includes('Left-hand side of assignment must be a variable') && m.includes('LSL050'))).toBe(true);
	});

	it('flags number literal on LHS', async () => {
		const defs = await loadDefs(defsPath);
		const code = `
1 = 1;
`;
		const doc = docFrom(code, 'file:///lhs_num.lsl');
		const { analysis } = runPipeline(doc, defs, { macros: {}, includePaths: [] });
		const msgs = analysis.diagnostics.map(d => `${d.message} @${d.code}`);
		expect(msgs.some(m => m.includes('Left-hand side of assignment must be a variable') && m.includes('LSL050'))).toBe(true);
	});

	it('flags function call on LHS', async () => {
		const defs = await loadDefs(defsPath);
		const code = `
integer a; integer b;
llGetOwner() = 1;
`;
		const doc = docFrom(code, 'file:///lhs_call.lsl');
		const { analysis } = runPipeline(doc, defs, { macros: {}, includePaths: [] });
		const msgs = analysis.diagnostics.map(d => `${d.message} @${d.code}`);
		expect(msgs.some(m => m.includes('Left-hand side of assignment must be a variable') && m.includes('LSL050'))).toBe(true);
	});

	it('accepts variable assignment', async () => {
		const defs = await loadDefs(defsPath);
		const code = `
integer a; default { state_entry() { a = 2; } }
`;
		const doc = docFrom(code, 'file:///lhs_ok.lsl');
		const { analysis } = runPipeline(doc, defs, { macros: {}, includePaths: [] });
		const hasInvalid = analysis.diagnostics.some(d => d.code === 'LSL050');
		expect(hasInvalid).toBe(false);
	});
});
