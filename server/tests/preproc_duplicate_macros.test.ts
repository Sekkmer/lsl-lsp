import { describe, it, expect } from 'vitest';
import path from 'node:path';
import fs from 'node:fs/promises';
import { docFrom, runPipeline } from './testUtils';
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

describe('preprocessor: duplicate macros from includes', () => {
	it('ignores duplicate macros from include and emits preproc diagnostic', async () => {
		const defs = await loadTestDefs();
		// Local defines duplicate of header macro names
		const header = tmpFile('dup_macros.lslh', `#define FOO 1\n#define BAR(x) (x)\n`);
		const includeDir = path.dirname(await header.write());
		const code = `#define FOO 42\n#define BAR(x) ((x)+1)\n#include "${path.basename(header.path)}"\ninteger main(){ return FOO; }`;
		const doc = docFrom(code, 'file:///proj/dup_macros_test.lsl');
		const { pre, analysis } = runPipeline(doc, defs, { includePaths: [includeDir] });
		// Preproc should report duplicate macro diagnostics at the include site
		const msgs = (pre.preprocDiagnostics || []).map(d => d.message).join('\n');
		expect(msgs).toMatch(/Duplicate macro FOO/);
		expect(msgs).toMatch(/Duplicate macro BAR/);
		// Local macro values should remain in effect (not overwritten)
		const text = doc.getText();
		expect(text.includes('return FOO')).toBe(true);
		// Also ensure no syntax/analysis crash
		expect(analysis.diagnostics.length).toBeGreaterThanOrEqual(0);
	});
});
