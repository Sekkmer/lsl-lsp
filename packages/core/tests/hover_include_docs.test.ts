import { describe, it, expect } from 'vitest';
import path from 'node:path';
import fs from 'node:fs/promises';
import { docFrom, runPipeline, hoverToString } from './testUtils';
import { lslHover } from '../src/hover';
import { loadTestDefs } from './loadDefs.testutil';

function tmpFile(rel: string, contents: string) {
	const base = path.join(__dirname, 'tmp_includes');
	return {
		path: path.join(base, rel),
		async write() {
			await fs.mkdir(base, { recursive: true });
			await fs.writeFile(this.path, contents, 'utf8');
			return this.path;
		}
	};
}

describe('hover: include docs for functions/globals', async () => {
	const defs = await loadTestDefs();

	it('shows /** */ doc above included function', async () => {
		const header = tmpFile('with_docs.lslh', [
			'/**',
			' * Adds two numbers (include).',
			' */',
			'integer addi(integer a, integer b) { return a + b; }',
		].join('\n'));
		const includeDir = path.dirname(await header.write());
		const code = `#include "${path.basename(header.path)}"\ninteger z = addi(1,2);\n`;
		const doc = docFrom(code, 'file:///proj/hover_inc_func.lsl');
		const { analysis, pre } = runPipeline(doc, defs, { includePaths: [includeDir] });
		const hoverPos = doc.positionAt(code.indexOf('addi(') + 1);
		const hv = lslHover(doc, { position: hoverPos }, defs, analysis, pre);
		expect(hv).toBeTruthy();
		const md = hoverToString(hv!);
		expect(md).toContain('integer addi(integer a, integer b)');
		expect(md).toMatch(/Adds two numbers \(include\)\./);
	});

	it('shows /* */ doc above included global', async () => {
		const header = tmpFile('with_global_doc.lslh', [
			'/* global in header */',
			'integer GLOB_X;',
		].join('\n'));
		const includeDir = path.dirname(await header.write());
		const code = `#include "${path.basename(header.path)}"\ninteger y = GLOB_X;\n`;
		const doc = docFrom(code, 'file:///proj/hover_inc_global.lsl');
		const { analysis, pre } = runPipeline(doc, defs, { includePaths: [includeDir] });
		const hoverPos = doc.positionAt(code.indexOf('GLOB_X') + 2);
		const hv = lslHover(doc, { position: hoverPos }, defs, analysis, pre);
		expect(hv).toBeTruthy();
		const md = hoverToString(hv!);
		expect(md).toContain('integer GLOB_X');
		expect(md).toMatch(/global in header/);
	});

	it('shows // comment above included macro', async () => {
		const header = tmpFile('with_macro_doc.lslh', [
			'// macro adds stuff',
			'#define ADDX(x,y) ((x)+(y))',
			'integer USE = ADDX(1,2);'
		].join('\n'));
		const includeDir = path.dirname(await header.write());
		const code = `#include "${path.basename(header.path)}"\ninteger z = ADDX(3,4);\n`;
		const doc = docFrom(code, 'file:///proj/hover_inc_macro.lsl');
		const { analysis, pre } = runPipeline(doc, defs, { includePaths: [includeDir] });
		const hoverPos = doc.positionAt(code.indexOf('ADDX(3') + 2);
		const hv = lslHover(doc, { position: hoverPos }, defs, analysis, pre);
		expect(hv).toBeTruthy();
		const md = hoverToString(hv!);
		expect(md).toContain(`From: ${header.path}`);
		expect(md).toMatch(/macro adds stuff/);
	});

	it('shows include source for macros shadowed by inactive local defines', async () => {
		const header = tmpFile('inactive_local_macro_source.lslh', '#define ACTIVE_SOURCE_MACRO 7\n');
		const includeDir = path.dirname(await header.write());
		const code = [
			`#include "${path.basename(header.path)}"`,
			'#if 0',
			'#define ACTIVE_SOURCE_MACRO 8',
			'#endif',
			'default { state_entry() { integer y = ACTIVE_SOURCE_MACRO; } }',
		].join('\n');
		const doc = docFrom(code, 'file:///proj/hover_inactive_local_macro.lsl');
		const { analysis, pre } = runPipeline(doc, defs, { includePaths: [includeDir] });
		const hv = lslHover(doc, { position: doc.positionAt(code.lastIndexOf('ACTIVE_SOURCE_MACRO') + 2) }, defs, analysis, pre);
		const md = hoverToString(hv!);

		expect(md).toContain(`From: ${header.path}`);
	});

	it('refreshes include docs after content changes without an mtime change', async () => {
		const base = path.join(__dirname, 'tmp_includes');
		await fs.mkdir(base, { recursive: true });
		const header = path.join(base, 'with_fresh_doc.lslh');
		await fs.writeFile(header, [
			'// old doc',
			'integer FRESH_DOC;',
		].join('\n'), 'utf8');

		const code = `#include "${path.basename(header)}"\ninteger y = FRESH_DOC;\n`;
		const doc = docFrom(code, 'file:///proj/hover_fresh_doc.lsl');
		const first = runPipeline(doc, defs, { includePaths: [base] });
		let hoverPos = doc.positionAt(code.indexOf('FRESH_DOC') + 2);
		let hv = lslHover(doc, { position: hoverPos }, defs, first.analysis, first.pre);
		expect(hoverToString(hv!)).toMatch(/old doc/);

		const before = await fs.stat(header);
		await fs.writeFile(header, [
			'// new doc',
			'integer FRESH_DOC;',
		].join('\n'), 'utf8');
		await fs.utimes(header, before.atime, before.mtime);

		const second = runPipeline(doc, defs, { includePaths: [base] });
		hoverPos = doc.positionAt(code.indexOf('FRESH_DOC') + 2);
		hv = lslHover(doc, { position: hoverPos }, defs, second.analysis, second.pre);
		const md = hoverToString(hv!);
		expect(md).toMatch(/new doc/);
		expect(md).not.toMatch(/old doc/);
	});

	it('does not attach inactive include docs to local symbols', async () => {
		const header = tmpFile('inactive_shadow_docs.lslh', [
			'#if 0',
			'/** inactive include function doc */',
			'integer LocalShadow(integer x) { return x; }',
			'// inactive include macro doc',
			'#define LOCAL_SHADOW 1',
			'#endif',
		].join('\n'));
		const includeDir = path.dirname(await header.write());
		const code = [
			`#include "${path.basename(header.path)}"`,
			'integer LocalShadow(integer x) { return x; }',
			'#define LOCAL_SHADOW 2',
			'default { state_entry() { integer y = LocalShadow(LOCAL_SHADOW); } }',
		].join('\n');
		const doc = docFrom(code, 'file:///proj/hover_inactive_shadow.lsl');
		const { analysis, pre } = runPipeline(doc, defs, { includePaths: [includeDir] });

		const funcHover = lslHover(doc, { position: doc.positionAt(code.lastIndexOf('LocalShadow(') + 2) }, defs, analysis, pre);
		expect(hoverToString(funcHover!)).not.toContain('inactive include function doc');

		const macroHover = lslHover(doc, { position: doc.positionAt(code.lastIndexOf('LOCAL_SHADOW') + 2) }, defs, analysis, pre);
		expect(hoverToString(macroHover!)).not.toContain('inactive include macro doc');
	});

	it('does not scan files from inactive include directives', async () => {
		const header = tmpFile('inactive_include_shadow_docs.lslh', [
			'/** inactive include target function doc */',
			'integer LocalInactiveInclude(integer x) { return x; }',
		].join('\n'));
		const includePath = await header.write();
		const code = [
			'#if 0',
			`#include "${includePath}"`,
			'#endif',
			'integer LocalInactiveInclude(integer x) { return x; }',
			'default { state_entry() { integer y = LocalInactiveInclude(1); } }',
		].join('\n');
		const doc = docFrom(code, 'file:///proj/hover_inactive_include_shadow.lsl');
		const { analysis, pre } = runPipeline(doc, defs);

		const funcHover = lslHover(doc, { position: doc.positionAt(code.lastIndexOf('LocalInactiveInclude(') + 2) }, defs, analysis, pre);
		expect(hoverToString(funcHover!)).not.toContain('inactive include target function doc');
	});
});
