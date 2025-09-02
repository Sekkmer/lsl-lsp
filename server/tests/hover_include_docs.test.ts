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
			'integer addi(integer a, integer b);',
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
});
