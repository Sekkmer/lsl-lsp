import { describe, it, expect } from 'vitest';
import { TextDocument } from 'vscode-languageserver-textdocument';
import path from 'node:path';
import { loadTestDefs } from './loadDefs.testutil';
import { runPipeline } from './testUtils';
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
});
