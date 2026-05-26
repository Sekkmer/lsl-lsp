import { describe, expect, it } from 'vitest';
import { emitScript } from '../src/ast/emit';
import { docFrom, runPipeline } from './testUtils';
import { loadTestDefs } from './loadDefs.testutil';

describe('switch extension', () => {
	it('keeps switch invalid when the extension is disabled', async () => {
		const defs = await loadTestDefs();
		const doc = docFrom('integer mode; default { state_entry() { switch (mode) { case 1: llOwnerSay("one"); break; } } }');
		const { analysis } = runPipeline(doc, defs);
		expect(analysis.diagnostics.some(d => d.code === 'LSL000')).toBe(true);
	});

	it('lowers switch with fallthrough and break to standard LSL', async () => {
		const defs = await loadTestDefs();
		const doc = docFrom(`
// lsl-lsp extensions: switch
integer mode;
default {
	state_entry() {
		switch (mode) {
			case 1:
				llOwnerSay("one");
				break;
			case 2:
				llOwnerSay("two");
			default:
				llOwnerSay("default");
		}
	}
}
`);
		const { analysis, script } = runPipeline(doc, defs);
		const messages = analysis.diagnostics.map(d => `${d.message} @${d.code}`);
		expect(messages.some(m => m.includes('Unknown jump target'))).toBe(false);
		expect(messages.some(m => m.includes('missing ;'))).toBe(false);
		const rendered = emitScript(script);
		expect(rendered).not.toContain('switch(');
		expect(rendered).toContain('if(mode==1)jump __lsl_switch_0_case_0;');
		expect(rendered).toContain('if(mode==2)jump __lsl_switch_0_case_1;');
		expect(rendered).toContain('jump __lsl_switch_0_default;');
		expect(rendered).toContain('@__lsl_switch_0_case_0;');
		expect(rendered).toContain('jump __lsl_switch_0_break;');
		expect(rendered).toContain('@__lsl_switch_0_default;');
		expect(rendered).toContain('@__lsl_switch_0_break;');
	});

	it('enables switch through Firestorm compatibility macros', async () => {
		const defs = await loadTestDefs();
		const doc = docFrom('#define USE_SWITCHES\ninteger mode; default { state_entry() { switch (mode) { case 1: llOwnerSay("one"); break; } } }');
		const { analysis, script } = runPipeline(doc, defs);
		expect(analysis.diagnostics.some(d => d.code === 'LSL000')).toBe(false);
		expect(emitScript(script)).toContain('if(mode==1)jump __lsl_switch_0_case_0;');
	});

	it('jumps to the break label when no default case exists', async () => {
		const defs = await loadTestDefs();
		const doc = docFrom(`
// lsl-lsp extensions: switch
integer mode;
default { state_entry() { switch (mode) { case 1: llOwnerSay("one"); } } }
`);
		const { analysis, script } = runPipeline(doc, defs);
		expect(analysis.diagnostics.some(d => d.code === 'LSL000')).toBe(false);
		const rendered = emitScript(script);
		expect(rendered).toContain('if(mode==1)jump __lsl_switch_0_case_0;');
		expect(rendered).toContain('jump __lsl_switch_0_break;');
	});
});
