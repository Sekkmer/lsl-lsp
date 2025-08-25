import { describe, it, expect } from 'vitest';
import path from 'node:path';
import fs from 'node:fs/promises';
import { docFrom, runPipeline, semToSpans } from './testUtils';
import { semanticTokensLegend } from '../src/semtok';
import { loadDefs } from '../src/defs';

const defsPath = path.join(__dirname, 'fixtures', 'lsl-defs.json');

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

describe('include symbols/macros', () => {
	it('colors and recognizes macros from included header', async () => {
		const header = tmpFile('mydefs.lslh', `#define FOO 123\n#define BAR(x) (x+1)\n`);
		const includeDir = path.dirname(await header.write());
		const code = `#include "${path.basename(header.path)}"\ninteger a = FOO;\ninteger b = BAR(2);\n`;
		const doc = docFrom(code, 'file:///proj/main.lsl');
		const defs = await loadDefs(defsPath);
		const { pre, sem } = runPipeline(doc, defs, { includePaths: [includeDir] });
		// pre should have merged macros
		expect(Object.prototype.hasOwnProperty.call(pre.macros, 'FOO')).toBe(true);
		expect(Object.prototype.hasOwnProperty.call(pre.funcMacros, 'BAR')).toBe(true);
		// semantic tokens should include macro tokens for FOO and BAR
		const spans = semToSpans(doc, sem);
		const macroTypeIndex = (semanticTokensLegend.tokenTypes as string[]).indexOf('macro');
		const macroCount = spans.filter(s => s.type === macroTypeIndex).length;
		expect(macroCount).toBeGreaterThanOrEqual(2);
	});

	it('classifies functions from included headers as function tokens', async () => {
		const header = tmpFile('api.lslh', `integer myFunc(integer x);\n`);
		const includeDir = path.dirname(await header.write());
		const code = `#include "${path.basename(header.path)}"\ninteger z = myFunc(1);\n`;
		const doc = docFrom(code, 'file:///proj/usesFunc.lsl');
		const defs = await loadDefs(defsPath);
		const { sem } = runPipeline(doc, defs, { includePaths: [includeDir] });
		const spans = semToSpans(doc, sem);
		const fnTypeIndex = (semanticTokensLegend.tokenTypes as string[]).indexOf('function');
		expect(spans.some(s => s.type === fnTypeIndex)).toBe(true);
	});

	it('reports missing include as diagnostic', async () => {
		const code = `#include "missing_header.lslh"\ninteger z;\n`;
		const doc = docFrom(code, 'file:///proj/missing.lsl');
		const defs = await loadDefs(defsPath);
		const { pre } = runPipeline(doc, defs, { includePaths: [] });
		expect(pre.missingIncludes.length).toBeGreaterThanOrEqual(1);
	});

	it('recognizes globals from included headers', async () => {
		const header = tmpFile('globals.lslh', `integer GLOB_A;\nfloat GLOB_F = 1.0;\n`);
		const includeDir = path.dirname(await header.write());
		const code = `#include "${path.basename(header.path)}"\ninteger z = GLOB_A;\n`;
		const doc = docFrom(code, 'file:///proj/usesGlobal.lsl');
		const defs = await loadDefs(defsPath);
		const { analysis } = runPipeline(doc, defs, { includePaths: [includeDir] });
		// Ensure no unknown identifier diagnostic for GLOB_A
		const msgs = analysis.diagnostics.map(d => d.message).join('\n');
		expect(msgs).not.toMatch(/Unknown identifier "GLOB_A"/);
	});
});
