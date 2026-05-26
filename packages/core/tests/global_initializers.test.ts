import { describe, it, expect } from 'vitest';
import { docFrom, runPipeline } from './testUtils';
import { loadTestDefs } from './loadDefs.testutil';
import { emitScript } from '../src/ast/emit';

type PipelineOptions = Parameters<typeof runPipeline>[2];

function messagesFor(code: string, defs: Awaited<ReturnType<typeof loadTestDefs>>, opts?: PipelineOptions) {
	const doc = docFrom(code, 'file:///global_initializers.lsl');
	const { analysis } = runPipeline(doc, defs, opts);
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

	it('folds const global expressions when the extension is enabled', async () => {
		const defs = await loadTestDefs();
		const doc = docFrom(`
// lsl-lsp extensions: const-globals
integer a = 1 | 2;
integer b = llAbs(-5);
float f = (float)(1 + 2);
vector v = <1, 2, 3> * 2;
list l = [1 + 2, "a" + "b", v];
default { state_entry() { } }
`, 'file:///global_initializers.lsl');
		const { analysis, script } = runPipeline(doc, defs);
		const msgs = analysis.diagnostics.map(d => `${d.message} @${d.code}`);
		expect(msgs.some(m => m.includes('Global initializer must'))).toBe(false);
		expect(emitScript(script)).toContain('integer a=3;');
		expect(emitScript(script)).toContain('integer b=5;');
		expect(emitScript(script)).toContain('float f=3.0;');
		expect(emitScript(script)).toContain('vector v=<2.0,4.0,6.0>;');
		expect(emitScript(script)).toContain('list l=[3,"ab",<2.0,4.0,6.0>];');
	});

	it('keeps non-foldable const global expressions invalid with the extension enabled', async () => {
		const defs = await loadTestDefs();
		const msgs = messagesFor(`
// lsl-lsp extensions: const-globals
integer a = unknown + 1;
default { state_entry() { } }
`, defs);
		expect(msgs.some(m => m.includes('Global initializer must') && m.includes('LSL000'))).toBe(true);
	});

	it('does not allow side-effect expressions in const globals', async () => {
		const defs = await loadTestDefs();
		const msgs = messagesFor(`
// lsl-lsp extensions: const-globals
integer a = 1;
integer b = ++a;
default { state_entry() { } }
`, defs);
		expect(msgs.some(m => m.includes('Global initializer must') && m.includes('LSL000'))).toBe(true);
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
