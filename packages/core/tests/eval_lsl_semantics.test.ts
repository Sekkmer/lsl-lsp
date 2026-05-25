import { describe, expect, it } from 'vitest';
import path from 'node:path';
import { DiagnosticSeverity } from '../src/protocol';
import { parseScriptFromText } from '../src/ast/parser';
import { Env, evalExpr } from '../src/ast/eval';
import type { Expr, Type } from '../src/ast/types';
import type { Value } from '../src/ast/eval';
import { loadDefs } from '../src/defs';
import { docFrom, runPipeline } from './testUtils';
import { LSL_DIAGCODES } from '../src/analysisTypes';

const defsPath = path.join(__dirname, '..', '..', '..', 'third_party', 'lsl-definitions', 'lsl_definitions.yaml');

function parseInitializer(type: Type, source: string): Expr {
	const script = parseScriptFromText(`${type} probe = ${source};`, 'file:///eval-probe.lsl');
	const initializer = script.globals.get('probe')?.initializer;
	if (!initializer) throw new Error(`failed to parse evaluator fixture: ${source}`);
	return initializer;
}

function evalSource(type: Type, source: string, env?: Env): Value {
	return evalExpr(parseInitializer(type, source), env);
}

function evalSourceWithRuntime(type: Type, source: string, env?: Env): Value {
	return evalExpr(parseInitializer(type, source), env, { allowRuntimeCalls: true });
}

