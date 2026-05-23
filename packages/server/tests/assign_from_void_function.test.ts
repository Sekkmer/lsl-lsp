import { describe, it, expect } from 'vitest';
import { docFrom, runPipeline } from './testUtils';
import { loadDefs } from '../src/defs';
import path from 'node:path';

const defsPath = path.join(__dirname, 'fixtures', 'lsl-defs.yaml');

describe('assignment from void-returning function', () => {
	it('errors when assigning call to user-defined void function', async () => {
		const code = `
integer x;
foo(){ x = foo(); }
default{ state_entry(){ integer y = foo(); } }
`;
		const doc = docFrom(code, 'file:///voiduser.lsl');
		const defs = await loadDefs(defsPath);
		const { analysis } = runPipeline(doc, defs);
		const msgs = analysis.diagnostics.map(d => d.message).join('\n');
		expect(msgs).toMatch(/returns void; cannot be used as a value/);
	});

	it('errors when assigning call to built-in or included void function (simulated)', async () => {
		// Simulate a known void function by using a well-known built-in
		const code = `
integer x;
integer main(){ x = llOwnerSay("hi"); return 0; }
`;
		const doc = docFrom(code, 'file:///voidbuiltin.lsl');
		const defs = await loadDefs(defsPath);
		const { analysis } = runPipeline(doc, defs);
		const msgs = analysis.diagnostics.map(d => d.message).join('\n');
		// llOwnerSay returns void in LSL
		expect(msgs).toMatch(/returns void; cannot be used as a value/);
	});

	it('does not error when assigning non-void function call', async () => {
		const code = `
integer x;
integer f(){ return 42; }
default{ state_entry(){ x = f(); } }
`;
		const doc = docFrom(code, 'file:///nonvoid.lsl');
		const defs = await loadDefs(defsPath);
		const { analysis } = runPipeline(doc, defs);
		const msgs = analysis.diagnostics.map(d => d.message).join('\n');
		expect(msgs).not.toMatch(/returns void; cannot be used as a value/);
	});
});
