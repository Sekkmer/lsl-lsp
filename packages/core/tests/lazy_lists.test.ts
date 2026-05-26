import { describe, expect, it } from 'vitest';
import { emitScript } from '../src/ast/emit';
import { docFrom, runPipeline } from './testUtils';
import { loadTestDefs } from './loadDefs.testutil';

describe('lazy list extension', () => {
	it('keeps bracket indexing invalid when the extension is disabled', async () => {
		const defs = await loadTestDefs();
		const doc = docFrom('list L; default { state_entry() { integer x = (integer)L[0]; } }');
		const { analysis } = runPipeline(doc, defs);
		expect(analysis.diagnostics.some(d => d.code === 'LSL000' && /Indexing with \[\] is not supported/.test(d.message))).toBe(true);
	});

	it('lowers typed reads and writes to standard LSL', async () => {
		const defs = await loadTestDefs();
		const doc = docFrom(`
// lsl-lsp extensions: lazy-lists
list L = [];
default {
	state_entry() {
		integer x = (integer)L[0];
		string y = (string)L[1];
		list z = L[2];
		L[3] = "new";
	}
}
`);
		const { analysis, script } = runPipeline(doc, defs);
		const messages = analysis.diagnostics.map(d => `${d.message} @${d.code}`);
		expect(messages.some(m => /Indexing with \[\] is not supported/.test(m))).toBe(false);
		expect(messages.some(m => /Invalid assignment target/.test(m))).toBe(false);
		const rendered = emitScript(script);
		expect(rendered).toContain('integer x=llList2Integer(L,0);');
		expect(rendered).toContain('string y=llList2String(L,1);');
		expect(rendered).toContain('list z=llList2List(L,2,2);');
		expect(rendered).toContain('L=__lsl_lsp_lazy_list_set(L,3,["new"]);');
		expect(rendered).toContain('list __lsl_lsp_lazy_list_set(list L,integer i,list v)');
		expect(rendered).toContain('return llListReplaceList(L,v,i,i);');
	});

	it('enables lazy lists through Firestorm compatibility macros', async () => {
		const defs = await loadTestDefs();
		const doc = docFrom('#define USE_LAZY_LISTS\nlist L; default { state_entry() { vector v = (vector)L[0]; } }');
		const { analysis, script } = runPipeline(doc, defs);
		expect(analysis.diagnostics.some(d => d.code === 'LSL000' && /Indexing with \[\]/.test(d.message))).toBe(false);
		expect(emitScript(script)).toContain('vector v=llList2Vector(L,0);');
	});
});
