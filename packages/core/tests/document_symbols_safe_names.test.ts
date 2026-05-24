import { describe, it, expect } from 'vitest';
import { documentSymbols } from '../src/symbols';
import type { Analysis } from '../src/analysisTypes';
import type { Range } from 'vscode-languageserver/node';

const r: Range = { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } };

describe('documentSymbols handles falsy names', () => {
	it('does not throw and filters/renames nameless symbols', () => {
		const analysis: Analysis = {
			diagnostics: [],
			decls: [
				{ name: '', range: r, kind: 'func', params: [{ name: '' }], type: 'integer' },
				{ name: 'stateOne', range: r, kind: 'state' },
				{ name: '', range: r, kind: 'event', params: [{ name: '' }] },
			],
			refs: [],
			calls: [],
			states: new Map(),
			functions: new Map(),
			symbolAt: () => null,
			refAt: () => null,
		};

		const syms = documentSymbols(analysis);
		// Should not include nameless top-level func, and all names should be non-empty strings
		expect(syms.every(s => typeof s.name === 'string' && s.name.trim().length > 0)).toBe(true);
	});
});
