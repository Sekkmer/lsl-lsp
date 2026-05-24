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

	it('keeps valid non-scalar operation result shapes when values are not materialized', () => {
		expect(evalSource('list', '[] + "x"')).toEqual({ kind: 'unknown', type: 'list' });
		expect(evalSource('list', '[1] + ["a", "b"]')).toEqual({ kind: 'unknown', type: 'list' });
		expect(evalSource('vector', '<1,2,3> + <4,5,6>')).toEqual({ kind: 'unknown', type: 'vector' });
		expect(evalSource('rotation', '<0,0,0,1> * <0,0,0,1>')).toEqual({ kind: 'unknown', type: 'rotation' });
		expect(evalSource('vector', '<1,2,3> * <0,0,0,1>')).toEqual({ kind: 'unknown', type: 'vector' });
	});

	it('materializes literal list and vector values for condition folding', () => {
		expect(evalSource('list', '[1]')).toEqual({
			kind: 'value',
			type: 'list',
			value: [{ kind: 'value', type: 'integer', value: 1 }],
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
