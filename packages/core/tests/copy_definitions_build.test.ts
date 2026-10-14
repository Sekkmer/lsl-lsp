import { spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const tempDirs: string[] = [];

afterEach(async () => {
	await Promise.all(tempDirs.splice(0).map(dir => fs.rm(dir, { recursive: true, force: true })));
});

async function isolatedBuildLayout() {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lsl-copy-defs-test-'));
	tempDirs.push(dir);
	const script = path.join(dir, 'packages/core/scripts/copy-defs.cjs');
	await fs.mkdir(path.dirname(script), { recursive: true });
	await fs.copyFile(path.resolve(__dirname, '../scripts/copy-defs.cjs'), script);
	return {
		script,
		source: path.join(dir, 'third_party/lsl-definitions/lsl_definitions.yaml'),
		destination: path.join(dir, 'build/lsl_definitions.yaml'),
	};
}

describe('mandatory bundled definition copying', () => {
	it('fails the native build step when the required submodule file is missing', async () => {
		const layout = await isolatedBuildLayout();
		const result = spawnSync(process.execPath, [layout.script, layout.destination], { encoding: 'utf8' });
		expect(result.status).toBe(1);
		expect(result.stderr).toContain('[defs] copy defs failed:');
		expect(result.stderr).toContain('ENOENT');
		await expect(fs.access(layout.destination)).rejects.toThrow();
	});

	it('copies required definitions to the requested artifact directory', async () => {
		const layout = await isolatedBuildLayout();
		await fs.mkdir(path.dirname(layout.source), { recursive: true });
		const source = 'version: isolated-build-fixture\n';
		await fs.writeFile(layout.source, source);
		const result = spawnSync(process.execPath, [layout.script, layout.destination], { encoding: 'utf8' });
		expect(result.status).toBe(0);
		expect(await fs.readFile(layout.destination, 'utf8')).toBe(source);
	});
});
