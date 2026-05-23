import { describe, it, expect } from 'vitest';
import { docFrom, runPipeline } from './testUtils';
import { loadTestDefs } from './loadDefs.testutil';
import { loadDefs } from '../src/defs';
import path from 'node:path';

const officialDefsPath = path.join(__dirname, '..', '..', 'third_party', 'lsl-definitions', 'lsl_definitions.yaml');

describe('defs metadata: god-mode and deprecated', () => {
	it('errors when calling a god-mode-only function', async () => {
		const defs = await loadTestDefs();
		const doc = docFrom('default { state_entry(){ llGodLikeRezObject(); } }');
		const { analysis } = runPipeline(doc, defs);
		const diag = analysis.diagnostics.find(d => d.code === 'LSL090');
		expect(diag).toBeTruthy();
		expect(diag?.message).toContain('requires god mode');
	});

	it('warns when calling a deprecated function and surfaces the message', async () => {
		const defs = await loadTestDefs();
		const doc = docFrom('default { state_entry(){ llCloud(<0,0,0>); } }');
		const { analysis } = runPipeline(doc, defs);
		const diag = analysis.diagnostics.find(d => d.code === 'LSL091');
		expect(diag).toBeTruthy();
		expect(diag?.message).toContain('deprecated');
		expect(diag?.message).toContain('llSetLinkPrimitiveParamsFast');
	});

	it('loads object-shaped deprecated metadata from official definitions', async () => {
		const defs = await loadDefs(officialDefsPath);
		const doc = docFrom('default { state_entry(){ llMakeExplosion(1, 1.0, 1.0, 1.0, 1.0, "", <0,0,0>); } }');
		const { analysis } = runPipeline(doc, defs);
		const diag = analysis.diagnostics.find(d => d.code === 'LSL091');
		expect(diag).toBeTruthy();
		expect(diag?.message).toContain('deprecated');
		expect(diag?.message).toContain('llParticleSystem');
	});
});
