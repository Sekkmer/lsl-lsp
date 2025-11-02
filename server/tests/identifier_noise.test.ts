import { describe, it, expect } from 'vitest';
import { docFrom, runPipeline } from './testUtils';
import { loadTestDefs } from './loadDefs.testutil';

describe('identifier noise normalization', () => {
	it('treats #foo and foo as the same name (duplicate)', async () => {
		const defs = await loadTestDefs();
		const src = 'integer foo; integer #foo;';
		const { analysis } = runPipeline(docFrom(src), defs);
		const dup = analysis.diagnostics.find(d => d.code === 'LSL070');
		expect(dup).toBeTruthy();
	});

	it('allows leading/trailing noise and resolves usage', async () => {
		const defs = await loadTestDefs();
		const src = 'string #version = "2.2p04"; default{ state_entry(){ llOwnerSay(version); }}';
		const { analysis } = runPipeline(docFrom(src), defs);
		// Should not flag "version" as unknown identifier
		const unknowns = analysis.diagnostics.filter(d => d.code === 'LSL001' && /version\b/.test(d.message));
		expect(unknowns.length).toBe(0);
		// Global decl should be recorded under normalized name
		const hasVar = analysis.decls.some(d => d.kind === 'var' && d.name === 'version');
		expect(hasVar).toBe(true);
	});

	it('allows preprocessor macros with noise-prefixed names', async () => {
		const defs = await loadTestDefs();
		const src = '#define $DEBUG(msg) llOwnerSay(msg)\n#define #TRACE(msg) llOwnerSay(msg)\n#define ?WARN(msg) llOwnerSay(msg)\n\ndefault {\n	state_entry() {\n		$DEBUG("a");\n		#TRACE("b");\n		?WARN("c");\n	}\n}\n';
		const { analysis, pre } = runPipeline(docFrom(src), defs);
		const unknowns = analysis.diagnostics.filter(d => d.code === 'LSL001');
		expect(unknowns.length).toBe(0);
		// Macro table should contain normalized entries for each noise-prefixed define
		expect(Object.prototype.hasOwnProperty.call(pre.macros, 'DEBUG')).toBe(true);
		expect(Object.prototype.hasOwnProperty.call(pre.macros, 'TRACE')).toBe(true);
		expect(Object.prototype.hasOwnProperty.call(pre.macros, 'WARN')).toBe(true);
	});
});
