import { describe, expect, it } from 'vitest';
import { scriptWorld } from './helpers.js';

describe('LSL execution semantics', () => {
	it('evaluates binary operands right to left and arguments/list elements left to right', () => {
		const { world, script } = scriptWorld(`
			string calls;
			integer left() { calls += "L"; return 1; }
			integer right() { calls += "R"; return 2; }
			integer pair(integer a, integer b) { return a + b; }
			string binary; string arguments; string elements;
			integer eager; integer result;
			default { state_entry() {
				result = left() + right(); binary = calls; calls = "";
				result = pair(left(), right()); arguments = calls; calls = "";
				list values = [left(), right()]; elements = calls; calls = "";
				eager = FALSE && left();
			} }
		`);
		world.start(); world.runUntilIdle();
		expect(script.getGlobal('binary')).toMatchObject({ value: 'RL' });
		expect(script.getGlobal('arguments')).toMatchObject({ value: 'LR' });
		expect(script.getGlobal('elements')).toMatchObject({ value: 'LR' });
		expect(script.getGlobal('calls')).toMatchObject({ value: 'L' });
		expect(script.getGlobal('result')).toMatchObject({ value: 3 });
	});

	it('uses list lengths for comparison and gives list concatenation priority over string concatenation', () => {
		const { world, script } = scriptWorld(`
			integer equal; integer difference; integer missing;
			list joined;
			default { state_entry() {
				equal = [1] == [2]; difference = [1, 2] != [9]; missing = [] != [1, 2, 3];
				joined = "prefix" + [1, 2];
			} }
		`);
		world.start(); world.runUntilIdle();
		expect(script.getGlobal('equal')).toMatchObject({ value: 1 });
		expect(script.getGlobal('difference')).toMatchObject({ value: 1 });
		expect(script.getGlobal('missing')).toMatchObject({ value: -3 });
		expect(script.getGlobal('joined')).toMatchObject({
			type: 'list', value: [{ value: 'prefix' }, { value: 1 }, { value: 2 }],
		});
	});

	it('branches on LSL key and rotation truth values', () => {
		const { world, script } = scriptWorld(`
			integer bits;
			default { state_entry() {
				if (ZERO_ROTATION) bits = bits | 1;
				if ((key)"invalid") bits = bits | 2;
				if ((key)"ABCDEFAB-0000-0000-0000-000000000001") bits = bits | 4;
				if (<0.0, 0.0, 0.0, 0.0>) bits = bits | 8;
				if (0.5) bits = bits | 16;
			} }
		`);
		world.start(); world.runUntilIdle();
		expect(script.getGlobal('bits')).toMatchObject({ value: 28 });
	});

	it('initializes key variables to an empty string rather than the textual NULL_KEY UUID', () => {
		const { world, script } = scriptWorld('key empty; string text; default { state_entry() { text = (string)empty; } }');
		world.start(); world.runUntilIdle();
		expect(script.getGlobal('empty')).toMatchObject({ type: 'key', value: '' });
		expect(script.getGlobal('text')).toMatchObject({ value: '' });
	});

	it('reads compound assignment targets after the right-hand expression', () => {
		const { world, script } = scriptWorld(`
			integer counter = 1;
			default { state_entry() { counter += (counter = 3); } }
		`);
		world.start(); world.runUntilIdle();
		expect(script.getGlobal('counter')).toMatchObject({ value: 6 });
	});

	it('wraps 32-bit integer multiplication without prematurely rounding floating intermediates', () => {
		const { world, script } = scriptWorld(`
			integer product; float precise;
			default { state_entry() {
				product = 2147483647 * 2147483647;
				precise = (16777216.0 + 1.0) - 16777216.0;
			} }
		`);
		world.start(); world.runUntilIdle();
		expect(script.getGlobal('product')).toMatchObject({ value: 1 });
		expect(script.getGlobal('precise')).toMatchObject({ value: 1 });
	});

	it('stops and identifies a script on unsupported builtins or arithmetic errors', () => {
		const { world, script } = scriptWorld('default { state_entry() { llRezObject("missing", ZERO_VECTOR, ZERO_VECTOR, ZERO_ROTATION, 0); } }');
		world.start();
		expect(() => world.runUntilIdle()).toThrow('root/example.lsl: simulator has no implementation for llRezObject');
		expect(script.running).toBe(false);
		expect(world.trace.at(-1)).toMatchObject({ kind: 'runtime-error', script: 'example.lsl' });
		expect(() => world.setScriptRunning(script, true)).toThrow('reset it first');
	});
});
