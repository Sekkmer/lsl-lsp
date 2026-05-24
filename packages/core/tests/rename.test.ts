import { describe, it, expect } from 'vitest';
import path from 'node:path';
import fs from 'node:fs/promises';
import { docFrom, runPipeline } from './testUtils';
import { loadTestDefs } from './loadDefs.testutil';
import { computeRenameEdits, findAllReferences, prepareRename } from '../src/navigation';
import { TextDocument } from '../src/protocol';

function posOf(doc: TextDocument, needle: string) {
	const idx = doc.getText().indexOf(needle);
	if (idx < 0) throw new Error('needle not found');
	return idx;
}

function textForRange(doc: TextDocument, range: { start: { line: number; character: number }; end: { line: number; character: number } }) {
	return doc.getText().slice(doc.offsetAt(range.start), doc.offsetAt(range.end));
}

function tmpFile(rel: string, contents: string) {
	const base = path.join(__dirname, 'tmp_includes', 'rename');
	return {
		path: path.join(base, rel),
		async write() {
			await fs.mkdir(base, { recursive: true });
			await fs.writeFile(this.path, contents, 'utf8');
			return this.path;
		}
	};
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

	it('renames only active local macro definitions and references', async () => {
		const defs = await loadTestDefs();
		const code = [
			'#define LOCAL_MACRO 1',
			'integer a = LOCAL_MACRO;',
			'#if 0',
			'#define LOCAL_MACRO 2',
			'integer b = LOCAL_MACRO;',
			'#endif',
			'integer c = LOCAL_MACRO;',
		].join('\n');
		const doc = docFrom(code, 'file:///rename-local-macro.lsl');
		const { analysis, pre, tokens } = runPipeline(doc, defs);
		const offset = posOf(doc, 'LOCAL_MACRO;');
		const res = computeRenameEdits(doc, offset, 'RENAMED_MACRO', analysis, pre, tokens);
		const edits = res.changes[doc.uri] || [];

		expect(edits).toHaveLength(3);
		expect(edits.map(e => textForRange(doc, e.range))).toEqual(['LOCAL_MACRO', 'LOCAL_MACRO', 'LOCAL_MACRO']);
		expect(edits.map(e => doc.offsetAt(e.range.start))).not.toContain(code.indexOf('#define LOCAL_MACRO 2') + '#define '.length);
		expect(edits.every(e => e.newText === 'RENAMED_MACRO')).toBe(true);
	});

	it('does not prepare rename for included macros it cannot update', async () => {
		const defs = await loadTestDefs();
		const header = tmpFile('api.lslh', '#define INCLUDED_MACRO 1\n');
		const includeDir = path.dirname(await header.write());
		const code = '#include "api.lslh"\ninteger a = INCLUDED_MACRO;\n';
		const doc = docFrom(code, 'file:///rename-include-macro.lsl');
		const { analysis, pre } = runPipeline(doc, defs, { includePaths: [includeDir] });

		const range = prepareRename(doc, posOf(doc, 'INCLUDED_MACRO'), analysis, pre);

		expect(range).toBeNull();
	});

	it('does not report inactive macro definitions as references', async () => {
		const defs = await loadTestDefs();
		const code = [
			'#define ACTIVE_REF_MACRO 1',
			'integer a = ACTIVE_REF_MACRO;',
			'#if 0',
			'#define ACTIVE_REF_MACRO 2',
			'integer b = ACTIVE_REF_MACRO;',
			'#endif',
			'integer c = ACTIVE_REF_MACRO;',
		].join('\n');
		const doc = docFrom(code, 'file:///rename-macro-refs.lsl');
		const { analysis, pre, tokens } = runPipeline(doc, defs);
		const refs = findAllReferences(doc, posOf(doc, 'ACTIVE_REF_MACRO;'), true, analysis, pre, tokens);

		expect(refs).toHaveLength(3);
		expect(refs.map(r => textForRange(doc, r.range))).toEqual(['ACTIVE_REF_MACRO', 'ACTIVE_REF_MACRO', 'ACTIVE_REF_MACRO']);
		expect(refs.map(r => doc.offsetAt(r.range.start))).not.toContain(code.indexOf('#define ACTIVE_REF_MACRO 2') + '#define '.length);
	});
});
