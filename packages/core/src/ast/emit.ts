import type { BinOp, Event, Expr, Function as FnNode, GlobalVar, Script, State, Stmt, Type } from './types';
import { AssertNever } from '../utils';

export interface EmitOptions {
	compact?: boolean;
}

const DEFAULT_OPTIONS: Required<EmitOptions> = {
	compact: true,
};

export function emitScript(script: Script, options: EmitOptions = {}): string {
	const opts = { ...DEFAULT_OPTIONS, ...options };
	const parts: string[] = [];
	for (const global of script.globals.values()) parts.push(emitGlobal(global));
	for (const fn of script.functions.values()) parts.push(emitFunction(fn));
	for (const state of script.states.values()) parts.push(emitState(state));
	return parts.join(opts.compact ? '' : '\n');
}

export function emitExpr(expr: Expr): string {
	return emitExprPrec(expr, 0);
}

export function emitStmt(stmt: Stmt): string {
	return emitStmtInner(stmt);
}

function emitGlobal(global: GlobalVar): string {
	return `${global.varType} ${global.name}${global.initializer ? `=${emitExpr(global.initializer)}` : ''};`;
}

function emitFunction(fn: FnNode): string {
	const params = emitParams(fn.parameters);
	const head = fn.returnType && fn.returnType !== 'void'
		? `${fn.returnType} ${fn.name}(${params})`
		: `${fn.name}(${params})`;
	return `${head}${emitBlockBody(fn.body)}`;
}

function emitState(state: State): string {
	const head = state.name === 'default' ? 'default' : `state ${state.name}`;
	return `${head}{${state.events.map(emitEvent).join('')}}`;
}

function emitEvent(event: Event): string {
	return `${event.name}(${emitParams(event.parameters)})${emitBlockBody(event.body)}`;
}

function emitParams(params: ReadonlyMap<string, Type>): string {
	return [...params].map(([name, type]) => `${type} ${name}`).join(',');
}

function emitBlockBody(stmt: Stmt): string {
	if (stmt.kind === 'BlockStmt') return `{${stmt.statements.map(emitStmtInner).join('')}}`;
	return `{${emitStmtInner(stmt)}}`;
}

function emitStmtInner(stmt: Stmt): string {
	switch (stmt.kind) {
		case 'EmptyStmt':
			return ';';
		case 'ExprStmt':
			return `${emitExpr(stmt.expression)};`;
		case 'VarDecl':
			return `${stmt.varType} ${stmt.name}${stmt.initializer ? `=${emitExpr(stmt.initializer)}` : ''};`;
		case 'ReturnStmt':
			return stmt.expression ? `return ${emitExpr(stmt.expression)};` : 'return;';
		case 'IfStmt': {
			const elsePart = stmt.else ? `else ${emitControlledStmt(stmt.else)}` : '';
			return `if(${emitExpr(stmt.condition)})${emitControlledStmt(stmt.then)}${elsePart}`;
		}
		case 'WhileStmt':
			return `while(${emitExpr(stmt.condition)})${emitControlledStmt(stmt.body)}`;
		case 'DoWhileStmt':
			return `do${emitControlledStmt(stmt.body)}while(${emitExpr(stmt.condition)});`;
		case 'ForStmt':
			return `for(${stmt.init ? emitExpr(stmt.init) : ''};${stmt.condition ? emitExpr(stmt.condition) : ''};${stmt.update ? emitExpr(stmt.update) : ''})${emitControlledStmt(stmt.body)}`;
		case 'BlockStmt':
			return `{${stmt.statements.map(emitStmtInner).join('')}}`;
		case 'JumpStmt':
			return `jump ${emitExpr(stmt.target)};`;
		case 'LabelStmt':
			return `@${stmt.name};`;
		case 'StateChangeStmt':
			return `state ${stmt.state};`;
		case 'ErrorStmt':
			return ';';
		default:
			AssertNever(stmt);
			return ';';
	}
}

