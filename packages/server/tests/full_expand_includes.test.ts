import { describe, it, expect } from 'vitest';
import path from 'node:path';
import fs from 'node:fs/promises';
import { docFrom, runPipeline } from './testUtils';
import { loadTestDefs } from './loadDefs.testutil';

function tmpFile(rel: string, contents: string) {
	const base = path.join(__dirname, 'tmp_includes_full_expand');
	return {
		path: path.join(base, rel),
		async write() {
			await fs.mkdir(base, { recursive: true });
			await fs.writeFile(this.path, contents, 'utf8');
			return this.path;
		}
	};
}

describe('preprocessor full expansion', () => {
	it('analysis sees included function and global declarations via expandedTokens', async () => {
		const defs = await loadTestDefs();
		const header = tmpFile('api.lslh', [
			'integer GLOB_Y;',
			'integer utilAdd(integer a, integer b);',
			'state Included { state_entry() { } }',
			''
		].join('\n'));
		const includeDir = path.dirname(await header.write());
		const code = `#include "${path.basename(header.path)}"\ninteger main(){ return utilAdd(1,2); }`;
		const doc = docFrom(code, 'file:///proj/full_expand.lsl');
		const { analysis, pre } = runPipeline(doc, defs, { includePaths: [includeDir] });
		// Assert expanded tokens present and from include file
		expect(pre.expandedTokens && pre.expandedTokens.some(t => t.file && t.file.endsWith('api.lslh'))).toBe(true);
		// The prototype utilAdd should be callable (no unknown id diagnostic)
		const unknowns = analysis.diagnostics.filter(d => /Unknown identifier utilAdd/.test(d.message));
		expect(unknowns.length).toBe(0);
		// Global GLOB_Y should be present as a declaration
		const hasGlob = analysis.decls.some(d => d.kind === 'var' && d.name === 'GLOB_Y');
		expect(hasGlob).toBe(true);
	});
});