describe('evaluator LSL semantic fixtures', () => {
	it('folds scalar expressions that are valid LSL constants', () => {
		expect(evalSource('integer', '1 + 2 * 3')).toEqual({ kind: 'value', type: 'integer', value: 7 });
		expect(evalSource('integer', '7 / 2')).toEqual({ kind: 'value', type: 'integer', value: 3 });
		expect(evalSource('float', '7.0 / 2')).toEqual({ kind: 'value', type: 'float', value: 3.5 });
		expect(evalSource('integer', '0x10')).toEqual({ kind: 'value', type: 'integer', value: 16 });
		expect(evalSource('integer', '(integer)"0x10 suffix"')).toEqual({ kind: 'value', type: 'integer', value: 16 });
		expect(evalSource('float', '(float)"0x1.8p1"')).toEqual({ kind: 'value', type: 'float', value: 3 });
		expect(evalSource('string', '(string)0x10')).toEqual({ kind: 'value', type: 'string', value: '16' });
		expect(evalSource('string', '(string)1 + "a"')).toEqual({ kind: 'value', type: 'string', value: '1a' });
		expect(evalSource('string', '(string)<1,2,3>')).toEqual({ kind: 'value', type: 'string', value: '<1.00000, 2.00000, 3.00000>' });
		expect(evalSource('string', '(string)<1,2,3,4>')).toEqual({ kind: 'value', type: 'string', value: '<1.00000, 2.00000, 3.00000, 4.00000>' });
	});

	it('does not fold invalid implicit string-number operations', () => {
		expect(evalSource('string', '"a" + 1').kind).toBe('unknown');
		expect(evalSource('string', '1 + "a"').kind).toBe('unknown');
		expect(evalSource('integer', '"1" == 1').kind).toBe('unknown');
		expect(evalSource('integer', '"1" != 2').kind).toBe('unknown');
		expect(evalSource('integer', '!0.0')).toEqual({ kind: 'unknown', type: 'integer' });
		expect(evalSource('integer', '1.0 && 0.0')).toEqual({ kind: 'unknown', type: 'integer' });
		expect(evalSource('integer', '1.0 | 0')).toEqual({ kind: 'unknown', type: 'integer' });
	});

	it('folds valid vector and rotation arithmetic when operands are known', () => {
		expect(evalSource('list', '[] + "x"')).toEqual({ kind: 'unknown', type: 'list' });
		expect(evalSource('list', '[1] + ["a", "b"]')).toEqual({ kind: 'unknown', type: 'list' });
		expect(evalSource('vector', '<1,2,3> + <4,5,6>')).toEqual({ kind: 'value', type: 'vector', value: [5, 7, 9] });
		expect(evalSource('vector', '<4,5,6> - <1,2,3>')).toEqual({ kind: 'value', type: 'vector', value: [3, 3, 3] });
		expect(evalSource('float', '<1,2,3> * <4,5,6>')).toEqual({ kind: 'value', type: 'float', value: 32 });
		expect(evalSource('vector', '<1,0,0> % <0,1,0>')).toEqual({ kind: 'value', type: 'vector', value: [0, 0, 1] });
		expect(evalSource('vector', '<1,2,3> * 2')).toEqual({ kind: 'value', type: 'vector', value: [2, 4, 6] });
		expect(evalSource('vector', '2 * <1,2,3>')).toEqual({ kind: 'value', type: 'vector', value: [2, 4, 6] });
		expect(evalSource('vector', '<2,4,6> / 2')).toEqual({ kind: 'value', type: 'vector', value: [1, 2, 3] });
		expect(evalSource('rotation', '<1,2,3,4> + <4,3,2,1>')).toEqual({ kind: 'value', type: 'rotation', value: [5, 5, 5, 5] });
		expect(evalSource('rotation', '<4,3,2,1> - <1,2,3,4>')).toEqual({ kind: 'value', type: 'rotation', value: [3, 1, -1, -3] });
		expect(evalSource('rotation', '<0,0,0,1> * <0,0,0,1>')).toEqual({ kind: 'value', type: 'rotation', value: [0, 0, 0, 1] });
		expect(evalSource('rotation', '<0,0,0,1> / <0,0,0,1>')).toEqual({ kind: 'value', type: 'rotation', value: [0, 0, 0, 1] });
		expect(evalSource('vector', '<1,2,3> * <0,0,0,1>')).toEqual({ kind: 'value', type: 'vector', value: [1, 2, 3] });
		expect(evalSource('vector', '<1,2,3> / <0,0,0,1>')).toEqual({ kind: 'value', type: 'vector', value: [1, 2, 3] });
	});

	it('materializes literal list and vector values for condition folding', () => {
		expect(evalSource('list', '[1]')).toEqual({
			kind: 'value',
			type: 'list',
			value: [{ kind: 'value', type: 'integer', value: 1 }],
		});
		expect(evalSource('list', '(list)"x"')).toEqual({
			kind: 'value',
			type: 'list',
			value: [{ kind: 'value', type: 'string', value: 'x' }],
		});
		expect(evalSource('list', '[1, []]')).toEqual({ kind: 'unknown', type: 'list' });
		expect(evalSource('vector', '<1,2,3>')).toEqual({ kind: 'value', type: 'vector', value: [1, 2, 3] });
		expect(evalSource('rotation', '<0,0,0,1>')).toEqual({ kind: 'value', type: 'rotation', value: [0, 0, 0, 1] });
	});

	it('matches SL list comparison shape for literal list lengths', () => {
		expect(evalSource('integer', '[] == []')).toEqual({ kind: 'value', type: 'integer', value: 1 });
		expect(evalSource('integer', '[1] == ["x"]')).toEqual({ kind: 'value', type: 'integer', value: 1 });
		expect(evalSource('integer', '[1, 2] != ["x"]')).toEqual({ kind: 'value', type: 'integer', value: 1 });
		expect(evalSource('integer', '[1] != ["x", "y", "z"]')).toEqual({ kind: 'value', type: 'integer', value: -2 });
		expect(evalSource('integer', '[1, []] == [1]')).toEqual({ kind: 'unknown', type: 'integer' });
	});

	it('does not fold runtime calls with unknown-bearing arguments', () => {
		const env = new Env(new Map([
			['runtimeString', { kind: 'unknown', type: 'string' }],
			['runtimeList', { kind: 'unknown', type: 'list' }],
		]));
		expect(evalSourceWithRuntime('integer', 'llListFindList(["a", "b"], ["b"])')).toEqual({ kind: 'value', type: 'integer', value: 1 });
		expect(evalSourceWithRuntime('integer', 'llListFindList(["a", "b"], [runtimeString])', env)).toEqual({ kind: 'unknown', type: 'integer' });
		expect(evalSourceWithRuntime('integer', 'llListFindList([runtimeString], ["a"])', env)).toEqual({ kind: 'unknown', type: 'integer' });
		expect(evalSourceWithRuntime('integer', 'llListFindList([], [runtimeString])', env)).toEqual({ kind: 'value', type: 'integer', value: -1 });
		expect(evalSourceWithRuntime('integer', 'llListFindList([runtimeString], [])', env)).toEqual({ kind: 'value', type: 'integer', value: 0 });
		expect(evalSourceWithRuntime('integer', 'llListFindList(runtimeList, ["a"])', env)).toEqual({ kind: 'unknown', type: 'integer' });
	});

	it('folds known llList2 extraction values and preserves unknown elements', () => {
		const env = new Env(new Map([
			['runtimeString', { kind: 'unknown', type: 'string' }],
			['runtimeList', { kind: 'unknown', type: 'list' }],
		]));

		expect(evalSourceWithRuntime('integer', 'llList2Integer([1.9, "0x10", "nope"], 1)')).toEqual({ kind: 'value', type: 'integer', value: 16 });
		expect(evalSourceWithRuntime('float', 'llList2Float([1, 2.5, "3.25"], -1)')).toEqual({ kind: 'value', type: 'float', value: 3.25 });
		expect(evalSourceWithRuntime('string', 'llList2String([1, 2.5, <1,2,3>], 2)')).toEqual({ kind: 'value', type: 'string', value: '<1.000000, 2.000000, 3.000000>' });
		expect(evalSourceWithRuntime('key', 'llList2Key([(key)"00000000-0000-0000-0000-000000000001"], 0)')).toEqual({ kind: 'value', type: 'key', value: '00000000-0000-0000-0000-000000000001' });
		expect(evalSourceWithRuntime('vector', 'llList2Vector([<1,2,3>], 0)')).toEqual({ kind: 'value', type: 'vector', value: [1, 2, 3] });
		expect(evalSourceWithRuntime('rotation', 'llList2Rot([<1,2,3,4>], 0)')).toEqual({ kind: 'value', type: 'rotation', value: [1, 2, 3, 4] });

		expect(evalSourceWithRuntime('integer', 'llList2Integer([1], 9)')).toEqual({ kind: 'value', type: 'integer', value: 0 });
		expect(evalSourceWithRuntime('float', 'llList2Float([1], 9)')).toEqual({ kind: 'value', type: 'float', value: 0 });
		expect(evalSourceWithRuntime('string', 'llList2String([1], 9)')).toEqual({ kind: 'value', type: 'string', value: '' });
		expect(evalSourceWithRuntime('key', 'llList2Key([1], 9)')).toEqual({ kind: 'value', type: 'key', value: '' });
		expect(evalSourceWithRuntime('vector', 'llList2Vector([1], 9)')).toEqual({ kind: 'value', type: 'vector', value: [0, 0, 0] });
		expect(evalSourceWithRuntime('rotation', 'llList2Rot([1], 9)')).toEqual({ kind: 'value', type: 'rotation', value: [0, 0, 0, 1] });

		expect(evalSourceWithRuntime('string', 'llList2String([runtimeString], 0)', env)).toEqual({ kind: 'unknown', type: 'string' });
		expect(evalSourceWithRuntime('integer', 'llList2Integer([runtimeString], 0)', env)).toEqual({ kind: 'unknown', type: 'integer' });
		expect(evalSourceWithRuntime('string', 'llList2String(runtimeList, 0)', env)).toEqual({ kind: 'unknown', type: 'string' });
	});

	it('folds pure list, parse, hash, and JSON runtime helpers', () => {
		const jsonEnv = new Env(new Map<string, Value>([
			['JSON_ARRAY', { kind: 'value', type: 'string', value: '\uFDD2' }],
			['JSON_OBJECT', { kind: 'value', type: 'string', value: '\uFDD1' }],
			['JSON_NULL', { kind: 'value', type: 'string', value: '\uFDD5' }],
			['JSON_TRUE', { kind: 'value', type: 'string', value: '\uFDD6' }],
			['JSON_FALSE', { kind: 'value', type: 'string', value: '\uFDD7' }],
		]));

		expect(evalSourceWithRuntime('string', 'llSHA256String("abc")')).toEqual({ kind: 'value', type: 'string', value: 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad' });
		expect(evalSourceWithRuntime('string', 'llList2CSV(["a", "b,c", <1,2,3>, <0,0,0,1>, 7, 1.5])')).toEqual({ kind: 'value', type: 'string', value: 'a, b,c, <1.000000, 2.000000, 3.000000>, <0.000000, 0.000000, 0.000000, 1.000000>, 7, 1.500000' });
		expect(evalSourceWithRuntime('string', 'llDumpList2String(llParseString2List("a,,b;c", [","], [";"]), "|")')).toEqual({ kind: 'value', type: 'string', value: 'a|b|;|c' });
		expect(evalSourceWithRuntime('string', 'llDumpList2String(llParseStringKeepNulls("a,,b;c", [","], [";"]), "|")')).toEqual({ kind: 'value', type: 'string', value: 'a||b|;|c' });
		expect(evalSourceWithRuntime('string', 'llList2Json(JSON_ARRAY, [1, 1.5, "two", JSON_TRUE, JSON_FALSE, JSON_NULL])', jsonEnv)).toEqual({ kind: 'value', type: 'string', value: '[1,1.500000,"two",true,false,null]' });
		expect(evalSourceWithRuntime('string', 'llDumpList2String(llJson2List("[1,1.5,\\"two\\",true,false,null]"), "|")', jsonEnv)).toEqual({ kind: 'value', type: 'string', value: '1|1.500000|two|\uFDD6|\uFDD7|\uFDD5' });
		expect(evalSourceWithRuntime('string', 'llJsonGetValue("[1,\\"two\\",true,null]", [2])', jsonEnv)).toEqual({ kind: 'value', type: 'string', value: '\uFDD6' });
		expect(evalSourceWithRuntime('string', 'llJsonValueType("[1,\\"two\\",true,null]", [3])', jsonEnv)).toEqual({ kind: 'value', type: 'string', value: '\uFDD5' });
		expect(evalSourceWithRuntime('string', 'llJsonSetValue("{\\"a\\":1,\\"b\\":true}", ["c"], "3")', jsonEnv)).toEqual({ kind: 'value', type: 'string', value: '{"a":1,"b":true,"c":3}' });
	});

	it('folds vector and rotation equality when all components are known', () => {
		const vectorValue: Value = { kind: 'value', type: 'vector', value: [1, 2, 3] };
		const rotationValue: Value = { kind: 'value', type: 'rotation', value: [3, 2, 1, 0] };
		const env = new Env(new Map([
			['v', vectorValue],
			['r', rotationValue],
		]));
		expect(evalSource('integer', 'v == <1,2,3>', env)).toEqual({ kind: 'value', type: 'integer', value: 1 });
		expect(evalSource('integer', 'v != <1,2,3>', env)).toEqual({ kind: 'value', type: 'integer', value: 0 });
		expect(evalSource('integer', 'v == <r.z, r.y, r.x>', env)).toEqual({ kind: 'value', type: 'integer', value: 1 });
		expect(evalSource('integer', 'r == <v.z, v.y, v.x, 0>', env)).toEqual({ kind: 'value', type: 'integer', value: 1 });
	});

	it('does not fold literal member access that SL rejects, but can fold variable member values', () => {
		expect(evalSource('float', '<1,2,3>.x')).toEqual({ kind: 'unknown', type: 'float' });

		const vectorValue: Value = { kind: 'value', type: 'vector', value: [1, 2, 3] };
		const env = new Env(new Map([['pos', vectorValue]]));
		expect(evalSource('float', 'pos.z', env)).toEqual({ kind: 'value', type: 'float', value: 3 });
	});

	it('keeps invalid folded expressions from producing misleading LSP constant-condition warnings', async () => {
		const defs = await loadDefs(defsPath);
		const code = `
default {
	state_entry() {
		if ("1" == 1) {
			llOwnerSay("bad");
		}
		if (1.0 && 0.0) {
			llOwnerSay("bad logic");
		}
	}
}
`;
		const doc = docFrom(code, 'file:///eval-invalid-condition.lsl');
		const { analysis } = runPipeline(doc, defs);
		const codes = analysis.diagnostics.map(d => d.code);
		expect(codes).not.toContain(LSL_DIAGCODES.ALWAYS_TRUE_CONDITION);
		expect(codes).not.toContain(LSL_DIAGCODES.ALWAYS_FALSE_CONDITION);
		expect(analysis.diagnostics.some(d => d.code === LSL_DIAGCODES.WRONG_TYPE && d.severity === DiagnosticSeverity.Error)).toBe(true);
	});

	it('folds SL truthiness for non-numeric condition values', async () => {
		const defs = await loadDefs(defsPath);
		const code = `
default {
	state_entry() {
		string nonEmpty = "x";
		string empty = "";
		list populated = [1];
		list blank = [];
		vector nonZero = <1, 0, 0>;
		vector zero = ZERO_VECTOR;
		key nonNull = "00000000-0000-0000-0000-000000000001";
		key nullKey = NULL_KEY;
		if (nonEmpty) { }
		if (empty) { }
		if (populated) { }
		if (blank) { }
		if (nonZero) { }
		if (zero) { }
		if (nonNull) { }
		if (nullKey) { }
	}
}
`;
		const doc = docFrom(code, 'file:///eval-truthiness.lsl');
		const { analysis } = runPipeline(doc, defs);
		const truthy = analysis.diagnostics.filter(d => d.code === LSL_DIAGCODES.ALWAYS_TRUE_CONDITION);
		const falsy = analysis.diagnostics.filter(d => d.code === LSL_DIAGCODES.ALWAYS_FALSE_CONDITION);
		expect(truthy).toHaveLength(4);
		expect(falsy).toHaveLength(4);
	});

	it('uses folded vector and rotation equality for constant-condition diagnostics', async () => {
		const defs = await loadDefs(defsPath);
		const code = `
default {
	state_entry() {
		vector v = <1,2,3>;
		rotation r = <3,2,1,0>;
		if (v == <1,2,3>) { }
		if (v == <r.z, r.y, r.x>) { }
		if (r == <v.z, v.y, v.x, 0>) { }
	}
}
`;
		const doc = docFrom(code, 'file:///eval-vector-rotation-equality.lsl');
		const { analysis } = runPipeline(doc, defs);
		const truthy = analysis.diagnostics.filter(d => d.code === LSL_DIAGCODES.ALWAYS_TRUE_CONDITION);
		expect(truthy).toHaveLength(3);
	});
});
