import { describe, it, expect } from 'vitest';
import { docFrom, runPipeline } from './testUtils';
import { loadTestDefs } from './loadDefs.testutil';

function diagnosticsFor(code: string, defs: Awaited<ReturnType<typeof loadTestDefs>>) {
	const { analysis } = runPipeline(docFrom(code, 'file:///local_initializers.lsl'), defs);
	return analysis.diagnostics.map(d => `${d.message} @${d.code}`);
}

describe('local initializers', () => {
	it('rejects self and forward references', async () => {
		const defs = await loadTestDefs();
		const msgs = diagnosticsFor(`
default { state_entry() {
	integer self = self;
	integer forward = later;
	integer later = 1;
} }
`, defs);
		expect(msgs.some(m => m.includes('Unknown identifier self') && m.includes('LSL001'))).toBe(true);
		expect(msgs.some(m => m.includes('Unknown identifier later') && m.includes('LSL001'))).toBe(true);
	});

	it('allows previous locals in later initializers', async () => {
		const defs = await loadTestDefs();
		const msgs = diagnosticsFor(`
default { state_entry() {
	integer a = 1;
	integer b = a;
} }
`, defs);
		expect(msgs.some(m => m.includes('Unknown identifier a') || m.includes('Unknown identifier b'))).toBe(false);
	});

	it('resolves shadowing initializers against the outer scope', async () => {
		const defs = await loadTestDefs();
		const msgs = diagnosticsFor(`
integer a = 1;
integer probe(integer p) {
	integer a = a;
	integer p = p;
	return a + p;
}
default { state_entry() { } }
`, defs);
		expect(msgs.some(m => m.includes('Unknown identifier a'))).toBe(false);
		expect(msgs.some(m => m.includes('Unknown identifier p'))).toBe(false);
	});
});
