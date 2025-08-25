import { describe, it, expect } from 'vitest';
import { docFrom, runPipeline } from './testUtils';
import { loadTestDefs } from './loadDefs.testutil';

// Helper: extract messages for easier assertions
function messages(pre: { preprocDiagnostics?: { message: string }[] }) {
	return (pre.preprocDiagnostics || []).map(d => d.message);
}

describe('preprocessor diagnostics', () => {
	it('reports malformed #if expression', async () => {
		const defs = await loadTestDefs();
		const doc = docFrom('#if (1 + )\nint X;\n#endif\n');
		const { pre } = runPipeline(doc, defs);
		const msgs = messages(pre);
		expect(msgs.some(m => /Malformed #if expression/i.test(m))).toBe(true);
	});

	it('reports malformed #elif expression', async () => {
		const defs = await loadTestDefs();
		const doc = docFrom('#if 0\n#elif (defined(FOO\nint X;\n#endif\n');
		const { pre } = runPipeline(doc, defs);
		const msgs = messages(pre);
		expect(msgs.some(m => /Malformed #elif expression/i.test(m))).toBe(true);
	});

	it('reports stray #elif and #else and #endif', async () => {
		const defs = await loadTestDefs();
		const doc = docFrom('#elif 1\n#else\n#endif\n');
		const { pre } = runPipeline(doc, defs);
		const msgs = messages(pre);
		expect(msgs.some(m => /Stray #elif/i.test(m))).toBe(true);
		expect(msgs.some(m => /Stray #else/i.test(m))).toBe(true);
		expect(msgs.some(m => /Stray #endif/i.test(m))).toBe(true);
	});

	it('reports unmatched #if at EOF', async () => {
		const defs = await loadTestDefs();
		const doc = docFrom('#if 1\nint X;\n');
		const { pre } = runPipeline(doc, defs);
		const msgs = messages(pre);
		expect(msgs.some(m => /Unmatched conditional block/i.test(m))).toBe(true);
	});
});
