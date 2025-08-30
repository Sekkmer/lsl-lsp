import type { TextDocument } from 'vscode-languageserver-textdocument';
import type { Range } from 'vscode-languageserver/node';

export type Span = { start: number; end: number };

export const TYPES = ['key', 'list', 'integer', 'float', 'rotation', 'string', 'vector'] as const;
export type Type = typeof TYPES[number];
const TYPE_SET = new Set(TYPES) as ReadonlySet<Type>;

export function isType(t: string): t is Type {
	return TYPE_SET.has(t as Type);
}

// LSL operator types
export type UnOp = '!' | '~' | '++' | '--' | '+' | '-';
export type BinOp =
	// assignment
	| '=' | '+=' | '-=' | '*=' | '/=' | '%='
	// logical
	| '&&' | '||'
	// bitwise
	| '&' | '|' | '^' | '<<' | '>>'
	// equality and relational
	| '==' | '!=' | '<' | '<=' | '>' | '>='
	// arithmetic
	| '+' | '-' | '*' | '/' | '%';

export type Expr =
	| { span: Span; kind: 'StringLiteral'; value: string; }
	| { span: Span; kind: 'NumberLiteral'; raw: string; }
	| { span: Span; kind: 'Identifier'; name: string; }
	| { span: Span; kind: 'Call'; callee: Expr; args: Expr[]; }
	| { span: Span; kind: 'Member'; object: Expr; property: string; }
	| { span: Span; kind: 'Unary'; op: UnOp; argument: Expr; }
	| { span: Span; kind: 'Binary'; op: BinOp; left: Expr; right: Expr; }
	| { span: Span; kind: 'Cast'; type: Type; argument: Expr; }
	| { span: Span; kind: 'Paren'; expression: Expr; }
	| { span: Span; kind: 'ListLiteral'; elements: Expr[]; }
	| { span: Span; kind: 'VectorLiteral'; elements: [Expr, Expr, Expr] | [Expr, Expr, Expr, Expr]; }
	| { span: Span; kind: 'ErrorExpr' };

export type Stmt =
	| { span: Span; kind: 'EmptyStmt' }
	| { span: Span; kind: 'ExprStmt'; expression: Expr; }
	| { span: Span; kind: 'VarDecl'; varType: Type; name: string; initializer?: Expr; comment?: string; }
	| { span: Span; kind: 'ReturnStmt'; expression?: Expr; }
	| { span: Span; kind: 'IfStmt'; condition: Expr; then: Stmt; else?: Stmt; }
	| { span: Span; kind: 'WhileStmt'; condition: Expr; body: Stmt; }
	| { span: Span; kind: 'DoWhileStmt'; body: Stmt; condition: Expr; }
	| { span: Span; kind: 'ForStmt'; init: Expr; condition: Expr; update: Expr; body: Stmt; }
	| { span: Span; kind: 'BlockStmt'; statements: Stmt[]; }
	| { span: Span; kind: 'JumpStmt'; target: Expr; }
	| { span: Span; kind: 'LabelStmt'; name: string; }
	| { span: Span; kind: 'StateChangeStmt'; state: string; }
	| { span: Span; kind: 'ErrorStmt' };

export type Event = { span: Span; kind: 'Event'; name: string; parameters: Map<string, Type>; body: Stmt; }
export type State = { span: Span; kind: 'State'; name: string; events: Event[]; }
// returnType is either one of LSL types or implicit 'void' when not specified in source
export type Function = { span: Span; kind: 'Function'; name: string; parameters: Map<string, Type>; body: Stmt; comment?: string; returnType?: Type | 'void' }
export type GlobalVar = { span: Span; kind: 'GlobalVar'; varType: Type; name: string; initializer?: Expr; comment?: string; }
export type Diagnostic = { span: Span; message: string; severity?: 'error' | 'warning' | 'info'; code?: string };
export type Script = { span: Span; kind: 'Script'; functions: Map<string, Function>; states: Map<string, State>; globals: Map<string, GlobalVar>; diagnostics?: Diagnostic[] }

export function spanFrom(start: number, end: number): Span {
	return { start, end };
}

export function spanToRange(doc: TextDocument, span: Span): Range {
	return { start: doc.positionAt(span.start), end: doc.positionAt(span.end) };
}

export function rangeToSpan(doc: TextDocument, range: Range): Span {
	return { start: doc.offsetAt(range.start), end: doc.offsetAt(range.end) };
}
