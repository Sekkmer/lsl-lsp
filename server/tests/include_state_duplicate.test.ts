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

describe('includes: duplicate state names', () => {
	it('emits duplicate state diagnostic at include site', async () => {
		const defs = await loadTestDefs();
		const header = tmpFile('states_api.lslh', 'state Foo {\n\tstate_entry() { }\n}\n');
		const includeDir = path.dirname(await header.write());
		const code = `#include "${path.basename(header.path)}"\nstate Foo {\n\tstate_entry(){ }\n}`;
		const doc = docFrom(code, 'file:///proj/dup_state.lsl');
		const { analysis, pre } = runPipeline(doc, defs, { includePaths: [includeDir] });
		// One duplicate decl error at the include directive
		const errors = analysis.diagnostics.filter(d => d.severity === 1);
		expect(errors.some(d => /Duplicate declaration of state Foo/.test(d.message))).toBe(true);
		// Sanity: includeTargets recorded
		expect(pre.includeTargets.length).toBe(1);
	});
});
