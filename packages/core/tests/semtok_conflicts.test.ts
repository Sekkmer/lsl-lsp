import { describe, it, expect } from 'vitest';
import { docFrom, runPipeline, semToSpans } from './testUtils';
import { loadTestDefs } from './loadDefs.testutil';
import { semanticTokensLegend } from '../src/semtok';

// Avoid literal conflict markers so editors won't treat this file as a conflict
const MARK_BEGIN = '<<<<<<< ';
const MARK_OURS_SPLIT = '||||||| base';
const MARK_SEP = '=======';
const MARK_END = '>>>>>>> ';

// Helper: find spans on a specific 0-based line
function spansOnLine(spans: ReturnType<typeof semToSpans>, line: number) {
	return spans.filter(s => s.line === line);
}

// Build a small document with a three-way conflict block in the middle
// We expect:
// - marker lines (<<<<<<<, |||||||, =======, >>>>>>>) to be tokenized (we use 'regexp' type index per implementation)
// - no semantic tokens for content lines inside the conflict block
// - tokens resume after the conflict (e.g., 'integer' as type)

describe('semantic tokens: merge conflict blocks', () => {
	it('colors only markers and disables inner ranges', async () => {
		const defs = await loadTestDefs();
		const doc = docFrom(`
integer before = 1;

${MARK_BEGIN}HEAD

integer midA = 2;

${MARK_OURS_SPLIT}

integer base = 3;

${MARK_SEP}

integer midB = 4;

${MARK_END}feature

integer after = 5;

`);
		const { sem } = runPipeline(doc, defs);
		const spans = semToSpans(doc, sem);

		const tType = (name: string) => (semanticTokensLegend.tokenTypes as string[]).indexOf(name);
		const markerType = tType('regexp');
		const typeType = tType('type');

		// Helper to get line index of a substring
		const text = doc.getText();
		const lineOf = (substr: string) => {
			const at = text.indexOf(substr);
			expect(at).toBeGreaterThanOrEqual(0);
			return doc.positionAt(at).line;
		};

		const lBegin = lineOf(MARK_BEGIN);
		const lSep = lineOf(MARK_SEP);
		const lEnd = lineOf(MARK_END);

		// Markers should have tokens on their lines
		expect(spansOnLine(spans, lBegin).some(s => s.type === markerType)).toBe(true);
		expect(spansOnLine(spans, lSep).some(s => s.type === markerType)).toBe(true);
		expect(spansOnLine(spans, lEnd).some(s => s.type === markerType)).toBe(true);

		// Inside the block, content lines should have no semantic tokens
		const lA = lineOf('integer midA');
		const lBaseCnt = lineOf('integer base');
		const lB = lineOf('integer midB');
		expect(spansOnLine(spans, lA).length).toBe(0);
		expect(spansOnLine(spans, lBaseCnt).length).toBe(0);
		expect(spansOnLine(spans, lB).length).toBe(0);

		// Outside the block, tokens should exist: before/after lines show 'integer' as type
		const lBefore = lineOf('integer before');
		const lAfter = lineOf('integer after');
		expect(spansOnLine(spans, lBefore).some(s => s.type === typeType)).toBe(true);
		expect(spansOnLine(spans, lAfter).some(s => s.type === typeType)).toBe(true);
	});
});
