import { describe, it, expect } from 'vitest';
import { docFrom, runPipeline, semToSpans } from './testUtils';
import { loadTestDefs } from './loadDefs.testutil';
import { semanticTokensLegend } from '../src/semtok';

function idx(name: string) {
	return (semanticTokensLegend.tokenTypes as string[]).indexOf(name);
}
function hasMod(mods: number, name: string) {
	const bit = 1 << (semanticTokensLegend.tokenModifiers as string[]).indexOf(name);
	return (mods & bit) !== 0;
}

describe('parameters are always readonly', () => {
	it('function parameter tokens have readonly at decl and uses when never written', async () => {
		const defs = await loadTestDefs();
		const doc = docFrom(`
integer foo(integer p) {
	integer x = p;
	return p;
}

default {
	state_entry() {
		integer y = foo(42);
	}
}
`);
		const { sem } = runPipeline(doc, defs);
		const spans = semToSpans(doc, sem);
		const paramType = idx('parameter');
		const text = doc.getText();
		const lines = text.split(/\r?\n/);
		function textAt(s: { line: number; char: number; len: number }) { const line = lines[s.line] ?? ''; return line.slice(s.char, s.char + s.len); }
		const pSpans = spans.filter(s => s.type === paramType && textAt(s) === 'p');
		// Expect at least declaration + one use
		expect(pSpans.length).toBeGreaterThanOrEqual(2);
		expect(pSpans.every(s => hasMod(s.mod, 'readonly'))).toBe(true);
	});

	it('event parameter tokens have readonly at decl and uses when never written', async () => {
		const defs = await loadTestDefs();
		const doc = docFrom(`
default {
	touch_start(integer n) {
		integer z = n;
		if (n > 0) { integer w = n; }
	}
}
`);
		const { sem } = runPipeline(doc, defs);
		const spans = semToSpans(doc, sem);
		const paramType = idx('parameter');
		const text = doc.getText();
		const lines = text.split(/\r?\n/);
		function textAt(s: { line: number; char: number; len: number }) { const line = lines[s.line] ?? ''; return line.slice(s.char, s.char + s.len); }
		const nSpans = spans.filter(s => s.type === paramType && textAt(s) === 'n');
		expect(nSpans.length).toBeGreaterThanOrEqual(2);
		expect(nSpans.every(s => hasMod(s.mod, 'readonly'))).toBe(true);
	});

	it('function parameter loses readonly when assigned', async () => {
		const defs = await loadTestDefs();
		const doc = docFrom(`
integer foo(integer p) {
	p = 3;
	return p;
}
`);
		const { sem } = runPipeline(doc, defs);
		const spans = semToSpans(doc, sem);
		const paramType = idx('parameter');
		const text = doc.getText();
		const lines = text.split(/\r?\n/);
		function textAt(s: { line: number; char: number; len: number }) { const line = lines[s.line] ?? ''; return line.slice(s.char, s.char + s.len); }
		const pSpans = spans.filter(s => s.type === paramType && textAt(s) === 'p');
		// Expect declaration + uses present, but not all readonly once assigned
		expect(pSpans.length).toBeGreaterThanOrEqual(2);
		expect(pSpans.every(s => hasMod(s.mod, 'readonly'))).toBe(false);
	});

	it('event parameter loses readonly when assigned', async () => {
		const defs = await loadTestDefs();
		const doc = docFrom(`
default {
	touch_start(integer n) {
		n = 5;
		integer z = n;
	}
}
`);
		const { sem } = runPipeline(doc, defs);
		const spans = semToSpans(doc, sem);
		const paramType = idx('parameter');
		const text = doc.getText();
		const lines = text.split(/\r?\n/);
		function textAt(s: { line: number; char: number; len: number }) { const line = lines[s.line] ?? ''; return line.slice(s.char, s.char + s.len); }
		const nSpans = spans.filter(s => s.type === paramType && textAt(s) === 'n');
		expect(nSpans.length).toBeGreaterThanOrEqual(2);
		expect(nSpans.every(s => hasMod(s.mod, 'readonly'))).toBe(false);
	});

	it('function with 3 params: mixed reads first, writes later (readonly until write)', async () => {
		const defs = await loadTestDefs();
		const doc = docFrom(`
integer foo(integer a, integer b, integer c) {
	integer x = a + b + c; // all reads
	if (x > 0) {
		// still only reads
		integer y = b + c;
	}
	// later writes, not on first lines
	b++;
	c += 2;
	return a + b + c; // reads after writes for b/c
}
`);
		const { sem } = runPipeline(doc, defs);
		const spans = semToSpans(doc, sem);
		const paramType = idx('parameter');
		const text = doc.getText();
		const lines = text.split(/\r?\n/);
		function textAt(s: { line: number; char: number; len: number }) { const line = lines[s.line] ?? ''; return line.slice(s.char, s.char + s.len); }
		const aSpans = spans.filter(s => s.type === paramType && textAt(s) === 'a');
		const bSpans = spans.filter(s => s.type === paramType && textAt(s) === 'b');
		const cSpans = spans.filter(s => s.type === paramType && textAt(s) === 'c');
		// a: never written -> all readonly
		expect(aSpans.length).toBeGreaterThanOrEqual(2);
		expect(aSpans.every(s => hasMod(s.mod, 'readonly'))).toBe(true);
		// b/c: have at least one readonly (pre-write) and one modification; not all readonly
		expect(bSpans.some(s => hasMod(s.mod, 'readonly'))).toBe(true);
		expect(bSpans.some(s => hasMod(s.mod, 'modification'))).toBe(true);
		expect(bSpans.every(s => hasMod(s.mod, 'readonly'))).toBe(false);
		expect(cSpans.some(s => hasMod(s.mod, 'readonly'))).toBe(true);
		expect(cSpans.some(s => hasMod(s.mod, 'modification'))).toBe(true);
		expect(cSpans.every(s => hasMod(s.mod, 'readonly'))).toBe(false);
	});

	it('event with 4 params: reads first, then assign some later', async () => {
		const defs = await loadTestDefs();
		const doc = docFrom(`
default {
	http_response(key rid, integer status, list metadata, string body) {
		integer s = status; // read
		list md = metadata; // read
		string b = body; // read
		// later assignments, not on first lines
		if (s > 0) { rid = NULL_KEY; }
		for (integer i = 0; i < 2; i++) { status += i; }
		llOwnerSay((string)status);
	}
}
`);
		const { sem } = runPipeline(doc, defs);
		const spans = semToSpans(doc, sem);
		const paramType = idx('parameter');
		const text = doc.getText();
		const lines = text.split(/\r?\n/);
		function textAt(s: { line: number; char: number; len: number }) { const line = lines[s.line] ?? ''; return line.slice(s.char, s.char + s.len); }
		const statusSpans = spans.filter(s => s.type === paramType && textAt(s) === 'status');
		const ridSpans = spans.filter(s => s.type === paramType && textAt(s) === 'rid');
		const metaSpans = spans.filter(s => s.type === paramType && textAt(s) === 'metadata');
		const bodySpans = spans.filter(s => s.type === paramType && textAt(s) === 'body');
		// metadata/body never written -> all readonly
		expect(metaSpans.length).toBeGreaterThanOrEqual(2);
		expect(metaSpans.every(s => hasMod(s.mod, 'readonly'))).toBe(true);
		expect(bodySpans.length).toBeGreaterThanOrEqual(2);
		expect(bodySpans.every(s => hasMod(s.mod, 'readonly'))).toBe(true);
		// status/rid written later -> have readonly before first write and a modification token; not all readonly
		expect(statusSpans.some(s => hasMod(s.mod, 'readonly'))).toBe(true);
		expect(statusSpans.some(s => hasMod(s.mod, 'modification'))).toBe(true);
		expect(statusSpans.every(s => hasMod(s.mod, 'readonly'))).toBe(false);
		expect(ridSpans.some(s => hasMod(s.mod, 'readonly'))).toBe(true);
		expect(ridSpans.some(s => hasMod(s.mod, 'modification'))).toBe(true);
		expect(ridSpans.every(s => hasMod(s.mod, 'readonly'))).toBe(false);
	});

	it('event listen: message should be modification and id readonly until write', async () => {
		const defs = await loadTestDefs();
		const doc = docFrom(`
default {
	listen(integer channel, string _name, key id, string message)
	{
		if (id != llGetOwner()) {
			return;
		}
		message = llStringTrim(message, STRING_TRIM);
		HandleCurrentMenu(id, message);
	}
}
`);
		const { sem } = runPipeline(doc, defs);
		const spans = semToSpans(doc, sem);
		const paramType = idx('parameter');
		const text = doc.getText();
		const lines = text.split(/\r?\n/);
		function textAt(s: { line: number; char: number; len: number }) { const line = lines[s.line] ?? ''; return line.slice(s.char, s.char + s.len); }
		const idSpans = spans.filter(s => s.type === paramType && textAt(s) === 'id');
		const msgSpans = spans.filter(s => s.type === paramType && textAt(s) === 'message');
		// id: only read -> all readonly
		expect(idSpans.length).toBeGreaterThanOrEqual(2);
		expect(idSpans.every(s => hasMod(s.mod, 'readonly'))).toBe(true);
		// message: assigned -> has a modification; not all readonly
		expect(msgSpans.some(s => hasMod(s.mod, 'modification'))).toBe(true);
		expect(msgSpans.every(s => hasMod(s.mod, 'readonly'))).toBe(false);
	});
});
