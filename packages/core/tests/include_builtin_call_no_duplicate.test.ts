import { expect, it, describe } from 'vitest';
import { docFrom, runPipeline } from './testUtils';
import { loadTestDefs } from './loadDefs.testutil';

// Regression: ensure that merely calling a built-in inside an include does NOT produce a duplicate function declaration diagnostic.
// Simulates an include file content where a built-in function is referenced but not declared.

describe('include: builtin call does not create duplicate', () => {
	it('no duplicate diagnostic for built-in call in include', async () => {
		const defs = await loadTestDefs();
		const src = '#include "myheader.lsl"\ninteger x;';
		// Create fake header on disk
		const fs = require('node:fs');
		fs.writeFileSync('myheader.lsl', '/* header */\n// usage of built-in: llList2List(listVar,0,0);\n// ensure no declaration like "list llList2List(..." appears');
		const doc = docFrom(src);
		const { analysis } = runPipeline(doc, defs, { includePaths: [process.cwd()] });
		const dup = analysis.diagnostics.find(d => /Duplicate declaration of function llList2List/.test(d.message));
		try { fs.unlinkSync('myheader.lsl'); } catch { /* ignore cleanup error */ }
		expect(dup).toBeUndefined();
	});
});
