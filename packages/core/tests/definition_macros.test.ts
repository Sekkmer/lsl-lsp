import { describe, it, expect } from 'vitest';
import { TextDocument } from '../src/protocol';
import path from 'node:path';
import { loadTestDefs } from './loadDefs.testutil';
import { runPipeline, docFrom } from './testUtils';
import { gotoDefinition } from '../src/symbols';
import { resolveSymbolAt } from '../src/resolver';

describe('goto definition for macros', () => {
	it('jumps to local #define for object-like macro', async () => {
		const code = '#define FOO 123\ninteger x = FOO;\n';
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
		const code = '#define ADD(a,b) ((a)+(b))\ninteger x = ADD(1,2);\n';
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
		const code = '#include "macros.lslh"\ninteger x = MY_CONST;\n';
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
		// Use a unique subdirectory to avoid concurrent test interference
		const base = path.join(__dirname, 'tmp_includes', 'definition_macros');
		await fs.mkdir(base, { recursive: true });
		const b = path.join(base, 'b.lslh');
		const a = path.join(base, 'a.lslh');
		await fs.writeFile(b, '#define MC 42\ninteger Foo(integer x) { return x; }\n', 'utf8');
		await fs.writeFile(a, '#include "b.lslh"\n', 'utf8');
		const code = '#include "a.lslh"\ninteger y = MC;\ninteger z = Foo(1);\n';
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

	it('does not jump to commented declarations inside included files', async () => {
		const fs = await import('node:fs/promises');
		const base = path.join(__dirname, 'tmp_includes', 'definition_comments');
		await fs.mkdir(base, { recursive: true });
		await fs.writeFile(path.join(base, 'comments.lslh'), [
			'// integer llOwnerSay(string msg);',
			'/*',
			'integer llSay(integer channel, string msg);',
			'*/',
			'string text = "integer llGetOwner();";',
		].join('\n'), 'utf8');
		const code = '#include "comments.lslh"\ndefault { state_entry() { llOwnerSay("hi"); } }\n';
		const doc = docFrom(code, 'file:///proj/goto_comment_decl.lsl');
		const defs = await loadTestDefs();
		const { analysis, pre } = runPipeline(doc, defs, { includePaths: [base] });
		const callLine = code.split(/\r?\n/)[1]!;
		const pos = { line: 1, character: callLine.indexOf('llOwnerSay') + 1 };
		const loc = gotoDefinition(doc, pos, analysis, pre, defs);
		expect(loc).toBeNull();
	});

	it('does not treat invalid function prototypes as include definitions', async () => {
		const fs = await import('node:fs/promises');
		const base = path.join(__dirname, 'tmp_includes', 'definition_prototypes');
		await fs.mkdir(base, { recursive: true });
		const header = path.join(base, 'api.lslh');
		await fs.writeFile(header, 'integer Foo(integer x);\n', 'utf8');
		const code = '#include "api.lslh"\ndefault { state_entry() { Foo(1); } }\n';
		const doc = docFrom(code, 'file:///definition-invalid-prototype.lsl');
		const defs = await loadTestDefs();
		const { analysis, pre } = runPipeline(doc, defs, { includePaths: [base] });
		const callLine = code.split(/\r?\n/)[1]!;
		const pos = { line: 1, character: callLine.indexOf('Foo') + 1 };
		const loc = gotoDefinition(doc, pos, analysis, pre, defs);
		expect(loc).toBeNull();
		expect(analysis.diagnostics.some(d => d.message.includes('expected \'{\' for function body'))).toBe(true);
	});

	it('refreshes include definitions when file content changes without an mtime change', async () => {
		const fs = await import('node:fs/promises');
		const base = path.join(__dirname, 'tmp_includes', 'definition_stale_cache');
		await fs.mkdir(base, { recursive: true });
		const header = path.join(base, 'api.lslh');
		await fs.writeFile(header, 'integer Foo(integer x) { return x; }\n', 'utf8');

		const code1 = '#include "api.lslh"\ndefault { state_entry() { Foo(1); } }\n';
		const doc1 = docFrom(code1, 'file:///definition-cache-1.lsl');
		const defs = await loadTestDefs();
		const first = runPipeline(doc1, defs, { includePaths: [base] });
		const line1 = code1.split(/\r?\n/)[1]!;
		const loc1 = gotoDefinition(doc1, { line: 1, character: line1.indexOf('Foo') + 1 }, first.analysis, first.pre, defs);
		expect(loc1?.uri.endsWith('api.lslh')).toBe(true);

		const before = await fs.stat(header);
		await fs.writeFile(header, 'integer Bar(integer x) { return x; }\n', 'utf8');
		await fs.utimes(header, before.atime, before.mtime);

		const code2 = '#include "api.lslh"\ndefault { state_entry() { Bar(1); } }\n';
		const doc2 = docFrom(code2, 'file:///definition-cache-2.lsl');
		const second = runPipeline(doc2, defs, { includePaths: [base] });
		const line2 = code2.split(/\r?\n/)[1]!;
		const loc2 = gotoDefinition(doc2, { line: 1, character: line2.indexOf('Bar') + 1 }, second.analysis, second.pre, defs);
		expect(loc2?.uri.endsWith('api.lslh')).toBe(true);
		expect(second.analysis.diagnostics.some(d => d.message.includes('Undefined function: Bar'))).toBe(false);
	});

	it('does not jump to inactive definitions inside included files', async () => {
		const fs = await import('node:fs/promises');
		const base = path.join(__dirname, 'tmp_includes', 'definition_inactive');
		await fs.mkdir(base, { recursive: true });
		await fs.writeFile(path.join(base, 'api.lslh'), [
			'#if 0',
			'#define HIDDEN_CONST 7',
			'integer Hidden(integer x) { return x; }',
			'#endif',
		].join('\n'), 'utf8');
		const code = '#include "api.lslh"\ndefault { state_entry() { integer a = HIDDEN_CONST; Hidden(1); } }\n';
		const doc = docFrom(code, 'file:///definition-inactive.lsl');
		const defs = await loadTestDefs();
		const { analysis, pre } = runPipeline(doc, defs, { includePaths: [base] });
		const line = code.split(/\r?\n/)[1]!;

		const macroLoc = gotoDefinition(doc, { line: 1, character: line.indexOf('HIDDEN_CONST') + 1 }, analysis, pre, defs);
		const funcLoc = gotoDefinition(doc, { line: 1, character: line.indexOf('Hidden') + 1 }, analysis, pre, defs);

		expect(macroLoc).toBeNull();
		expect(funcLoc).toBeNull();
	});

	it('classifies parenthesized include macros as object-like definitions', async () => {
		const fs = await import('node:fs/promises');
		const base = path.join(__dirname, 'tmp_includes', 'definition_macro_kind');
		await fs.mkdir(base, { recursive: true });
		await fs.writeFile(path.join(base, 'api.lslh'), '#define PARENED (1 + 1)\r\n#define CALL(x) (x)\r\n', 'utf8');
		const code = '#include "api.lslh"\ninteger a = PARENED;\ninteger b = CALL(1);\n';
		const doc = docFrom(code, 'file:///definition-macro-kind.lsl');
		const defs = await loadTestDefs();
		const { analysis, pre } = runPipeline(doc, defs, { includePaths: [base] });

		const line1 = code.split(/\r?\n/)[1]!;
		const line2 = code.split(/\r?\n/)[2]!;
		const parened = resolveSymbolAt(doc, { line: 1, character: line1.indexOf('PARENED') + 1 }, analysis, pre, defs);
		const call = resolveSymbolAt(doc, { line: 2, character: line2.indexOf('CALL') + 1 }, analysis, pre, defs);

		expect(parened?.kind).toBe('macro-obj');
		expect(call?.kind).toBe('macro-func');
	});

	it('prefers local variables over included globals with the same name', async () => {
		const fs = await import('node:fs/promises');
		const base = path.join(__dirname, 'tmp_includes', 'definition_local_shadow');
		await fs.mkdir(base, { recursive: true });
		await fs.writeFile(path.join(base, 'api.lslh'), 'integer SHADOWED_VALUE;\n', 'utf8');
		const code = [
			'#include "api.lslh"',
			'default {',
			'  state_entry() {',
			'    integer SHADOWED_VALUE = 1;',
			'    integer y = SHADOWED_VALUE;',
			'  }',
			'}',
		].join('\n');
		const doc = docFrom(code, 'file:///definition-local-shadow.lsl');
		const defs = await loadTestDefs();
		const { analysis, pre } = runPipeline(doc, defs, { includePaths: [base] });
		const useLine = code.split(/\r?\n/)[4]!;
		const target = resolveSymbolAt(doc, { line: 4, character: useLine.indexOf('SHADOWED_VALUE') + 1 }, analysis, pre, defs);

		expect(target?.from).toBe('local');
		expect(target?.kind).toBe('var');
		expect(target && 'range' in target ? target.range.start.line : undefined).toBe(3);
	});

	it('does not jump to inactive local macros when an include macro is active', async () => {
		const fs = await import('node:fs/promises');
		const base = path.join(__dirname, 'tmp_includes', 'definition_inactive_local_macro');
		await fs.mkdir(base, { recursive: true });
		await fs.writeFile(path.join(base, 'api.lslh'), '#define ACTIVE_MACRO 1\n', 'utf8');
		const code = [
			'#include "api.lslh"',
			'#if 0',
			'#define ACTIVE_MACRO 2',
			'#endif',
			'integer y = ACTIVE_MACRO;',
		].join('\n');
		const doc = docFrom(code, 'file:///definition-inactive-local-macro.lsl');
		const defs = await loadTestDefs();
		const { analysis, pre } = runPipeline(doc, defs, { includePaths: [base] });
		const useLine = code.split(/\r?\n/)[4]!;
		const target = resolveSymbolAt(doc, { line: 4, character: useLine.indexOf('ACTIVE_MACRO') + 1 }, analysis, pre, defs);

		expect(target?.from).toBe('include');
		expect(target && 'uri' in target ? target.uri.endsWith('api.lslh') : false).toBe(true);
	});

	it('resolves transitive include definitions through include paths', async () => {
		const fs = await import('node:fs/promises');
		const base = path.join(__dirname, 'tmp_includes', 'definition_transitive_include_path');
		const nestedDir = path.join(base, 'nested');
		await fs.mkdir(nestedDir, { recursive: true });
		await fs.writeFile(path.join(base, 'shared.lslh'), 'integer ViaIncludePath(integer x) { return x; }\n', 'utf8');
		await fs.writeFile(path.join(nestedDir, 'api.lslh'), '#include "shared.lslh"\n', 'utf8');
		const code = '#include "nested/api.lslh"\ndefault { state_entry() { ViaIncludePath(1); } }\n';
		const doc = docFrom(code, 'file:///definition-transitive-include-path.lsl');
		const defs = await loadTestDefs();
		const { analysis, pre } = runPipeline(doc, defs, { includePaths: [base] });
		const line = code.split(/\r?\n/)[1]!;
		const loc = gotoDefinition(doc, { line: 1, character: line.indexOf('ViaIncludePath') + 1 }, analysis, pre, defs);

		expect(loc?.uri.endsWith('shared.lslh')).toBe(true);
	});

	it('resolves include definitions after more than sixteen include files', async () => {
		const fs = await import('node:fs/promises');
		const base = path.join(__dirname, 'tmp_includes', 'definition_many_includes');
		await fs.mkdir(base, { recursive: true });
		const includes: string[] = [];
		for (let i = 0; i < 20; i++) {
			const name = `many_${i}.lslh`;
			includes.push(`#include "${name}"`);
			await fs.writeFile(path.join(base, name), i === 19 ? 'integer LateIncludeSymbol(integer x) { return x; }\n' : `integer Filler${i};\n`, 'utf8');
		}
		const code = `${includes.join('\n')}\ndefault { state_entry() { LateIncludeSymbol(1); } }\n`;
		const doc = docFrom(code, 'file:///definition-many-includes.lsl');
		const defs = await loadTestDefs();
		const { analysis, pre } = runPipeline(doc, defs, { includePaths: [base] });
		const line = code.split(/\r?\n/)[20]!;
		const loc = gotoDefinition(doc, { line: 20, character: line.indexOf('LateIncludeSymbol') + 1 }, analysis, pre, defs);

		expect(loc?.uri.endsWith('many_19.lslh')).toBe(true);
	});
});
