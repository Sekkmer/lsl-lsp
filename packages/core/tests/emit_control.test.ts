import { describe, expect, it } from 'vitest';
import { parseScriptFromText } from '../src';
import { emitScript, emitStmt } from '../src/ast/emit';
import type { Expr, Stmt } from '../src/ast/types';

const valueExpr: Expr = { kind: 'Identifier', name: 'value', span: { start: 0, end: 0 } };

function ownerSayStmt(text: string): Stmt {
	return {
		kind: 'ExprStmt',
		span: { start: 0, end: 0 },
		expression: {
			kind: 'Call',
			span: { start: 0, end: 0 },
			callee: { kind: 'Identifier', name: 'llOwnerSay', span: { start: 0, end: 0 } },
			args: [{ kind: 'StringLiteral', value: text, raw: `"${text}"`, span: { start: 0, end: 0 } }],
		},
	};
}

function nestedIfBody(): Stmt {
	return {
		kind: 'IfStmt',
		span: { start: 0, end: 0 },
		condition: valueExpr,
		then: ownerSayStmt('inner'),
	};
}

function outerIfWithThen(then: Stmt): Stmt {
	return {
		kind: 'IfStmt',
		span: { start: 0, end: 0 },
		condition: valueExpr,
		then,
		else: ownerSayStmt('outer'),
	};
}

function parseEmittedStateEntry(stmt: Stmt) {
	return parseScriptFromText(`default{state_entry(){${emitStmt(stmt)}}}`).states.get('default')!.events[0]!.body;
}

describe('control statement emission', () => {
	it('separates do from a non-block statement', () => {
		const source = 'default { state_entry() { do llOwnerSay("once"); while (0); } }';
		const code = emitScript(parseScriptFromText(source));
		expect(code).toContain('do llOwnerSay("once");while(0);');
		expect(parseScriptFromText(code).diagnostics).toEqual([]);
	});

	it('does not merge binary operators with following prefix increments', () => {
		for (const expression of ['a + ++b', 'a - --b', 'a + +b', 'a - -b']) {
			const original = parseScriptFromText(`default { touch_start(integer a) { integer b=a; llOwnerSay((string)(${expression})); } }`);
			const code = emitScript(original);
			const reparsed = parseScriptFromText(code);
			expect(reparsed.diagnostics).toEqual([]);
			expect(emitScript(reparsed)).toEqual(code);
			expect(code).toContain(expression.includes('+') ? 'a+(' : 'a-(');
		}
	});
	it('braces while bodies that could capture an outer else', () => {
		const emitted = emitStmt(outerIfWithThen({
			kind: 'WhileStmt',
			span: { start: 0, end: 0 },
			condition: valueExpr,
			body: nestedIfBody(),
		}));

		expect(emitted).toBe('if(value){while(value)if(value)llOwnerSay("inner");}else llOwnerSay("outer");');
		expect(parseEmittedStateEntry(outerIfWithThen({
			kind: 'WhileStmt',
			span: { start: 0, end: 0 },
			condition: valueExpr,
			body: nestedIfBody(),
		}))).toMatchObject({
			kind: 'BlockStmt',
			statements: [{ kind: 'IfStmt', else: { kind: 'ExprStmt' } }],
		});
	});

	it('braces for bodies that could capture an outer else', () => {
		const emitted = emitStmt(outerIfWithThen({
			kind: 'ForStmt',
			span: { start: 0, end: 0 },
			body: nestedIfBody(),
		}));

		expect(emitted).toBe('if(value){for(;;)if(value)llOwnerSay("inner");}else llOwnerSay("outer");');
	});
});
