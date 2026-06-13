import { describe, it, expect } from 'vitest';
import { docFrom, hoverToString, runPipeline } from './testUtils';
import { lslSignatureHelp } from '../src/completions';
import type { DefFunction, Defs } from '../src/defs';
import { lslHover } from '../src/hover';
import { loadTestDefs } from './loadDefs.testutil';

function addIssue6Defs(defs: Defs): void {
	const funcs: DefFunction[] = [
		{
			name: 'llList2String',
			returns: 'string',
			params: [
				{ type: 'list', name: 'listVariable' },
				{ type: 'integer', name: 'index' },
			],
		},
		{
			name: 'llCSV2List',
			returns: 'list',
			params: [{ type: 'string', name: 'text' }],
		},
		{
			name: 'llDumpList2String',
			returns: 'string',
			params: [
				{ type: 'list', name: 'source' },
				{ type: 'string', name: 'separator' },
			],
		},
	];
	for (const fn of funcs) defs.funcs.set(fn.name, [fn]);
}

function signatureLine(markdown: string): string {
	return markdown.split('\n').find(line => /\bll[A-Za-z0-9_]+\(/.test(line)) ?? '';
}

function signatureHelpLabel(result: ReturnType<typeof lslSignatureHelp>): string {
	expect(result).toBeTruthy();
	return result!.signatures[result!.activeSignature!].label;
}

describe('nested call hovers and signatures', async () => {
	const defs = await loadTestDefs();
	addIssue6Defs(defs);

	it('hovers the nested callee under the cursor instead of the enclosing call', () => {
		const code = [
			'default',
			'{',
			'    state_entry()',
			'    {',
			'        llOwnerSay(llList2String(llCSV2List(llDumpList2String(llCSV2List("a,b,c"), ",")),0));',
			'    }',
			'}',
		].join('\n');
		const doc = docFrom(code);
		const { analysis, pre } = runPipeline(doc, defs);

		for (const [name, expected] of [
			['llList2String', 'string llList2String(list listVariable, integer index)'],
			['llCSV2List', 'list llCSV2List(string text)'],
			['llDumpList2String', 'string llDumpList2String(list source, string separator)'],
		] as const) {
			const pos = doc.positionAt(code.indexOf(name) + 2);
			const hover = lslHover(doc, { position: pos }, defs, analysis, pre);
			expect(hover).toBeTruthy();
			expect(signatureLine(hoverToString(hover!))).toBe(expected);
		}
	});

	it('hovers user-defined nested callees instead of the enclosing call', () => {
		const code = [
			'string inner() { return "value"; }',
			'string outer(string value) { return value; }',
			'default { state_entry() { llOwnerSay(outer(inner())); } }',
		].join('\n');
		const doc = docFrom(code);
		const { analysis, pre } = runPipeline(doc, defs);

		const pos = doc.positionAt(code.indexOf('inner()') + 2);
		const hover = lslHover(doc, { position: pos }, defs, analysis, pre);

		expect(hover).toBeTruthy();
		expect(hoverToString(hover!)).toContain('string inner()');
		expect(hoverToString(hover!)).not.toContain('string outer(string value)');
	});

	it('hovers nested macro callees instead of the enclosing call', () => {
		const code = [
			'#define AS_CSV llCSV2List',
			'#define AS_FUNC(text) llCSV2List(text)',
			'default { state_entry() {',
			'    llOwnerSay(llList2String(AS_CSV(AS_FUNC("a,b,c")),0));',
			'} }',
		].join('\n');
		const doc = docFrom(code);
		const { analysis, pre } = runPipeline(doc, defs);

		const aliasHover = lslHover(doc, { position: doc.positionAt(code.indexOf('AS_CSV(') + 2) }, defs, analysis, pre);
		const funcHover = lslHover(doc, { position: doc.positionAt(code.indexOf('AS_FUNC(') + 2) }, defs, analysis, pre);

		expect(aliasHover).toBeTruthy();
		expect(hoverToString(aliasHover!)).toContain('Alias: #define AS_CSV llCSV2List');
		expect(signatureLine(hoverToString(aliasHover!))).toBe('list llCSV2List(string text)');
		expect(funcHover).toBeTruthy();
		expect(hoverToString(funcHover!)).toContain('#define AS_FUNC (text) llCSV2List(text)');
		expect(hoverToString(funcHover!)).not.toContain('string llList2String(list listVariable, integer index)');
	});

	it('keeps signature help on the parent call at a nested first-argument boundary', () => {
		const code = [
			'default',
			'{',
			'    state_entry()',
			'    {',
			'        llOwnerSay(llList2String(llCSV2List(llDumpList2String(llCSV2List("a,b,c"), ",")),0));',
			'    }',
			'}',
		].join('\n');
		const doc = docFrom(code);
		const { analysis, pre } = runPipeline(doc, defs);

		const list2StringPos = doc.positionAt(code.indexOf('llList2String(') + 'llList2String('.length);
		const csv2ListPos = doc.positionAt(code.indexOf('llCSV2List(') + 'llCSV2List('.length);
		const dumpListPos = doc.positionAt(code.indexOf('llDumpList2String(') + 'llDumpList2String('.length);

		expect(signatureHelpLabel(lslSignatureHelp(doc, { textDocument: { uri: doc.uri }, position: list2StringPos }, defs, analysis, pre)))
			.toBe('string llList2String(list listVariable, integer index)');
		expect(signatureHelpLabel(lslSignatureHelp(doc, { textDocument: { uri: doc.uri }, position: csv2ListPos }, defs, analysis, pre)))
			.toBe('list llCSV2List(string text)');
		expect(signatureHelpLabel(lslSignatureHelp(doc, { textDocument: { uri: doc.uri }, position: dumpListPos }, defs, analysis, pre)))
			.toBe('string llDumpList2String(list source, string separator)');
	});

	it('keeps signature help on the parent call when the first argument starts with a macro alias call', () => {
		const code = [
			'#define AS_CSV llCSV2List',
			'default { state_entry() {',
			'    llOwnerSay(llList2String(AS_CSV(llDumpList2String(AS_CSV("a,b,c"), ",")),0));',
			'} }',
		].join('\n');
		const doc = docFrom(code);
		const { analysis, pre } = runPipeline(doc, defs);

		const list2StringPos = doc.positionAt(code.indexOf('llList2String(') + 'llList2String('.length);
		const aliasPos = doc.positionAt(code.indexOf('AS_CSV(') + 'AS_CSV('.length);

		expect(signatureHelpLabel(lslSignatureHelp(doc, { textDocument: { uri: doc.uri }, position: list2StringPos }, defs, analysis, pre)))
			.toBe('string llList2String(list listVariable, integer index)');
		expect(signatureHelpLabel(lslSignatureHelp(doc, { textDocument: { uri: doc.uri }, position: aliasPos }, defs, analysis, pre)))
			.toBe('list llCSV2List(string text)');
	});

	it('keeps signature help on the parent call when the first argument starts with a function-like macro call', () => {
		const code = [
			'#define AS_CSV(text) llCSV2List(text)',
			'default { state_entry() {',
			'    llOwnerSay(llList2String(AS_CSV(llDumpList2String(AS_CSV("a,b,c"), ",")),0));',
			'} }',
		].join('\n');
		const doc = docFrom(code);
		const { analysis, pre } = runPipeline(doc, defs);

		const list2StringPos = doc.positionAt(code.indexOf('llList2String(') + 'llList2String('.length);

		expect(signatureHelpLabel(lslSignatureHelp(doc, { textDocument: { uri: doc.uri }, position: list2StringPos }, defs, analysis, pre)))
			.toBe('string llList2String(list listVariable, integer index)');
	});
});
