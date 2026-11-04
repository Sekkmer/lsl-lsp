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
	// Exercise the drive casing returned by Windows path.resolve(), even when TEMP uses a lowercase drive.
	return file.replace(/^[a-z]:/i, drive => drive.toUpperCase());
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

test('check accepts a transition to a declared named state', async t => {
	const file = await fixture(t, 'default { state_entry() { state ready; } } state ready { state_entry() { llOwnerSay("ready"); } }');
	const result = run('check', '--json', file);
	assert.equal(result.status, 0, result.stdout + result.stderr);
	assert.deepEqual(JSON.parse(result.stdout)[0].diagnostics, []);
});

test('check resolves includes relative to the root file', async t => {
	const file = await fixture(t, '#include "constants.lslh"\ndefault { state_entry() { llOwnerSay((string)sharedValue); } }');
	await fs.writeFile(path.join(path.dirname(file), 'constants.lslh'), 'integer sharedValue = 1;');
	const result = run('check', '--json', file);
	assert.equal(result.status, 0, result.stdout + result.stderr);
	assert.deepEqual(JSON.parse(result.stdout)[0].diagnostics, []);
});

test('check analyzes references inside root event bodies', async t => {
	const file = await fixture(t, 'default { state_entry() { missingFunction(); } }');
	const result = run('check', '--json', file);
	assert.equal(result.status, 1, result.stdout + result.stderr);
	assert.ok(JSON.parse(result.stdout)[0].diagnostics.some(d => /missingFunction/.test(d.message)));
});

test('check retains parser diagnostics for duplicate named states', async t => {
	const file = await fixture(t, 'default { state_entry() {} } state ready { state_entry() {} } state ready { state_entry() {} }');
	const result = run('check', '--json', file);
	assert.equal(result.status, 1, result.stdout + result.stderr);
	assert.ok(JSON.parse(result.stdout)[0].diagnostics.some(d => d.code === 'LSL070' && /state ready/.test(d.message)));
});

test('check retains root preprocessor diagnostics', async t => {
	const file = await fixture(t, '#endif\ndefault { state_entry() { llOwnerSay("ok"); } }');
	const result = run('check', '--json', file);
	assert.equal(result.status, 1, result.stdout + result.stderr);
	assert.ok(JSON.parse(result.stdout)[0].diagnostics.some(d => /Stray #endif/i.test(d.message)));
});

test('check retains root syntax errors', async t => {
	const file = await fixture(t, 'default { state_entry() { llOwnerSay("broken"; } }');
	const result = run('check', '--json', file);
	assert.equal(result.status, 1, result.stdout + result.stderr);
	assert.ok(JSON.parse(result.stdout)[0].diagnostics.some(d => d.severity === 'error'));
});
