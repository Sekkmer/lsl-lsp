import { describe, it, expect } from 'vitest';
import { parseScriptFromText } from '../src/ast/parser';
import { TextDocument } from '../src/protocol';
import { analyzeAst } from '../src/ast/analyze';
import { loadTestDefs } from './loadDefs.testutil';
import { preprocessForAst } from '../src/core/pipeline';

describe('inactive branch filtering', () => {
	it('only active #elif branch global visible; no duplicate', async () => {
		const code = '#define MODE 2\n#if MODE == 1\ninteger G = 1;\n#elif MODE == 2\ninteger G = 2;\n#elif MODE == 3\ninteger G = 3;\n#endif\ndefault{state_entry(){}}';
		const uri = 'file:///inactive_branch_filtering.lsl';
		const script = parseScriptFromText(code, uri, { macros: {}, includePaths: [] });
		const doc = TextDocument.create(uri, 'lsl', 1, code);
		const defs = await loadTestDefs();
		const analysis = analyzeAst(doc, script, defs, { disabledRanges: [], macros: {}, funcMacros: {}, includes: [] });
		// No duplicate decl diagnostics
		const dupes = analysis.diagnostics.filter(d => d.code === 'LSL070');
		expect(dupes.length).toBe(0);
		// Ensure global value taken from active branch (norm name G, only one decl)
		expect(script.globals.size).toBe(1);
	});

	it('does not apply inactive ranges from one include to another include', () => {
		const files = new Map<string, string>([
			[
				'/virtual/main.lsl',
				[
					'#include "inactive.lsl"',
					'#include "active.lsl"',
					'default { state_entry() { helper(); } }',
				].join('\n'),
			],
			[
				'/virtual/inactive.lsl',
				[
					'#if 0',
					'integer hidden_zero = 0;',
					'integer hidden_one = 1;',
					'integer hidden_two = 2;',
					'integer hidden_three = 3;',
					'#endif',
				].join('\n'),
			],
			[
				'/virtual/active.lsl',
				[
					'#define slice(value, first, last) llGetSubString(value, first, last)',
					'helper() { llOwnerSay(slice("abcdef", 1, 3)); }',
				].join('\n'),
			],
		]);
		const pre = preprocessForAst(files.get('/virtual/main.lsl')!, {
			fromPath: '/virtual/main.lsl',
			includePaths: ['/virtual'],
			fs: {
				readFileSync(path: string) {
					const text = files.get(path);
					if (text === undefined) throw new Error(`missing test file ${path}`);
					return text;
				},
			},
		});
		const expanded = pre.expandedTokens.map(t => t.value).join(' ');
		expect(expanded).toContain('llGetSubString');
		expect(expanded).toContain('"abcdef"');
		expect(expanded).toContain('helper');
	});

	it('resolves angle includes from include paths before the including file directory', () => {
		const files = new Map<string, string>([
			[
				'/virtual/app/shared.lsl',
				[
					'#include <shared.lsl>',
					'default { state_entry() { llOwnerSay(SHARED_VALUE); } }',
				].join('\n'),
			],
			[
				'/virtual/lib/shared.lsl',
				'#define SHARED_VALUE "from-include-path"',
			],
		]);
		const pre = preprocessForAst(files.get('/virtual/app/shared.lsl')!, {
			fromPath: '/virtual/app/shared.lsl',
			includePaths: ['/virtual/lib'],
			fs: {
				readFileSync(path: string) {
					const text = files.get(path);
					if (text === undefined) throw new Error(`missing test file ${path}`);
					return text;
				},
			},
		});
		const expanded = pre.expandedTokens.map(t => t.value).join(' ');
		expect(expanded).toContain('"from-include-path"');
		expect(pre.includes).toContain('/virtual/lib/shared.lsl');
	});
});
