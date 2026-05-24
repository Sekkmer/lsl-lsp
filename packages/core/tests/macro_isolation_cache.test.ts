import { describe, it, expect } from 'vitest';
import { loadTestDefs } from './loadDefs.testutil';
import { docFrom, runPipeline } from './testUtils';

// Simulate two files with identical include guards opening sequentially.
// Previously (before including doc URI in config hash) second file could reuse cached
// disabledRanges/macros causing its guard body to appear disabled.

describe('macro isolation with per-doc config hash', () => {
	it('does not leak guard macro through cache reuse', async () => {
		const defs = await loadTestDefs();
		const textA = [
			'#ifndef CACHED_GUARD',
			'#define CACHED_GUARD 1',
			'integer A = 1;',
			'#endif',
			'integer USE_A = A;',
		].join('\n');
		const textB = [
			'#ifndef CACHED_GUARD',
			'#define CACHED_GUARD 1',
			'integer B = 2;',
			'#endif',
			'integer USE_B = B;',
		].join('\n');
		const docA = docFrom(textA, 'file:///proj/cacheA.lsl');
		const rA = runPipeline(docA, defs, {});
		expect(rA.analysis.decls.find(d => d.name==='A')).toBeTruthy();
		const docB = docFrom(textB, 'file:///proj/cacheB.lsl');
		const rB = runPipeline(docB, defs, {});
		expect(rB.analysis.decls.find(d => d.name==='B')).toBeTruthy();
	});
});
