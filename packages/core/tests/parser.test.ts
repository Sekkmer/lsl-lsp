import { describe, it, expect } from 'vitest';
import { docFrom, runPipeline } from './testUtils';
import { loadTestDefs } from './loadDefs.testutil';
import { LSL_DIAGCODES } from '../src/parser';

describe('parser/analyzer', () => {
	it('finds states, events, functions, variables', async () => {
		const defs = await loadTestDefs();
		const doc = docFrom(`
default {
	state_entry() {
	integer g = 1;
	llSay(0, "ok");
	}
}

key f() {
	return llGetOwner();
}
`);
		const { analysis } = runPipeline(doc, defs);
		const names = analysis.decls.map(d => d.name);
		expect(names).toContain('default');	 // state
		expect(names).toContain('g');		 // local var
		expect(names).toContain('f');		 // function
		expect(analysis.calls.some(c => c.name === 'llSay' && c.args === 2)).toBe(true);
	});

	it('reports event outside state', async () => {
		const defs = await loadTestDefs();
		const doc = docFrom('touch_start(integer n) { }');
		const { analysis } = runPipeline(doc, defs);
		expect(analysis.diagnostics.some(d => d.code === LSL_DIAGCODES.EVENT_OUTSIDE_STATE)).toBe(true);
	});

	it('reports event outside state after a leading preprocessor directive', async () => {
		const defs = await loadTestDefs();
		const doc = docFrom('#define DEBUG 1\ntouch_start(integer n) { }');
		const { analysis } = runPipeline(doc, defs);
		expect(analysis.diagnostics.some(d => d.code === LSL_DIAGCODES.EVENT_OUTSIDE_STATE)).toBe(true);
	});

	it('does not report event outside state for commented event signatures', async () => {
		const defs = await loadTestDefs();
		const doc = docFrom([
			'/*',
			'touch_start(integer n) { }',
			'*/',
			'string note = "state_entry()";',
		].join('\n'));
		const { analysis } = runPipeline(doc, defs);
		expect(analysis.diagnostics.some(d => d.code === LSL_DIAGCODES.EVENT_OUTSIDE_STATE)).toBe(false);
	});

	it('does not report event outside state for inactive preprocessor branches', async () => {
		const defs = await loadTestDefs();
		const doc = docFrom([
			'#if 0',
			'touch_start(integer n) { }',
			'#endif',
		].join('\n'));
		const { analysis } = runPipeline(doc, defs);
		expect(analysis.diagnostics.some(d => d.code === LSL_DIAGCODES.EVENT_OUTSIDE_STATE)).toBe(false);
	});

	it('reports wrong arity', async () => {
		const defs = await loadTestDefs();
		const doc = docFrom('default{state_entry(){ llSay(0); }}');
		const { analysis } = runPipeline(doc, defs);
		const wrong = analysis.diagnostics.find(d => d.code === LSL_DIAGCODES.WRONG_ARITY);
		expect(wrong).toBeTruthy();
	});

	it('reports unknown identifier', async () => {
		const defs = await loadTestDefs();
		const doc = docFrom('default{state_entry(){ fooBar(1,2,3); }} ');
		const { analysis } = runPipeline(doc, defs);
		expect(analysis.diagnostics.some(d => d.code === LSL_DIAGCODES.UNKNOWN_IDENTIFIER)).toBe(true);
	});

	it('reports lowercase boolean-like identifiers as unknown', async () => {
		const defs = await loadTestDefs();
		const doc = docFrom('integer f() { return true; } default { state_entry() { } }');
		const { analysis } = runPipeline(doc, defs);
		expect(analysis.diagnostics.some(d => d.code === LSL_DIAGCODES.UNKNOWN_IDENTIFIER && d.message.includes('true'))).toBe(true);
	});

	it('reports empty states as syntax errors', async () => {
		const defs = await loadTestDefs();
		const doc = docFrom('default { } state ready { }');
		const { analysis } = runPipeline(doc, defs);
		expect(analysis.diagnostics.filter(d => d.code === 'LSL000' && /at least one event handler/.test(d.message))).toHaveLength(2);
	});

	it('marks unused globals', async () => {
		const defs = await loadTestDefs();
		const doc = docFrom('integer X; default{state_entry(){}}');
		const { analysis } = runPipeline(doc, defs);
		expect(analysis.diagnostics.some(d => d.code === LSL_DIAGCODES.UNUSED_VAR)).toBe(true);
	});

	it('accepts quaternion as a rotation type alias', async () => {
		const defs = await loadTestDefs();
		const doc = docFrom(`
quaternion q = <0, 0, 0, 1>;

quaternion spin(quaternion input) {
	return input * q;
}

default {
	state_entry() {
		rotation r = spin(q);
		llOwnerSay((string)r);
	}
}
`);
		const { analysis } = runPipeline(doc, defs);
		const msg = analysis.diagnostics.map(d => `${d.code}:${d.message}`).join('\n');
		expect(msg).not.toContain('unexpected token keyword');
		expect(msg).not.toContain('expected type');
		expect(analysis.decls.find(d => d.name === 'q')?.type).toBe('rotation');
		expect(analysis.decls.find(d => d.name === 'spin')?.type).toBe('rotation');
	});

	it('canonicalizes quaternion casts as rotation', async () => {
		const defs = await loadTestDefs();
		const doc = docFrom(`
default {
	state_entry() {
		rotation r = (quaternion)"<0,0,0,1>";
		llOwnerSay((string)r);
	}
}
`);
		const { analysis } = runPipeline(doc, defs);
		const msg = analysis.diagnostics.map(d => `${d.code}:${d.message}`).join('\n');
		expect(msg).not.toContain('Cannot assign quaternion to rotation');
		expect(msg).not.toContain('Cannot cast');
	});
});