function emitControlledStmt(stmt: Stmt): string {
	return stmt.kind === 'BlockStmt' ? emitStmtInner(stmt) : emitStmtInner(stmt);
}

function emitExprPrec(expr: Expr, parentPrec: number): string {
	const ownPrec = exprPrecedence(expr);
	let out: string;
	switch (expr.kind) {
		case 'StringLiteral':
			out = JSON.stringify(expr.value);
			break;
		case 'NumberLiteral':
			out = expr.raw;
			break;
		case 'Identifier':
			out = expr.name;
			break;
		case 'Call':
			out = `${emitExprPrec(expr.callee, ownPrec)}(${expr.args.map(arg => emitExprPrec(arg, 0)).join(',')})`;
			break;
		case 'Member':
			out = `${emitExprPrec(expr.object, ownPrec)}.${expr.property}`;
			break;
		case 'Unary':
			out = `${expr.op}${emitExprPrec(expr.argument, ownPrec)}`;
			break;
		case 'Binary': {
			const prec = binPrecedence(expr.op);
			const leftPrec = isRightAssociative(expr.op) ? prec + 1 : prec;
			const rightPrec = isRightAssociative(expr.op) ? prec : prec + 1;
			out = `${emitExprPrec(expr.left, leftPrec)}${expr.op}${emitExprPrec(expr.right, rightPrec)}`;
			break;
		}
		case 'Cast': {
			const argument = castArgumentNeedsParens(expr.argument)
				? `(${emitExprPrec(expr.argument, 0)})`
				: emitExprPrec(expr.argument, ownPrec);
			out = `(${expr.type})${argument}`;
			break;
		}
		case 'Paren':
			out = `(${emitExprPrec(expr.expression, 0)})`;
			break;
		case 'ListLiteral':
			out = `[${expr.elements.map(element => emitExprPrec(element, 0)).join(',')}]`;
			break;
		case 'VectorLiteral':
			out = `<${expr.elements.map(element => emitExprPrec(element, 0)).join(',')}>`;
			break;
		case 'ErrorExpr':
			out = '0';
			break;
		default:
			AssertNever(expr);
			out = '0';
			break;
	}
	return ownPrec < parentPrec ? `(${out})` : out;
}

function castArgumentNeedsParens(expr: Expr): boolean {
	return expr.kind === 'Unary' || expr.kind === 'Cast' || expr.kind === 'VectorLiteral' || expr.kind === 'ListLiteral';
}

function exprPrecedence(expr: Expr): number {
	switch (expr.kind) {
		case 'ErrorExpr':
		case 'StringLiteral':
		case 'NumberLiteral':
		case 'Identifier':
		case 'ListLiteral':
		case 'VectorLiteral':
			return 14;
		case 'Call':
		case 'Member':
			return 13;
		case 'Unary':
		case 'Cast':
			return 12;
		case 'Binary':
			return binPrecedence(expr.op);
		case 'Paren':
			return 14;
		default:
			AssertNever(expr);
			return 0;
	}
}

function binPrecedence(op: BinOp): number {
	switch (op) {
		case '=':
		case '+=':
		case '-=':
		case '*=':
		case '/=':
		case '%=':
			return 1;
		case '||':
			return 2;
		case '&&':
			return 3;
		case '|':
			return 4;
		case '^':
			return 5;
		case '&':
			return 6;
		case '==':
		case '!=':
			return 7;
		case '<':
		case '<=':
		case '>':
		case '>=':
			return 8;
		case '<<':
		case '>>':
			return 9;
		case '+':
		case '-':
			return 10;
		case '*':
		case '/':
		case '%':
			return 11;
		default:
			AssertNever(op);
			return 0;
	}
}

function isRightAssociative(op: BinOp): boolean {
	return op === '=' || op === '+=' || op === '-=' || op === '*=' || op === '/=' || op === '%=';
}
