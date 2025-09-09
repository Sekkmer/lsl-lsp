import { describe, it, expect } from 'vitest';
import { docFrom, runPipeline, hoverToString } from './testUtils';
import { lslHover } from '../src/hover';
import { loadTestDefs } from './loadDefs.testutil';

// Regression: macros defined in one file should not leak to another newly opened file.
// We simulate two files: first defines an include guard macro; second references the guard
// expecting it to be unset so guarded code is active.

describe('macro isolation between files', () => {
	it('does not leak include guard macro from file1 to file2', async () => {
		const defs = await loadTestDefs();
		const file1 = [
			'#ifndef FOO_GUARD',
			'#define FOO_GUARD 1',
			'integer A = 1;',
			'#endif',
		].join('\n');
		// Access something inside guard in second file via a re-declaration that would be skipped if guard leaked
		const file2 = [
			'#ifdef FOO_GUARD',
			'integer SHOULD_NOT_EXIST = 5;',
			'#endif',
			'integer B = 2;',
		].join('\n');
		// Hover B to force pipeline build for both files; ensure guard from file1 not present in file2 (#ifdef branch inactive)
		// Build pipelines separately simulating opening file1 then file2
		const doc1 = docFrom(file1, 'file:///proj/file1.lsl');
		runPipeline(doc1, defs, {}); // intentionally ignore output; side-effects shouldn't leak now
		const doc2 = docFrom(file2, 'file:///proj/file2.lsl');
		const { analysis, pre } = runPipeline(doc2, defs, {});
		const hoverPos = doc2.positionAt(file2.indexOf('B') + 1);
		const hv = lslHover(doc2, { position: hoverPos }, defs, analysis, pre);
		const md = hoverToString(hv!);
		expect(md).toMatch(/integer B/);
		// Ensure the guarded declaration did NOT activate (macro absent so #ifdef branch disabled)
		expect(md).not.toMatch(/SHOULD_NOT_EXIST/);
	});
});