describe('parser', () => {
	it('forbids using reserved identifier "event" as variable name', async () => {
		const defs = await loadTestDefs();
		const doc = docFrom('integer event = 0;');
		const { analysis } = runPipeline(doc, defs);
		const msg = analysis.diagnostics.map(d => d.message).join('\n');
		expect(msg).toMatch(/reserved/);
	});

	it('forbids using reserved identifier "event" as function name', async () => {
		const defs = await loadTestDefs();
		const doc = docFrom('integer event() { return 0; }');
		const { analysis } = runPipeline(doc, defs);
		const msg = analysis.diagnostics.map(d => d.message).join('\n');
		expect(msg).toMatch(/reserved/);
	});

	it('forbids using reserved identifier "event" as parameter name', async () => {
		const defs = await loadTestDefs();
		const doc = docFrom('integer ok(integer event) { return event; }');
		const { analysis } = runPipeline(doc, defs);
		const msg = analysis.diagnostics.map(d => d.message).join('\n');
		expect(msg).toMatch(/reserved/);
	});

	it('forbids using keyword as variable name', async () => {
		const defs = await loadTestDefs();
		const doc = docFrom('integer state = 0;');
		const { analysis } = runPipeline(doc, defs);
		const msg = analysis.diagnostics.map(d => d.message).join('\n');
		expect(msg).toMatch(/reserved/);
	});

	it('forbids using keyword as function name', async () => {
		const defs = await loadTestDefs();
		const doc = docFrom('integer if() { return 0; }');
		const { analysis } = runPipeline(doc, defs);
		const msg = analysis.diagnostics.map(d => d.message).join('\n');
		expect(msg).toMatch(/reserved/);
	});

	it('forbids using type as parameter name', async () => {
		const defs = await loadTestDefs();
		const doc = docFrom('integer ok(integer integer) { return 0; }');
		const { analysis } = runPipeline(doc, defs);
		const msg = analysis.diagnostics.map(d => d.message).join('\n');
		expect(msg).toMatch(/reserved/);
	});
});
