import { describe, expect, it } from 'vitest';
import path from 'node:path';
import { DiagnosticSeverity } from 'vscode-languageserver/node';
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
		expect(evalSource('integer', '(integer)"0x10 suffix"')).toEqual({ kind: 'value', type: 'integer', value: 16 });
		expect(evalSource('float', '(float)"0x1.8p1"')).toEqual({ kind: 'value', type: 'float', value: 3 });
		expect(evalSource('string', '(string)1 + "a"')).toEqual({ kind: 'value', type: 'string', value: '1a' });
	});

	it('does not fold invalid implicit string-number operations', () => {
		expect(evalSource('string', '"a" + 1').kind).toBe('unknown');
		expect(evalSource('string', '1 + "a"').kind).toBe('unknown');
		expect(evalSource('integer', '"1" == 1').kind).toBe('unknown');
		expect(evalSource('integer', '"1" != 2').kind).toBe('unknown');
	});

	it('keeps valid non-scalar operation result shapes when values are not materialized', () => {
		expect(evalSource('list', '[] + "x"')).toEqual({ kind: 'unknown', type: 'list' });
		expect(evalSource('list', '[1] + ["a", "b"]')).toEqual({ kind: 'unknown', type: 'list' });
		expect(evalSource('vector', '<1,2,3> + <4,5,6>')).toEqual({ kind: 'unknown', type: 'vector' });
		expect(evalSource('rotation', '<0,0,0,1> * <0,0,0,1>')).toEqual({ kind: 'unknown', type: 'rotation' });
		expect(evalSource('vector', '<1,2,3> * <0,0,0,1>')).toEqual({ kind: 'unknown', type: 'vector' });
	});

	it('matches SL list comparison shape for literal list lengths', () => {
		expect(evalSource('integer', '[] == []')).toEqual({ kind: 'value', type: 'integer', value: 1 });
		expect(evalSource('integer', '[1] == ["x"]')).toEqual({ kind: 'value', type: 'integer', value: 1 });
		expect(evalSource('integer', '[1, 2] != ["x"]')).toEqual({ kind: 'value', type: 'integer', value: 1 });
		expect(evalSource('integer', '[1] != ["x", "y", "z"]')).toEqual({ kind: 'value', type: 'integer', value: -2 });
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
});
