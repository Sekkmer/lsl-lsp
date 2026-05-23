import { describe, it, expect } from 'vitest';
import { docFrom, runPipeline } from './testUtils';
import { lslSignatureHelp } from '../src/completions';
import { loadTestDefs } from './loadDefs.testutil';
import type { DefFunction } from '../src/defs';

describe('signature help', async () => {
	const defs = await loadTestDefs();

	it('nested calls: shows inner function help and correct active param', () => {
		// Inner call: llGetSubString("abc", 0, 1) inside llOwnerSay(...)
		const code = 'default { state_entry() { llOwnerSay(llGetSubString("abc", 0, 1)); } }';
		const doc = docFrom(code);
		const { analysis, pre } = runPipeline(doc, defs);
		// Place cursor on the 0 (second parameter index 1)
		const pos = doc.positionAt(code.indexOf('0'));
		const sh = lslSignatureHelp(doc, { textDocument: { uri: doc.uri }, position: pos }, defs, analysis, pre);
		expect(sh).toBeTruthy();
		// Should target the inner function
		const sig = sh!.signatures[sh!.activeSignature!].label;
		expect(sig).toMatch(/llGetSubString\s*\(/);
		// And active parameter should be index 1 (the 0 argument)
		expect(sh!.activeParameter).toBe(1);
	});

	it('overload selection: chooses 2-arg overload when cursor is on 2nd arg', async () => {
		const defs2 = await loadTestDefs();
		// Inject synthetic overloads for testing
		const name = 'testOver';
		const overloads: DefFunction[] = [
			{
				name,
				returns: 'integer',
				doc: 'one-arg overload',
				params: [{ type: 'integer', name: 'a', doc: 'first' }]
			},
			{
				name,
				returns: 'integer',
				doc: 'two-arg overload',
				params: [
					{ type: 'integer', name: 'a', doc: 'first' },
					{ type: 'string', name: 'b', doc: 'second' }
				]
			}
		];
		defs2.funcs.set(name, overloads);

		const code = 'default { state_entry() { integer x = testOver(1, "x"); } }';
		const doc = docFrom(code);
		const { analysis, pre } = runPipeline(doc, defs2);
		const pos = doc.positionAt(code.indexOf('"x"') + 1);
		const sh = lslSignatureHelp(doc, { textDocument: { uri: doc.uri }, position: pos }, defs2, analysis, pre);
		expect(sh).toBeTruthy();
		const sig = sh!.signatures[sh!.activeSignature!].label;
		expect(sig).toMatch(/testOver\s*\(integer a, string b\)/);
		expect(sh!.activeParameter).toBe(1);
	});

	it('complex args: reports mismatch note for numeric where string is expected', async () => {
		const defs3 = await loadTestDefs();
		const code = 'default { state_entry() { llSay(0, 123); } }';
		const doc = docFrom(code);
		const { analysis, pre } = runPipeline(doc, defs3);
		const pos = doc.positionAt(code.indexOf('123') + 1);
		const sh = lslSignatureHelp(doc, { textDocument: { uri: doc.uri }, position: pos }, defs3, analysis, pre);
		expect(sh).toBeTruthy();
		const active = sh!.signatures[sh!.activeSignature!];
		expect(active.label).toMatch(/llSay\s*\(/);
		expect(sh!.activeParameter).toBe(1);
		const paramDoc = active.parameters![sh!.activeParameter!].documentation;
		const docText = typeof paramDoc === 'string' ? paramDoc : (paramDoc?.value ?? '');
		expect(docText).toMatch(/Expected\s+string,\s+got\s+integer/);
	});

	it('macro alias: #define echo llOwnerSay resolves to llOwnerSay signature', async () => {
		const defs4 = await loadTestDefs();
		const code = '#define echo llOwnerSay\ndefault { state_entry() { echo(0, "hi"); } }';
		const doc = docFrom(code);
		const { analysis, pre } = runPipeline(doc, defs4);
		const pos = doc.positionAt(code.indexOf('"hi"') + 2);
		const sh = lslSignatureHelp(doc, { textDocument: { uri: doc.uri }, position: pos }, defs4, analysis, pre);
		expect(sh).toBeTruthy();
		const sig = sh!.signatures[sh!.activeSignature!].label;
		expect(sig).toMatch(/llOwnerSay\s*\(/);
		// llOwnerSay has a single parameter; activeParameter is clamped to 0 even when cursor is on 2nd arg
		expect(sh!.activeParameter).toBe(0);
	});
});
