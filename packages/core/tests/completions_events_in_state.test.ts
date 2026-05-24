import { describe, it, expect } from 'vitest';
import { docFrom, runPipeline } from './testUtils';
import { loadTestDefs } from './loadDefs.testutil';
import { lslCompletions } from '../src/completions';

function labels(items: { label: string }[]) { return items.map(i => i.label); }

describe('event completions inside state', async () => {
	const defs = await loadTestDefs();

	it('only suggests events at state top-level', () => {
		const doc = docFrom('state S { \n\t\n}');
		const { analysis, pre } = runPipeline(doc, defs);
		const pos = doc.positionAt(doc.getText().indexOf('{') + 3);
		const items = lslCompletions(doc, { textDocument: { uri: doc.uri }, position: pos }, defs, analysis, pre);
		const ls = labels(items);
		// Should contain known events
		expect(ls).toContain('state_entry');
		expect(ls).toContain('touch_start');
		// Should not contain keywords/types/constants (heuristic check)
		expect(ls).not.toContain('if');
		expect(ls).not.toContain('integer');
		expect(ls).not.toContain('TRUE');
	});

	it('inserts full typed signature snippet', () => {
		const doc = docFrom('default { \n\t\n}');
		const { analysis, pre } = runPipeline(doc, defs);
		const pos = doc.positionAt(doc.getText().indexOf('{') + 3);
		const items = lslCompletions(doc, { textDocument: { uri: doc.uri }, position: pos }, defs, analysis, pre);
		const touch = items.find(i => i.label === 'touch_start')!;
		expect(touch).toBeTruthy();
		const insert = touch.insertText as string;
		expect(insert).toMatch(/touch_start\(integer\s+total_number\)\s*\{[\s\S]*\}/);
	});

	it('does not suggest already-declared events and flags duplicates', () => {
		const doc = docFrom('default {\n\ttouch_start(integer total_number) { }\n\t\n}');
		const { analysis, pre } = runPipeline(doc, defs);
		// Position after the first event to request more completions at state top-level
		const pos = doc.positionAt(doc.getText().lastIndexOf('\n', doc.getText().lastIndexOf('}')));
		const items = lslCompletions(doc, { textDocument: { uri: doc.uri }, position: pos }, defs, analysis, pre);
		const ls = labels(items);
		expect(ls).not.toContain('touch_start');
		// Now add a duplicate event and ensure analysis flags duplicate
		const doc2 = docFrom('default {\n\ttouch_start(integer total_number) { }\n\ttouch_start(integer total_number) { }\n}');
		const { analysis: a2 } = runPipeline(doc2, defs);
		const dup = a2.diagnostics.find(d => d.code === 'LSL070');
		expect(dup).toBeTruthy();
	});
});
