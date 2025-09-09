import { describe, it, expect } from 'vitest';
import { parseScriptFromText } from '../src/ast/parser';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { analyzeAst } from '../src/ast/analyze';
import { loadDefs } from '../src/defs';
import path from 'node:path';

describe('inactive branch filtering', () => {
	it('only active #elif branch global visible; no duplicate', async () => {
		const code = '#define MODE 2\n#if MODE == 1\ninteger G = 1;\n#elif MODE == 2\ninteger G = 2;\n#elif MODE == 3\ninteger G = 3;\n#endif\ndefault{state_entry(){}}';
		const uri = 'file:///inactive_branch_filtering.lsl';
		const script = parseScriptFromText(code, uri, { macros: {}, includePaths: [] });
		const doc = TextDocument.create(uri, 'lsl', 1, code);
		const defs = await loadDefs(path.resolve(__dirname, '../out/lsl-defs.json'));
		const analysis = analyzeAst(doc, script, defs, { disabledRanges: [], macros: {}, funcMacros: {}, includes: [] });
		// No duplicate decl diagnostics
		const dupes = analysis.diagnostics.filter(d => d.code === 'LSL070');
		expect(dupes.length).toBe(0);
		// Ensure global value taken from active branch (norm name G, only one decl)
		expect(script.globals.size).toBe(1);
	});
});