import { describe, it, expect } from 'vitest';
import { docFrom, runPipeline } from './testUtils';
import { loadTestDefs } from './loadDefs.testutil';

function messagesFor(code: string, defs: Awaited<ReturnType<typeof loadTestDefs>>) {
	const doc = docFrom(code, 'file:///global_initializers.lsl');
	const { analysis } = runPipeline(doc, defs);
	return analysis.diagnostics.map(d => `${d.message} @${d.code}`);
}

describe('global initializers', () => {
	it('allows literals, builtin constants, lists, vectors, signed numeric literals, and previous globals', async () => {
		const defs = await loadTestDefs();
		const msgs = messagesFor(`
integer a = -1;
integer b = a;
integer c = TRUE;
float f = +1.5;
vector v = <1.0, -2.0, 3.0>;
list l = [1, "x", <1.0, 2.0, 3.0>, b];
default { state_entry() { } }
`, defs);
		expect(msgs.some(m => m.includes('Global initializer must'))).toBe(false);
	});

	it('rejects expressions that SL does not allow in global initializers', async () => {
		const defs = await loadTestDefs();
		const msgs = messagesFor(`
integer a = 1 + 2;
integer b = llRound(1.2);
integer c = (integer)1.2;
integer d = (1);
default { state_entry() { } }
`, defs);
		const globalInitializerErrors = msgs.filter(m => m.includes('Global initializer must') && m.includes('LSL000'));
		expect(globalInitializerErrors.length).toBe(4);
	});

	it('does not resolve a global inside its own initializer', async () => {
		const defs = await loadTestDefs();
		const msgs = messagesFor(`
integer a = a;
default { state_entry() { } }
`, defs);
		expect(msgs.some(m => m.includes('Unknown identifier a') && m.includes('LSL001'))).toBe(true);
	});
});
