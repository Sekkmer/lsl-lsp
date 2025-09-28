import { describe, it, expect } from 'vitest';
import { docFrom, runPipeline } from './testUtils';
import { hoverToString } from './testUtils';
import { lslHover } from '../src/hover';
import { loadTestDefs } from './loadDefs.testutil';

describe('hover: parameter docs inside calls', async () => {
	const defs = await loadTestDefs();

	it('shows doc for the active parameter (index 0)', () => {
		const doc = docFrom('default { state_entry() { llSay(0, "hi"); } }');
		const { analysis, pre } = runPipeline(doc, defs);
		const pos = doc.positionAt(doc.getText().indexOf('0'));
		const hv = lslHover(doc, { position: pos }, defs, analysis, pre);
		expect(hv).toBeTruthy();
		const md = hoverToString(hv!);
		expect(md).toContain('llSay(');
		expect(md).toContain('**Cost:**');
		expect(md).toContain('Energy: 10');
		expect(md).toContain('Sleep: 0.1s');
		expect(md).toContain('Experience-only');
		expect(md).toContain('Parameter: channel');
		expect(md).toContain('public chat');
	});

	it('shows doc for index 1 (second parameter)', () => {
		const code = 'default { state_entry() { llSay(0, "hi"); } }';
		const doc = docFrom(code);
		const { analysis, pre } = runPipeline(doc, defs);
		const idx = code.indexOf('"hi"');
		const pos = doc.positionAt(idx + 1);
		const hv = lslHover(doc, { position: pos }, defs, analysis, pre);
		const md = hoverToString(hv!);
		expect(md).toContain('Parameter: msg');
		expect(md).toContain('message to say');
	});

	it('hover shows event param type on usage inside body', async () => {
		const defs = await loadTestDefs();
		const code = [
			'default {',
			'	touch_start(integer total_number) {',
			'	integer x = total_number;',
			'	}',
			'}'
		].join('\n');
		const doc = docFrom(code);
		const { analysis, pre } = runPipeline(doc, defs);
		const usageIdx = code.indexOf('total_number', code.indexOf('{', code.indexOf('touch_start')));
		const hv = lslHover(doc, { position: doc.positionAt(usageIdx + 1) }, defs, analysis, pre);
		expect(hv).toBeTruthy();
		const md = hoverToString(hv!);
		expect(md).toContain('integer total_number');
		expect(md).toMatch(/Parameter:\s*total_number/i);
		expect(md).toContain('Number of detected touches.');
	});
});
