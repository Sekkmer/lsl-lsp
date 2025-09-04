import { describe, it, expect } from 'vitest';
import path from 'node:path';
import fs from 'node:fs/promises';
import { docFrom, runPipeline } from './testUtils';
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

describe('includes: function decl without explicit return type', () => {
	it('recognizes and allows call without unknown function diagnostic', async () => {
		const header = tmpFile('api_voiddecl.lslh', 'myHelper(integer x);\n');
		const includeDir = path.dirname(await header.write());
		const code = `#include "${path.basename(header.path)}"\ninteger z;\ninteger main() { myHelper(1); return 0; }\n`;
		const doc = docFrom(code, 'file:///proj/usesVoidDecl.lsl');
		const defs = await loadDefs(defsPath);
		const { analysis } = runPipeline(doc, defs, { includePaths: [includeDir] });
		const msgs = analysis.diagnostics.map(d => d.message).join('\n');
		expect(msgs).not.toMatch(/Unknown function "myHelper"/);
	});
});
