/* globals process, __dirname, setTimeout, clearTimeout */
const assert = require('node:assert/strict');
const { fork } = require('node:child_process');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');

async function startServer(t, initializationOptions = {}) {
	const child = fork(path.join(__dirname, '../out/index.js'), ['--node-ipc'], { silent: true });
	const pending = new Map();
	const notifications = [];
	const waiters = new Set();
	let sequence = 0;
	let stderr = '';
	child.stderr.on('data', chunk => { stderr += chunk; });
	child.on('message', message => {
		if (message.method && message.id !== undefined) {
			child.send({ jsonrpc: '2.0', id: message.id, result: null });
		} else if (message.id !== undefined) {
			const waiter = pending.get(message.id);
			if (waiter) {
				pending.delete(message.id);
				clearTimeout(waiter.timer);
				if (message.error) waiter.reject(new Error(JSON.stringify(message.error)));
				else waiter.resolve(message.result);
			}
		} else {
			notifications.push(message);
			for (const wake of waiters) wake();
		}
	});
	t.after(() => { child.kill(); });
	const send = (method, params) => child.send({ jsonrpc: '2.0', method, params });
	const request = (method, params) => new Promise((resolve, reject) => {
		const id = ++sequence;
		const timer = setTimeout(() => {
			pending.delete(id);
			reject(new Error(`Timed out: ${method}\n${stderr}`));
		}, 5000);
		pending.set(id, { resolve, reject, timer });
		child.send({ jsonrpc: '2.0', id, method, params });
	});
	const waitForNotification = (method, predicate = () => true, after = 0) => new Promise((resolve, reject) => {
		const find = () => {
			const match = notifications.slice(after).find(item => item.method === method && predicate(item.params));
			if (!match) return;
			clearTimeout(timer);
			waiters.delete(find);
			resolve(match.params);
		};
		const timer = setTimeout(() => {
			waiters.delete(find);
			reject(new Error(`Timed out waiting for ${method}\n${stderr}`));
		}, 5000);
		waiters.add(find);
		find();
	});
	await request('initialize', {
		processId: process.pid,
		rootUri: null,
		capabilities: { workspace: { configuration: true } },
		initializationOptions,
	});
	send('initialized', {});
	const uri = 'file:///protocol-test.lsl';
	let version = 0;
	return {
		uri, send, request, notifications, waitForNotification,
		async open(text) {
			send('textDocument/didOpen', { textDocument: { uri, languageId: 'lsl', version: ++version, text } });
			return waitForNotification('textDocument/publishDiagnostics', params => params.uri === uri);
		},
		async change(text) {
			const after = notifications.length;
			send('textDocument/didChange', { textDocument: { uri, version: ++version }, contentChanges: [{ text }] });
			return waitForNotification('textDocument/publishDiagnostics', params => params.uri === uri, after);
		},
	};
}

test('semantic deltas replace the client baseline after edits and fall back for unknown IDs', async t => {
	const server = await startServer(t);
	await server.open('integer value; default {state_entry(){value = 1;}}');
	const full = await server.request('textDocument/semanticTokens/full', { textDocument: { uri: server.uri } });
	assert.ok(full.data.length > 0);
	await server.change('integer value; default {state_entry(){value = 2;}}');
	const delta = await server.request('textDocument/semanticTokens/full/delta', { textDocument: { uri: server.uri }, previousResultId: full.resultId });
	assert.equal(delta.edits[0].deleteCount, full.data.length);
	const fallback = await server.request('textDocument/semanticTokens/full/delta', { textDocument: { uri: server.uri }, previousResultId: 'unknown' });
	assert.ok(Array.isArray(fallback.data));
	assert.equal(fallback.edits, undefined);
});

test('friendly diagnostic codes produce edits limited to the actual assignment operator', async t => {
	const server = await startServer(t);
	const { diagnostics } = await server.open('integer value; default {state_entry(){if(value /* = */ = 1) value++;}}');
	const suspicious = diagnostics.find(item => item.code === 'suspicious-assignment');
	assert.ok(suspicious);
	const actions = await server.request('textDocument/codeAction', {
		textDocument: { uri: server.uri }, range: suspicious.range, context: { diagnostics: [suspicious] },
	});
	assert.equal(actions.length, 1);
	const edit = actions[0].edit.changes[server.uri][0];
	assert.equal(edit.newText, '==');
	assert.equal(edit.range.end.character - edit.range.start.character, 1);
});

test('configuration changes revalidate macros and preserve unrelated diagnostic suppression', async t => {
	const server = await startServer(t, { macros: { FLAG: 1 }, diagnostics: { disable: ['LSL001'] } });
	await server.open('#if FLAG\ndefault {state_entry(){}}\n#else\ndefault {state_entry(){unknown();}}\n#endif');
	const after = server.notifications.length;
	server.send('workspace/didChangeConfiguration', { settings: { lsl: { macros: { FLAG: 0 } } } });
	const update = await server.waitForNotification('textDocument/publishDiagnostics', params => params.uri === server.uri, after);
	assert.ok(!update.diagnostics.some(item => item.code === 'LSL001'));
	const afterEnable = server.notifications.length;
	server.send('workspace/didChangeConfiguration', { settings: { lsl: { diagnostics: { disable: [] } } } });
	const enabled = await server.waitForNotification('textDocument/publishDiagnostics', params => params.uri === server.uri, afterEnable);
	assert.ok(enabled.diagnostics.some(item => item.code === 'LSL001'));
});

test('definition changes at the same path and clearing a custom path invalidate analysis', async t => {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lsl-protocol-defs-'));
	t.after(() => fs.rm(dir, { recursive: true, force: true }));
	const definitionsPath = path.join(dir, 'defs.json');
	const definitions = name => JSON.stringify({ version: 'test', constants: [{ name, type: 'integer', value: 1 }], functions: [], events: [{ name: 'state_entry', params: [] }] });
	await fs.writeFile(definitionsPath, definitions('EXTRA'));
	const server = await startServer(t, { definitionsPath });
	const initial = await server.open('integer value = EXTRA; default {state_entry(){value++;}}');
	assert.ok(!initial.diagnostics.some(item => item.code === 'LSL001'));
	await fs.writeFile(definitionsPath, definitions('DIFFERENT'));
	let after = server.notifications.length;
	server.send('workspace/didChangeConfiguration', { settings: { lsl: { definitionsPath } } });
	const updated = await server.waitForNotification('textDocument/publishDiagnostics', params => params.uri === server.uri, after);
	assert.ok(updated.diagnostics.some(item => item.code === 'LSL001'));
	after = server.notifications.length;
	server.send('workspace/didChangeConfiguration', { settings: { lsl: { definitionsPath: '' } } });
	await server.waitForNotification('textDocument/publishDiagnostics', params => params.uri === server.uri, after);
	const rendered = await server.request('lsl/renderScript', { uri: server.uri, mode: 'optimize' });
	assert.equal(rendered.ok, false);
});

test('semantic tokens can be disabled at initialization', async t => {
	const server = await startServer(t, { enableSemanticTokens: false });
	await server.open('default {state_entry(){}}');
	const full = await server.request('textDocument/semanticTokens/full', { textDocument: { uri: server.uri } });
	assert.deepEqual(full.data, []);
});
