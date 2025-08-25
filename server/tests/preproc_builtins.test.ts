import { describe, it, expect } from 'vitest';
import { docFrom, runPipeline } from './testUtils';
import { loadTestDefs } from './loadDefs.testutil';

// __FILE__ should be the basename of the URI path

describe('preprocessor built-ins', () => {
	it('__FILE__ expands to basename', async () => {
		const defs = await loadTestDefs();
		const doc = docFrom('#if defined(__FILE__)\ninteger ok;\n#endif\n', 'file:///some/dir/My Script.lsl');
		const { pre, analysis } = runPipeline(doc, defs);
		// macro exists and is a string
		expect(typeof pre.macros.__FILE__).toBe('string');
		expect(pre.macros.__FILE__).toBe('My Script.lsl');
		// branch enabled
		const names = analysis.decls.map(d => d.name);
		expect(names.includes('ok')).toBe(true);
	});

	it('function-like macros with __VA_ARGS__/__VA_OPT__ are recognized as defined', async () => {
		const defs = await loadTestDefs();
		const doc = docFrom('#define LOG(fmt, ...) __VA_OPT__(,)\n#if defined(LOG)\ninteger ok;\n#endif\n');
		const { analysis } = runPipeline(doc, defs);
		const names = analysis.decls.map(d => d.name);
		expect(names.includes('ok')).toBe(true);
	});
});
