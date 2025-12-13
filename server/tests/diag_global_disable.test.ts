import { describe, it, expect } from 'vitest';
import { docFrom, runPipeline } from './testUtils';
import { loadTestDefs } from './loadDefs.testutil';
import { parseDisabledDiagList, filterDiagnostics } from '../src/diagSettings';
import { LSL_DIAGCODES } from '../src/analysisTypes';

describe('global diagnostic disable list', () => {
	it('suppresses matching diagnostics by code or friendly name', async () => {
		const defs = await loadTestDefs();
		const doc = docFrom('integer f(){ integer x; return y; }');
		const { analysis } = runPipeline(doc, defs);
		const disabled = parseDisabledDiagList(['LSL001', 'unused_local']);
		const filtered = filterDiagnostics(analysis.diagnostics, disabled);
		expect(filtered.find(d => d.code === LSL_DIAGCODES.UNKNOWN_IDENTIFIER)).toBeFalsy();
		expect(filtered.find(d => d.code === LSL_DIAGCODES.UNUSED_LOCAL)).toBeFalsy();
	});

	it('parses dash/underscore/case-insensitive names and ignores invalid entries', () => {
		const disabled = parseDisabledDiagList(['Return-in-void', 'EMPTY_else_body', 'not-a-code']);
		expect(disabled.has(LSL_DIAGCODES.RETURN_IN_VOID)).toBe(true);
		expect(disabled.has(LSL_DIAGCODES.EMPTY_ELSE_BODY)).toBe(true);
		expect(disabled.size).toBe(2);
	});
});
