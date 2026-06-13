import { describe, it, expect } from 'vitest';
import { docFrom, runPipeline } from './testUtils';
import { loadDefs } from '../src/defs';
import path from 'node:path';

const defsPath = path.join(__dirname, 'fixtures', 'lsl-defs.yaml');

describe('assignment left-hand side must be a variable', () => {
	it('flags string literal on LHS', async () => {
		const defs = await loadDefs(defsPath);
		const code = `
default { state_entry() {
	"" = "";
} }
`;
		const doc = docFrom(code, 'file:///lhs_str.lsl');
		const { analysis } = runPipeline(doc, defs, { macros: {}, includePaths: [] });
		const msgs = analysis.diagnostics.map(d => `${d.message} @${d.code}`);
		expect(msgs.some(m => m.includes('Left-hand side of assignment must be a variable') && m.includes('LSL050'))).toBe(true);
	});

	it('flags number literal on LHS', async () => {
		const defs = await loadDefs(defsPath);
		const code = `
default { state_entry() {
	1 = 1;
} }
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
default { state_entry() {
	llGetOwner() = 1;
} }
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

	it('accepts SL unary assignment conditions while still warning as suspicious', async () => {
		const defs = await loadDefs(defsPath);
		const code = `
default {
	state_entry() {
		integer i;
		list l = ["a", "a", "a", "a"];
		while(~i = llListFindList(l, ["a"]))
			l = llListReplaceList(l, ["b"], i, i);
	}
}
`;
		const doc = docFrom(code, 'file:///issue5_unary_assignment_condition.lsl');
		const { analysis } = runPipeline(doc, defs, { macros: {}, includePaths: [] });
		expect(analysis.diagnostics.some(d => d.code === 'LSL050')).toBe(false);
		expect(analysis.diagnostics.some(d => d.code === 'LSL051')).toBe(true);
	});

	it('parses prefix unary assignment as assignment inside the unary operator', async () => {
		const defs = await loadDefs(defsPath);
		const code = `
default { state_entry() {
	integer a = 123;
	integer b = 123;
	integer c = 123;
	integer notResult = !a = 0;
	integer bitResult = ~b = 0;
	integer negResult = -c = 5;
} }
`;
		const doc = docFrom(code, 'file:///unary_assignment_precedence.lsl');
		const { analysis } = runPipeline(doc, defs, { macros: {}, includePaths: [] });
		expect(analysis.diagnostics.some(d => d.code === 'LSL050')).toBe(false);
	});

	it('accepts vector member assignment', async () => {
		const defs = await loadDefs(defsPath);
		const code = `
default { state_entry() {
	vector v = <1.0, 2.0, 3.0>;
	v.x = 4.0;
} }
`;
		const doc = docFrom(code, 'file:///lhs_member_ok.lsl');
		const { analysis } = runPipeline(doc, defs, { macros: {}, includePaths: [] });
		const hasInvalid = analysis.diagnostics.some(d => d.code === 'LSL050');
		expect(hasInvalid).toBe(false);
	});

	it('flags parenthesized member assignment', async () => {
		const defs = await loadDefs(defsPath);
		const code = `
default { state_entry() {
	vector v = <1.0, 2.0, 3.0>;
	(v.x) = 4.0;
} }
`;
		const doc = docFrom(code, 'file:///lhs_parenthesized_member.lsl');
		const { analysis } = runPipeline(doc, defs, { macros: {}, includePaths: [] });
		const msgs = analysis.diagnostics.map(d => `${d.message} @${d.code}`);
		expect(msgs.some(m => m.includes('Left-hand side of assignment must be a variable') && m.includes('LSL050'))).toBe(true);
	});
});
