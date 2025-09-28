import { describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { loadDefs } from '../src/defs';

const OFFICIAL_YAML_PATH = path.resolve(__dirname, '..', '..', 'third_party', 'lsl-definitions', 'lsl_definitions.yaml');

describe('loadDefs with official YAML source', () => {
	it('loads core definitions', async () => {
		const defs = await loadDefs(OFFICIAL_YAML_PATH);
		expect(defs.funcs.has('llAbs')).toBe(true);
		expect(defs.consts.get('ACTIVE')).toBeDefined();
		expect(defs.events.has('state_entry')).toBe(true);
	});

	it('honours override file from environment', async () => {
		const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'lsl-overrides-'));
		const overridePath = path.join(tempDir, 'overrides.json');
		await fs.writeFile(overridePath, JSON.stringify({
			constants: { ACTIVE: { wiki: null } },
		}, null, 2));
		const previous = process.env.LSL_DEFS_OVERRIDES;
		process.env.LSL_DEFS_OVERRIDES = overridePath;
		try {
			const defs = await loadDefs(OFFICIAL_YAML_PATH);
			expect(defs.consts.get('ACTIVE')?.wiki).toBeUndefined();
		} finally {
			if (previous === undefined) delete process.env.LSL_DEFS_OVERRIDES;
			else process.env.LSL_DEFS_OVERRIDES = previous;
		}
	});
});
