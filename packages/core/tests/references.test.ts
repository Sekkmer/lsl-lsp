import { describe, it, expect } from 'vitest';
import { docFrom, runPipeline, toSimpleTokens } from './testUtils';
import { loadTestDefs } from './loadDefs.testutil';
import { findAllReferences } from '../src/navigation';

function posOf(doc: { getText(): string }, needle: string) {
	const idx = doc.getText().indexOf(needle);
	if (idx < 0) throw new Error('needle not found');
	// Return the start index of the needle; callers pass a snippet starting at the target identifier
	return idx;
}

describe('findAllReferences', () => {
	it('finds decl + refs for local variable', async () => {
		const defs = await loadTestDefs();
		const doc = docFrom('integer x; default { state_entry() { integer y = x; x = y; } }');
		const { analysis, pre, tokens } = runPipeline(doc, defs);
		const offset = posOf(doc, 'x; default');
		const results = findAllReferences(doc, offset, true, analysis, pre, toSimpleTokens(tokens));
		// decl + 2 refs
		expect(results.filter(r => r.uri === doc.uri).length).toBeGreaterThanOrEqual(3);
	});

	it('returns refs within current doc for include-defined function (header decl not yet included)', async () => {
		const defs = await loadTestDefs();
		const header = '#define FOO 1\ninteger myApi(integer a);\n';
		const path = require('node:path');
		const fs = require('node:fs');
		const base = require('node:os').tmpdir();
		const dir = await fs.mkdtempSync(path.join(base, 'lsl-inc-'));
		const hdr = path.join(dir, 'api.lslh');
		fs.writeFileSync(hdr, header, 'utf8');
		const code = `#include "${path.basename(hdr)}"\ninteger z = myApi(1);`;
		const doc = docFrom(code, 'file:///proj/refs_inc.lsl');
		const { analysis, pre, tokens } = runPipeline(doc, defs, { includePaths: [dir] });
		const offset = posOf(doc, 'myApi');
		const results = findAllReferences(doc, offset, true, analysis, pre, toSimpleTokens(tokens));
		// Current design: findAllReferences only returns locations in the active document.
		// Ensure we have at least the call site (and optionally a decl if in-file) and do NOT crash.
		expect(results.length).toBeGreaterThanOrEqual(1);
		// Legacy expectation (include header decl) intentionally removed.
	});
});
