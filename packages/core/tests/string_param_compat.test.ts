import { describe, it, expect } from 'vitest';
import { docFrom } from './testUtils';
import { loadDefs } from '../src/defs';
import path from 'node:path';
import { runPipeline } from './testUtils';

const defsPath = path.join(__dirname, '..', '..', '..', 'third_party', 'lsl-definitions', 'lsl_definitions.yaml');

describe('string parameter compatibility', () => {
	it('rejects integer and float where string is expected', async () => {
		const defs = await loadDefs(defsPath);
		const code = `default { state_entry() {
			integer i = 5; float f = 1.5; key k = (key)"00000000-0000-0000-0000-000000000000";
			llSay(0, i); llSay(0, f); llSay(0, k);
		} }`;
		const doc = docFrom(code, 'file:///string_param_compat.lsl');
		const { analysis } = runPipeline(doc, defs, { macros: {}, includePaths: [] });
		const wrong = analysis.diagnostics.filter(d => d.code === 'LSL011');
		expect(wrong).toHaveLength(2);
		expect(wrong.map(d => d.message)).toEqual([
			'Argument 2 of "llSay" expects string, got integer',
			'Argument 2 of "llSay" expects string, got float',
		]);
	});

	it('accepts key where string is expected', async () => {
		const defs = await loadDefs(defsPath);
		const code = `default { state_entry() {
			key k = (key)"00000000-0000-0000-0000-000000000000";
			llSay(0, k);
		} }`;
		const doc = docFrom(code, 'file:///string_param_key_compat.lsl');
		const { analysis } = runPipeline(doc, defs, { macros: {}, includePaths: [] });
		expect(analysis.diagnostics.filter(d => d.code === 'LSL011')).toHaveLength(0);
	});

	it('rejects integer llMessageLinked payloads without an explicit string cast', async () => {
		const defs = await loadDefs(defsPath);
		const code = `integer verbosityMode;
default { state_entry() {
	llMessageLinked(LINK_THIS, 8, verbosityMode, NULL_KEY);
	llMessageLinked(LINK_THIS, 8, (string)verbosityMode, NULL_KEY);
} }`;
		const doc = docFrom(code, 'file:///ll_message_linked_string_payload.lsl');
		const { analysis } = runPipeline(doc, defs, { macros: {}, includePaths: [] });
		const wrong = analysis.diagnostics.filter(d => d.code === 'LSL011');
		expect(wrong).toHaveLength(1);
		expect(wrong[0]?.message).toBe('Argument 3 of "llMessageLinked" expects string, got integer');
	});
});
