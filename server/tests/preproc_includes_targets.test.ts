import { describe, it, expect } from 'vitest';
import { docFrom, runPipeline } from './testUtils';
import { loadTestDefs } from './loadDefs.testutil';
import path from 'node:path';

const includesDir = path.join(__dirname, 'fixtures', 'includes');

describe('preprocessor include targets', () => {
	it('resolves includeTargets and collects missingIncludes', async () => {
		const defs = await loadTestDefs();
		const code = [
			'#include "inc.lsl"',
			'#include "does_not_exist.lsl"',
			'// keep file valid',
		].join('\n');
		const doc = docFrom(code);
		const { pre } = runPipeline(doc, defs, { includePaths: [includesDir] });
		// includeTargets should have two entries
		expect(pre.includeTargets.length).toBe(2);
		// first should be resolved to fixtures/includes/inc.lsl
		const first = pre.includeTargets[0];
		expect(first.file).toBe('inc.lsl');
		expect(typeof first.resolved === 'string' && first.resolved.endsWith(path.join('fixtures', 'includes', 'inc.lsl'))).toBe(true);
		// missingIncludes should contain the second
		expect(pre.missingIncludes.length).toBe(1);
		expect(pre.missingIncludes[0].file).toBe('does_not_exist.lsl');
	});
});
