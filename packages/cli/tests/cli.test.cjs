/* globals process, __dirname */
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');

async function fixture(t, source) {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lsl-cli-test-'));
	t.after(() => fs.rm(dir, { recursive: true, force: true }));
	const file = path.join(dir, 'script.lsl');
	await fs.writeFile(file, source);
	return file;
}

function run(...args) {
	return spawnSync(process.execPath, [path.join(__dirname, '../out/lsl-lsp.cjs'), ...args], { encoding: 'utf8' });
}

test('optimize --write rejects parser recovery and preserves every input in a batch', async t => {
	const valid = 'default { state_entry() { llOwnerSay("ok"); } }\n';
	const broken = 'default { state_entry() { llOwnerSay("broken"; } }\n';
	const first = await fixture(t, valid);
	const second = await fixture(t, broken);
	const result = run('optimize', '--write', first, second);
	assert.equal(result.status, 1);
	assert.match(result.stderr, /cannot optimize/);
	assert.equal(await fs.readFile(first, 'utf8'), valid);
	assert.equal(await fs.readFile(second, 'utf8'), broken);
});

test('optimize refuses incomplete output from missing includes even with diagnostics suppressed', async t => {
	const source = '#include "missing.lsl"\ndefault { state_entry() { llOwnerSay("ok"); } }\n';
	const file = await fixture(t, source);
	const result = run('optimize', '--write', '--disable', 'LSL000', file);
	assert.equal(result.status, 1);
	assert.match(result.stderr, /cannot optimize/);
	assert.equal(await fs.readFile(file, 'utf8'), source);
});

test('repeated --disable options accumulate diagnostic codes', async t => {
	const file = await fixture(t, 'integer unused; default { state_entry() {} }');
	const result = run('check', '--json', '--disable', 'unused-var', '--disable', 'empty-event-body', file);
	assert.equal(result.status, 0, result.stdout + result.stderr);
	assert.deepEqual(JSON.parse(result.stdout)[0].diagnostics, []);
});
