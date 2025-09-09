import { describe, it, expect } from 'vitest';
import path from 'node:path';
import fs from 'node:fs/promises';
import { docFrom, runPipeline } from './testUtils';
import { loadDefs } from '../src/defs';

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

describe('includes: duplicate built-in function declarations', () => {
	it('emits duplicate function diagnostic at include site when header redeclares builtin', async () => {
		const defsPath = path.join(__dirname, 'fixtures', 'lsl-defs.json');
		const defs = await loadDefs(defsPath);
		const header = tmpFile('dup_builtin.lslh', 'integer llSay(key id, string msg);\n');
		const includeDir = path.dirname(await header.write());
		const code = `#include "${path.basename(header.path)}"\ninteger main(){ return 0; }\n`;
		const doc = docFrom(code, 'file:///proj/dup_builtin.lsl');
		const { analysis, pre } = runPipeline(doc, defs, { includePaths: [includeDir] });
		const errs = analysis.diagnostics.filter(d => d.severity === 1);
		expect(errs.some(d => /Duplicate declaration of function llSay/.test(d.message))).toBe(true);
		expect(pre.includeTargets?.length).toBe(1);
	});
});
