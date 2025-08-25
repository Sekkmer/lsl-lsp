import { describe, it, expect } from 'vitest';
import { docFrom, runPipeline, semToSpans } from './testUtils';
import { loadTestDefs } from './loadDefs.testutil';
import { semanticTokensLegend } from '../src/semtok';

function idx(name: string) {
	return (semanticTokensLegend.tokenTypes as string[]).indexOf(name);
}

describe('semantic tokens', () => {
	it('labels keywords/types/consts/functions/events', async () => {
		const defs = await loadTestDefs();
		const doc = docFrom(`
integer x = TRUE;
default { state_entry() { llSay(0, "hi"); } }
`);
		const { sem } = runPipeline(doc, defs);
		const spans = semToSpans(doc, sem);

		// helper to find tokens by line/char range
		const findAt = (line: number, col: number) => spans.find(s => s.line === line && col >= s.char && col < s.char + s.len);

		// line 1: "integer x = TRUE;"
		// integer (type)
		expect(findAt(1, 0)?.type).toBe(idx('type'));
		// TRUE (enumMember)
		expect(findAt(1, 12)?.type).toBe(idx('enumMember'));

		// line 2: "default { state_entry() { llSay(0, \"hi\"); } }"
		// default (keyword)
		expect(findAt(2, 0)?.type).toBe(idx('keyword'));
		// state_entry (event, colored as function for consistency)
		expect(findAt(2, 11)?.type).toBe(idx('function'));
		// llSay (function)
		expect(findAt(2, 26)?.type).toBe(idx('function'));

		// sanity
		expect(spans.length).toBeGreaterThan(5);
	});

	it('colors macros and preprocessor constructs', async () => {
		const defs = await loadTestDefs();
		const doc = docFrom(`
#define FOO 1
#define BAR(x) (x)
integer i = FOO;
integer j = BAR(2);
integer k = __LINE__;
#include "some.h"
`);
		const { sem } = runPipeline(doc, defs);
		const spans = semToSpans(doc, sem);

		const findAt = (line: number, col: number) => spans.find(s => s.line === line && col >= s.char && col < s.char + s.len);

		// Line 1: #define FOO 1 -> 'define' as keyword, 'FOO' as macro
		expect(findAt(1, 1)?.type).toBe(idx('keyword'));
		expect(findAt(1, 9)?.type).toBe(idx('macro'));

		// Line 2: #define BAR(x) (x) -> 'define' keyword, 'BAR' macro (function-like name)
		expect(findAt(2, 1)?.type).toBe(idx('keyword'));
		expect(findAt(2, 9)?.type).toBe(idx('macro'));

		// Line 3: FOO usage
		expect(findAt(3, 12)?.type).toBe(idx('macro'));

		// Line 4: BAR(...) usage (function-like macro)
		expect(findAt(4, 12)?.type).toBe(idx('macro'));

		// Line 5: __LINE__ magic macro
		expect(findAt(5, 12)?.type).toBe(idx('macro'));

		// Line 6: #include -> 'include' as keyword
		expect(findAt(6, 1)?.type).toBe(idx('keyword'));
	});
});
