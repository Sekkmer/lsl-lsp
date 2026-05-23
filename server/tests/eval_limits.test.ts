import { describe, expect, it } from 'vitest';
import { Env, evalExpr, evalStmt } from '../src/ast/eval';
import type { Expr, Stmt } from '../src/ast/types';

const span = { start: 0, end: 0 };

function intLit(raw: string): Expr {
	return { kind: 'NumberLiteral', raw, span };
}

function deepParen(depth: number): Expr {
	let expr = intLit('1');
	for (let i = 0; i < depth; i++) {
		expr = { kind: 'Paren', expression: expr, span };
	}
	return expr;
}

describe('AST evaluator safety limits', () => {
	it('returns unknown when expression depth exceeds the configured limit', () => {
		const value = evalExpr(deepParen(10), new Env(), { maxDepth: 4 });
		expect(value).toEqual({ kind: 'unknown', type: 'integer' });
	});

	it('returns unknown when expression node budget is exhausted', () => {
		const expr: Expr = {
			kind: 'Binary',
			op: '+',
			left: { kind: 'Binary', op: '+', left: intLit('1'), right: intLit('2'), span },
			right: intLit('3'),
			span,
		};
		const value = evalExpr(expr, new Env(), { maxNodes: 2 });
		expect(value).toEqual({ kind: 'unknown', type: 'integer' });
	});

	it('does not evaluate runtime function calls unless explicitly enabled', () => {
		const expr: Expr = {
			kind: 'Call',
			callee: { kind: 'Identifier', name: 'llStringLength', span },
			args: [{ kind: 'StringLiteral', value: 'abc', span }],
			span,
		};
		const env = new Env(new Map(), new Map([['llStringLength', 'integer']]));
		expect(evalExpr(expr, env)).toEqual({ kind: 'unknown', type: 'integer' });
		expect(evalExpr(expr, env, { allowRuntimeCalls: true })).toEqual({ kind: 'value', type: 'integer', value: 3 });
	});

	it('uses a configurable loop budget for statement evaluation', () => {
		const stmt: Stmt = {
			kind: 'WhileStmt',
			condition: intLit('1'),
			body: { kind: 'EmptyStmt', span },
			span,
		};
		expect(evalStmt(stmt, new Env(), { maxLoopIters: 2 })).toBeNull();
	});
});
