import { describe, it, expect } from 'vitest';
import { docFrom } from './testUtils';
import { loadDefs } from '../src/defs';
import path from 'node:path';
import { runPipeline } from './testUtils';
import { Analysis } from '../src/analysisTypes';

const defsPath = path.join(__dirname, '..', '..', 'common', 'lsl-defs.json');

function diagMsgs(analysis: Analysis) {
	return analysis.diagnostics.map((d) => `${d.message} @${d.code}`);
}

describe('postfix ++/-- parsing and validation', () => {
	it('parses for-update with i++ without parse errors', async () => {
		const defs = await loadDefs(defsPath);
		const code = `default { state_entry() { integer i = 0; for (i = 0; i < 3; i++) { } } }`;
		const doc = docFrom(code, 'file:///postfix_for.lsl');
		const { analysis } = runPipeline(doc, defs, { macros: {}, includePaths: [] });
		const parseErrors = analysis.diagnostics.filter((d) => d.code === 'LSL000');
		expect(parseErrors.length).toBe(0);
	});

	it('parses standalone i++ and validates assignability/integer type', async () => {
		const defs = await loadDefs(defsPath);
		const code = `default { state_entry() { integer i = 0; i++; --i; } }`;
		const doc = docFrom(code, 'file:///postfix_standalone.lsl');
		const { analysis } = runPipeline(doc, defs, { macros: {}, includePaths: [] });
		// Should not produce INVALID_ASSIGN_LHS or WRONG_TYPE when i is integer variable
		const msgs = diagMsgs(analysis);
		expect(msgs.some((m: string) => m.includes('Operand of ++ must be a variable') || m.includes('expects an integer variable'))).toBe(false);
	});

	it('flags invalid postfix on non-assignable (1++)', async () => {
		const defs = await loadDefs(defsPath);
		const code = `default { state_entry() { 1++; } }`;
		const doc = docFrom(code, 'file:///postfix_invalid.lsl');
		const { analysis } = runPipeline(doc, defs, { macros: {}, includePaths: [] });
		const msgs = diagMsgs(analysis);
		expect(msgs.some((m: string) => m.includes('Operand of ++ must be a variable'))).toBe(true);
	});
});
