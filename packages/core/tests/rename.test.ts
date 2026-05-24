import { describe, it, expect } from 'vitest';
import { docFrom, runPipeline } from './testUtils';
import { loadTestDefs } from './loadDefs.testutil';
import { computeRenameEdits } from '../src/navigation';
import { TextDocument } from 'vscode-languageserver-textdocument';

function posOf(doc: TextDocument, needle: string) {
	const idx = doc.getText().indexOf(needle);
	if (idx < 0) throw new Error('needle not found');
	return idx;
}

describe('computeRenameEdits', () => {
	it('renames decl and refs for local variable', async () => {
		const defs = await loadTestDefs();
		const doc = docFrom('integer x; default { state_entry() { integer y = x; x = y; } }');
		const { analysis, pre, tokens } = runPipeline(doc, defs);
		const offset = posOf(doc, 'x; default');
		const res = computeRenameEdits(doc, offset, 'x2', analysis, pre, defs, tokens);
		const edits = res.changes[doc.uri] || [];
		// At least declaration and 2 refs should be edited
		expect(edits.length).toBeGreaterThanOrEqual(3);
		expect(edits.every(e => typeof e.newText === 'string' && e.newText === 'x2')).toBe(true);
	});
});
