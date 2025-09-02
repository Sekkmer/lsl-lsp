import { describe, it, expect } from 'vitest';
import { TextDocument } from 'vscode-languageserver-textdocument';
import path from 'node:path';
import { loadTestDefs } from './loadDefs.testutil';
import { runPipeline, docFrom } from './testUtils';
import { gotoDefinition } from '../src/symbols';

describe('goto definition for macros', () => {
	it('jumps to local #define for object-like macro', async () => {
		const code = `#define FOO 123\ninteger x = FOO;\n`;
		const doc = TextDocument.create('file:///local.lsl', 'lsl', 1, code);
		const defs = await loadTestDefs();
		const { analysis, pre } = runPipeline(doc, defs);
		// Position on FOO
		const pos = { line: 1, character: code.split(/\r?\n/)[1]!.indexOf('FOO') + 1 };
		const loc = gotoDefinition(doc, pos, analysis, pre);
		expect(loc?.uri).toBe(doc.uri);
		expect(loc?.range.start.line).toBe(0);
	});

	it('jumps to local #define for function-like macro', async () => {
		const code = `#define ADD(a,b) ((a)+(b))\ninteger x = ADD(1,2);\n`;
		const doc = TextDocument.create('file:///local2.lsl', 'lsl', 1, code);
		const defs = await loadTestDefs();
		const { analysis, pre } = runPipeline(doc, defs);
		const pos = { line: 1, character: code.split(/\r?\n/)[1]!.indexOf('ADD') + 1 };
		const loc = gotoDefinition(doc, pos, analysis, pre);
		expect(loc?.uri).toBe(doc.uri);
		expect(loc?.range.start.line).toBe(0);
	});

	it('jumps to #define inside included file when available', async () => {
		const includesDir = path.join(__dirname, 'fixtures', 'includes');
		const code = `#include "macros.lslh"\ninteger x = MY_CONST;\n`;
		const doc = TextDocument.create('file:///withinclude.lsl', 'lsl', 1, code);
		const defs = await loadTestDefs();
		const { analysis, pre } = runPipeline(doc, defs, { includePaths: [includesDir] });
		const pos = { line: 1, character: code.split(/\r?\n/)[1]!.indexOf('MY_CONST') + 1 };
		const loc = gotoDefinition(doc, pos, analysis, pre);
		expect(loc).toBeTruthy();
		// Should point to included file location
		expect(loc!.uri.endsWith('macros.lslh')).toBe(true);
	});

	it('jumps to symbols via transitive includes (macro and function)', async () => {
		const fs = await import('node:fs/promises');
		const base = path.join(__dirname, 'tmp_includes');
		await fs.mkdir(base, { recursive: true });
		const b = path.join(base, 'b.lslh');
		const a = path.join(base, 'a.lslh');
		await fs.writeFile(b, `#define MC 42\ninteger Foo(integer x);\n`, 'utf8');
		await fs.writeFile(a, `#include "b.lslh"\n`, 'utf8');
		const code = `#include "a.lslh"\ninteger y = MC;\ninteger z = Foo(1);\n`;
		const doc = docFrom(code, 'file:///proj/goto_transitive.lsl');
		const defs = await loadTestDefs();
		const { analysis, pre } = runPipeline(doc, defs, { includePaths: [base] });
		// Jump on MC
		const line1 = code.split(/\r?\n/)[1]!;
		const posMc = { line: 1, character: line1.indexOf('MC') + 1 };
		const locMc = gotoDefinition(doc, posMc, analysis, pre);
		expect(locMc).toBeTruthy();
		expect(locMc!.uri.endsWith('b.lslh')).toBe(true);
		// Jump on Foo
		const line2 = code.split(/\r?\n/)[2]!;
		const posFoo = { line: 2, character: line2.indexOf('Foo') + 1 };
		const locFoo = gotoDefinition(doc, posFoo, analysis, pre);
		expect(locFoo).toBeTruthy();
		expect(locFoo!.uri.endsWith('b.lslh')).toBe(true);
	});
});
