import { describe, it, expect } from 'vitest';
import { docFrom, runPipeline } from './testUtils';
import { loadTestDefs } from './loadDefs.testutil';

// Regression: Two distinct source files each using the classic include guard pattern
//   #ifndef FOO_GUARD
//   #define FOO_GUARD 1
//   ... body ...
//   #endif
// must both see their body as active. Defining FOO_GUARD in file1 must NOT cause
// file2's guard to treat FOO_GUARD as already defined on first open.

describe('macro isolation: same include guard across files', () => {
	it('second file with same #ifndef guard still active', async () => {
		const defs = await loadTestDefs();
		const file1 = [
			'#ifndef FOO_GUARD',
			'#define FOO_GUARD 1',
			'integer X = 10;',
			'#endif',
			'integer AFTER1 = X;',
		].join('\n');
		const file2 = [
			'#ifndef FOO_GUARD',
			'#define FOO_GUARD 1',
			'integer Y = 20;',
			'#endif',
			'integer AFTER2 = Y;',
		].join('\n');
		const doc1 = docFrom(file1, 'file:///proj/guard1.lsl');
		const r1 = runPipeline(doc1, defs, {});
		expect(r1.analysis.diagnostics.find(d => String(d.code).startsWith('LSL0'))).toBeUndefined();
		// Ensure X declared (guard body active)
		expect(r1.analysis.decls.find(d => d.name === 'X')).toBeTruthy();

		const doc2 = docFrom(file2, 'file:///proj/guard2.lsl');
		const r2 = runPipeline(doc2, defs, {});
		expect(r2.analysis.diagnostics.find(d => String(d.code).startsWith('LSL0'))).toBeUndefined();
		// If macro leaked, Y would be skipped (no declaration). Assert it exists.
		expect(r2.analysis.decls.find(d => d.name === 'Y')).toBeTruthy();
	});
});
