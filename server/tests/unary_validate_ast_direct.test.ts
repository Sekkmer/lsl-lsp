import { describe, it, expect } from 'vitest';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { validateOperatorsFromAst } from '../src/op_validate_ast';
import { Expr, spanFrom, type UnOp } from '../src/ast';
import { LSL_DIAGCODES, type Diag } from '../src/parser';
import { SimpleType } from '../src/ast/infer';

describe('validateOperatorsFromAst (direct AST) - unary operators', () => {
	function mkDoc(text = '') {
		return TextDocument.create('file:///unary_direct.lsl', 'lsl', 1, text);
	}
	function id(name: string, s = 0, e = 1): Expr { return { kind: 'Identifier', name, span: spanFrom(s, e) }; }
	function paren(expr: Expr, s = 0, e = 1): Expr { return { kind: 'Paren', expression: expr, span: spanFrom(s, e) }; }
	function unary(op: UnOp, arg: Expr, s = 0, e = 1): Expr { return { kind: 'Unary', op, argument: arg, span: spanFrom(s, e) } as Expr; }

	it('type-checks unary operators when types are known', () => {
		const doc = mkDoc('');
		const diagnostics: Diag[] = [];
		const exprs: Expr[] = [
			unary('+', id('s')), // +string -> not numeric
			unary('-', id('s')), // -string -> not numeric
			unary('!', id('f')), // !float -> not integer
			unary('~', id('f')), // ~float -> not integer
		];
		const symbolTypes = new Map<string, SimpleType>();
		symbolTypes.set('s', 'string');
		symbolTypes.set('f', 'float');
		validateOperatorsFromAst(doc, exprs, diagnostics, symbolTypes);
		const msgs = diagnostics.map(d => d.message);
		expect(msgs.some(m => m.includes('Unary operator + expects a numeric value'))).toBe(true);
		expect(msgs.some(m => m.includes('Unary operator - expects a numeric value'))).toBe(true);
		expect(msgs.some(m => m.includes('Unary operator ! expects an integer value'))).toBe(true);
		expect(msgs.some(m => m.includes('Unary operator ~ expects an integer value'))).toBe(true);
	});

	it('enforces ++ assignability and integer type', () => {
		const doc = mkDoc('');
		const diagnostics: Diag[] = [];
		const i = id('i');
		const L = id('L');
		const exprs: Expr[] = [
			unary('++', paren(i)),	// ++(i) -> not assignable
			unary('++', L),		 // ++L with L:list -> wrong type
		];
		const symbolTypes = new Map<string, SimpleType>();
		symbolTypes.set('L', 'list');
		symbolTypes.set('i', 'integer');
		validateOperatorsFromAst(doc, exprs, diagnostics, symbolTypes);
		const msgs = diagnostics.map(d => `${d.message} @${d.code}`);
		expect(msgs.some(m => m.includes('Operand of ++ must be a variable') && m.includes(LSL_DIAGCODES.INVALID_ASSIGN_LHS))).toBe(true);
		expect(msgs.some(m => m.includes('Operator ++ expects an integer variable') && m.includes(LSL_DIAGCODES.WRONG_TYPE))).toBe(true);
	});
});
