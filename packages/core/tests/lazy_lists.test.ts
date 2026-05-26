import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { emitScript } from '../src/ast/emit';
import { loadDefs } from '../src/defs';
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
string acceptString(string value) { return value; }
key acceptKey(key value) { return value; }
default {
	state_entry() {
		integer x = (integer)L[0];
		string y = (string)L[1];
		list z = L[2];
		integer inferredInteger = L[4];
		vector inferredVector = (L[5]);
		llOwnerSay(L[6]);
		acceptString(L[7]);
		acceptKey(L[8]);
		llGetSubString(L[9], L[10], L[11]);
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
		expect(rendered).toContain('integer inferredInteger=llList2Integer(L,4);');
		expect(rendered).toContain('vector inferredVector=llList2Vector(L,5);');
		expect(rendered).toContain('llOwnerSay(llList2String(L,6));');
		expect(rendered).toContain('acceptString(llList2String(L,7));');
		expect(rendered).toContain('acceptKey(llList2Key(L,8));');
		expect(rendered).toContain('llGetSubString(llList2String(L,9),llList2Integer(L,10),llList2Integer(L,11));');
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

	it('uses official builtin signatures for bare lazy-list call arguments', async () => {
		const defs = await loadDefs(join(__dirname, '..', '..', '..', 'third_party', 'lsl-definitions', 'lsl_definitions.yaml'));
		const doc = docFrom(`
// lsl-lsp extensions: lazy-lists
list L = [];
default {
	state_entry() {
		llMessageLinked(L[0], L[1], L[2], L[3]);
	}
}
`);
		const { analysis, script } = runPipeline(doc, defs);
		expect(analysis.diagnostics.some(d => d.code === 'LSL011')).toBe(false);
		expect(emitScript(script)).toContain('llMessageLinked(llList2Integer(L,0),llList2Integer(L,1),llList2String(L,2),llList2Key(L,3));');
	});
});
