import { describe, expect, it } from 'vitest';
import { Env, evalExpr, evalStmt } from '../src/ast/eval';
import { parseScriptFromText } from '../src/ast/parser';
import type { Type } from '../src/ast/types';
import type { Value } from '../src/ast/runtime';

// Values captured from Second Life Mono by the ignored local IPC probe on
// 2026-10-14; .local/review-2026-10/runtime-results.json retains the raw output.
function evaluate(type: Type, source: string): Value {
	const ast = parseScriptFromText(`${type} x = ${source};`, 'file:///sl-oracle.lsl');
	return evalExpr(ast.globals.get('x')!.initializer!, new Env(), { allowRuntimeCalls: true });
}

describe('Second Life runtime oracle regressions', () => {
	it('implements reversed and out-of-range string and list intervals', () => {
		const cases = [
			['llGetSubString("abcde",3,1)', 'abde'],
			['llGetSubString("abcde",9,10)', ''],
			['llGetSubString("abcde",-10,-9)', ''],
			['llDeleteSubString("abcde",3,1)', 'c'],
			['llDeleteSubString("abcde",9,10)', 'abcde'],
			['llDeleteSubString("abcde",-10,-9)', 'abcde'],
			['llList2CSV(llList2List([0,1,2,3,4],3,1))', '0, 1, 3, 4'],
			['llList2CSV(llList2List([0,1,2,3,4],9,10))', ''],
			['llList2CSV(llList2List([0,1,2,3,4],-10,-9))', ''],
			['llList2CSV(llDeleteSubList([0,1,2,3,4],3,1))', '2'],
			['llList2CSV(llDeleteSubList([0,1,2,3,4],9,10))', '0, 1, 2, 3, 4'],
			['llList2CSV(llDeleteSubList([0,1,2,3,4],-10,-9))', '0, 1, 2, 3, 4'],
			['llList2CSV(llListReplaceList([0,1,2,3,4],[9],3,1))', '2, 9'],
			['llList2CSV(llListReplaceList([0,1,2,3,4],[9],9,10))', '0, 1, 2, 3, 4, 9'],
			['llList2CSV(llListReplaceList([0,1,2,3,4],[9],-10,-9))', '0, 1, 2, 3, 4'],
		];
		for (const [source, value] of cases) expect(evaluate('string', source!)).toEqual({ kind: 'value', type: 'string', value });
	});

	it('indexes Unicode code points rather than JavaScript UTF-16 units', () => {
		expect(evaluate('integer', 'llStringLength("a😀b")')).toEqual({ kind: 'value', type: 'integer', value: 3 });
		expect(evaluate('integer', 'llSubStringIndex("a😀b","b")')).toEqual({ kind: 'value', type: 'integer', value: 2 });
		expect(evaluate('string', 'llGetSubString("a😀b",1,1)')).toEqual({ kind: 'value', type: 'string', value: '😀' });
	});

	it('matches list element conversions', () => {
		expect(evaluate('float', 'llList2Float(["1.25suffix"],0)')).toEqual({ kind: 'value', type: 'float', value: 1.25 });
		expect(evaluate('vector', 'llList2Vector(["<1,2,3>"],0)')).toEqual({ kind: 'value', type: 'vector', value: [0, 0, 0] });
		expect(evaluate('rotation', 'llList2Rot(["<1,2,3,4>"],0)')).toEqual({ kind: 'value', type: 'rotation', value: [0, 0, 0, 1] });
	});

	it('wraps integer arithmetic and retains Mono intermediate float precision', () => {
		expect(evaluate('integer', '2147483647+1')).toEqual({ kind: 'value', type: 'integer', value: -2147483648 });
		expect(evaluate('integer', '2147483647*2147483647')).toEqual({ kind: 'value', type: 'integer', value: 1 });
		expect(evaluate('float', '16777216.0+1.0-16777216.0')).toEqual({ kind: 'value', type: 'float', value: 1 });
		expect(evaluate('integer', '0xffffffff')).toEqual({ kind: 'value', type: 'integer', value: -1 });
		expect(evaluate('integer', '-0x80000000')).toEqual({ kind: 'value', type: 'integer', value: -2147483648 });
		expect(evaluate('integer', '(integer)"4294967295"')).toEqual({ kind: 'value', type: 'integer', value: -1 });
		expect(evaluate('integer', '-(-2147483647-1)')).toEqual({ kind: 'value', type: 'integer', value: -2147483648 });
	});

	it('sorts homogeneous keys within their original type slots and retains stride payloads', () => {
		for (const [source, value] of [
			['llList2CSV(llListSort(["b","a","c"],1,1))', 'a, b, c'],
			['llList2CSV(llListSort(["b","a","c"],1,0))', 'c, b, a'],
			['llList2CSV(llListSort(["b",3,"a",1,2.5,1.5],1,1))', 'a, 1, b, 3, 1.500000, 2.500000'],
			['llList2CSV(llListSort([3,"c",1,"a",2],2,1))', '3, c, 1, a, 2'],
			['llList2CSV(llListSort([3,1,2],0,1))', '1, 2, 3'],
			['llList2CSV(llListSort([<2,0,0>,<1,0,0>,<0,0,1>],1,1))', '<1.000000, 0.000000, 0.000000>, <0.000000, 0.000000, 1.000000>, <2.000000, 0.000000, 0.000000>'],
		]) expect(evaluate('string', source!)).toEqual({ kind: 'value', type: 'string', value });
	});

	it('matches strided range anchoring and list slices', () => {
		for (const [source, value] of [
			['llList2CSV(llList2ListStrided([0,1,2,3,4,5],1,4,2))', '2, 4'],
			['llList2CSV(llList2ListStrided([0,1,2,3,4,5],4,1,2))', '0, 2, 4'],
			['llList2CSV(llList2ListStrided([0,1,2,3,4,5],9,10,2))', ''],
			['llList2CSV(llList2ListStrided([0,1,2,3,4,5],0,-1,0))', '0, 1, 2, 3, 4, 5'],
			['llList2CSV(llList2ListStrided([0,1,2,3,4,5],0,-1,-2))', '0, 2, 4'],
			['llList2CSV(llList2ListSlice([0,1,2,3,4,5],1,4,2,0))', '1, 3'],
			['llList2CSV(llList2ListSlice([0,1,2,3,4,5],4,1,2,1))', '1, 5'],
			['llList2CSV(llList2ListSlice([0,1,2,3,4,5],9,10,2,0))', ''],
			['llList2CSV(llList2ListSlice([0,1,2,3,4,5],0,-1,2,3))', ''],
		]) expect(evaluate('string', source!)).toEqual({ kind: 'value', type: 'string', value });
	});

	it('zero-pads short base64 integer inputs in the low bytes', () => {
		for (const [source, value] of [['AQ==', 16777216], ['AQI=', 16908288], ['AQIDBA==', 16909060]] as const) {
			expect(evaluate('integer', `llBase64ToInteger("${source}")`)).toEqual({ kind: 'value', type: 'integer', value });
		}
	});

	it('does not rescan inserted substring replacements', () => {
		expect(evaluate('string', 'llReplaceSubString("aba","a","aa",2)')).toEqual({ kind: 'value', type: 'string', value: 'aabaa' });
		expect(evaluate('string', 'llReplaceSubString("aaaa","aa","a",2)')).toEqual({ kind: 'value', type: 'string', value: 'aa' });
	});

	it('keeps unverified Unicode casing and source-sensitive JSON operations unfolded', () => {
		for (const source of ['llToUpper("straße ﬃ ı")', 'llToLower("İ Σẞ")', 'llJsonGetValue("[1.250,1e3]",[0])', 'llJsonSetValue("{}",["a","b"],"3")']) {
			expect(evaluate('string', source)).toEqual({ kind: 'unknown', type: 'string' });
		}
		expect(evaluate('string', 'llJsonValueType("null",[])')).toEqual({ kind: 'value', type: 'string', value: '\uFDD5' });
		expect(evaluate('string', 'llJsonGetValue("null",[])')).toEqual({ kind: 'value', type: 'string', value: '\uFDD5' });
		expect(evaluate('string', 'llJsonGetValue("{}",["toString"])')).toEqual({ kind: 'value', type: 'string', value: '\uFDD0' });
	});
});

