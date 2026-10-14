/* globals __dirname, process */
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');

async function releaseFixture(t) {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lsl-simulator-release-'));
	t.after(() => fs.rm(dir, { recursive: true, force: true }));
	for (const file of ['lsl-simulator.cjs', 'lsl-simulator.cjs.map', 'lsl-simulator.d.cts', 'lsl-simulator.LICENSE.txt']) {
		await fs.copyFile(path.join(__dirname, '../out', file), path.join(dir, file));
	}
	return dir;
}

test('standalone release runs a multi-object fixture with no workspace dependencies', async t => {
	const dir = await releaseFixture(t);
	const example = path.join(__dirname, '../examples/message-world');
	for (const object of ['attachment', 'panel']) {
		await fs.cp(path.join(example, object), path.join(dir, object), { recursive: true });
	}
	// This switch needs llGetOwner's return type from the embedded definitions.
	await fs.writeFile(path.join(dir, 'attachment/linkset/prims/worker/scripts/worker.lsl'), `
		// lsl-lsp extensions: switch
		default { link_message(integer sender, integer number, string text, key id) {
			if (number == 200) switch (llGetOwner()) {
				case llGetOwner():
					llLinksetDataWrite("worker:received", text);
					llMessageLinked(LINK_ROOT, 201, "pong", id);
					break;
			}
		} }
	`);
	await fs.writeFile(path.join(dir, 'consumer.cjs'), `
		const assert = require('node:assert/strict');
		const { SimulatorWorld, intValue, loadLinksetProject } = require('./lsl-simulator.cjs');
		(async () => {
			const world = new SimulatorWorld();
			const { linkset: attachment } = await loadLinksetProject('./attachment', { world });
			const { linkset: panel } = await loadLinksetProject('./panel', { world });
			world.start(); world.runUntilIdle();
			world.fireEvent(panel.prim(1).script('panel.lsl'), 'touch_start', [intValue(1)]);
			world.runUntilIdle();
			assert.equal(attachment.data.get('worker:received'), 'ping');
			assert.equal(panel.data.get('panel:reply'), 'pong');
			assert.equal(panel.data.has('worker:received'), false);
			console.log('standalone request/reply passed');
		})().catch(error => { console.error(error); process.exitCode = 1; });
	`);
	const result = spawnSync(process.execPath, ['--enable-source-maps', 'consumer.cjs'], {
		cwd: dir,
		encoding: 'utf8',
		env: { ...process.env, NODE_PATH: '' },
		timeout: 15_000,
	});
	assert.equal(result.status, 0, result.stdout + result.stderr);
	assert.match(result.stdout, /standalone request\/reply passed/);
	const map = JSON.parse(await fs.readFile(path.join(dir, 'lsl-simulator.cjs.map'), 'utf8'));
	assert.equal(map.version, 3);
	assert.ok(map.sources.some(source => source.endsWith('src/world.ts')));
	assert.equal(map.sourcesContent.length, map.sources.length);
	assert.match(await fs.readFile(path.join(dir, 'lsl-simulator.LICENSE.txt'), 'utf8'), /Linden Research/);
});

test('downloaded CJS types work without the core package or Node type dependencies', async t => {
	const dir = await releaseFixture(t);
	await fs.writeFile(path.join(dir, 'consumer.cts'), `
		import { SimulatorWorld, intValue, loadLinksetProject } from './lsl-simulator.cjs';
		const world = new SimulatorWorld();
		world.addLinkset({ name: 'test', key: 'object', owner: 'avatar', attached: false });
		const value = intValue(1);
		void loadLinksetProject('./attachment', { world, owner: 'avatar' });
		void value;
		// @ts-expect-error Owner must retain its public string type.
		void loadLinksetProject('./attachment', { owner: 123 });
	`);
	await fs.writeFile(path.join(dir, 'tsconfig.json'), JSON.stringify({
		compilerOptions: {
			strict: true, noEmit: true, target: 'ES2022', module: 'NodeNext',
			moduleResolution: 'NodeNext', types: [], skipLibCheck: false,
		},
		files: ['consumer.cts'],
	}));
	const result = spawnSync(process.execPath, [require.resolve('typescript/lib/tsc.js'), '-p', dir], {
		cwd: dir,
		encoding: 'utf8',
		timeout: 30_000,
	});
	assert.equal(result.status, 0, result.stdout + result.stderr);
});