describe('user-function evaluator safety', () => {
	function call(source: string, name: string, expression = `${name}()`): Value {
		const ast = parseScriptFromText(source + `\nstring probe = ${expression};`, 'file:///eval-function.lsl');
		const env = new Env(new Map([['globalValue', { kind: 'value', type: 'integer', value: 1 }]]), new Map(), ast.functions, new Set(ast.functions.keys()));
		return evalExpr(ast.globals.get('probe')!.initializer!, env, { allowRuntimeCalls: true });
	}

	it('coerces parameter, local declaration and return values to declared types', () => {
		expect(call('string f(float x) { return (string)x; }', 'f', 'f(2)')).toEqual({ kind: 'value', type: 'string', value: '2.000000' });
		expect(call('string f() { float x = 2; return (string)x; }', 'f')).toEqual({ kind: 'value', type: 'string', value: '2.000000' });
		expect(call('float f() { return 2; }', 'f')).toEqual({ kind: 'value', type: 'float', value: 2 });
		expect(call('integer f() { integer x; return x; }', 'f')).toEqual({ kind: 'value', type: 'integer', value: 0 });
	});

	it('does not resolve a callee global through caller locals', () => {
		expect(call('integer readGlobal() { return globalValue; } integer f() { integer globalValue = 2; return readGlobal(); }', 'f')).toEqual({ kind: 'value', type: 'integer', value: 1 });
	});

	it('does not fold a return reached only after an evaluation limit', () => {
		for (const loop of ['while(1){}', 'for(;;){}', 'do{}while(1);']) {
			expect(call(`integer f() { ${loop} return 7; }`, 'f')).toEqual({ kind: 'unknown', type: 'integer' });
		}
		expect(call('integer spin() { while (1) {} return 7; } integer f() { spin(); return 2; }', 'f')).toEqual({ kind: 'unknown', type: 'integer' });
		expect(call('integer f() { f(); return 2; }', 'f')).toEqual({ kind: 'unknown', type: 'integer' });
	});

	it('treats fractional float conditions as true', () => {
		expect(call('integer f() { if (0.5) return 1; return 0; }', 'f')).toEqual({ kind: 'value', type: 'integer', value: 1 });
	});

	it('evaluates binary operands right-to-left and vector operands exactly once', () => {
		expect(call('integer f() { integer x = 0; return x + (x = 2); }', 'f')).toEqual({ kind: 'value', type: 'integer', value: 4 });
		expect(call('integer f() { integer x = 0; return (x = 1) + (x = 2) + x; }', 'f')).toEqual({ kind: 'value', type: 'integer', value: 3 });
		expect(call('float f() { integer x = 0; return <x,0,0> * <(x=2),0,0>; }', 'f')).toEqual({ kind: 'value', type: 'float', value: 4 });
	});

	it('treats an invalid key as false', () => {
		const ast = parseScriptFromText('integer f(key probe) { if (probe) return 1; return 0; }', 'file:///key-truth.lsl');
		const env = new Env(new Map([['probe', { kind: 'value', type: 'key', value: 'not-a-uuid' }]]));
		expect(evalStmt(ast.functions.get('f')!.body, env)).toEqual({ kind: 'value', type: 'integer', value: 0 });
	});
});
