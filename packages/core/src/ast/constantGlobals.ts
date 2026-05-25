import type { Expr, Function as FnNode, GlobalVar, Script, State, Stmt } from './types';
import { AssertNever } from '../utils';

type NameMap = Map<string, Expr>;

const ASSIGNMENT_OPS = new Set(['=', '+=', '-=', '*=', '/=', '%=']);

export function inlineConstantGlobals(script: Script): Script {
	const written = collectWrittenNames(script);
	const constants = new Map<string, Expr>();
	for (const [name, global] of script.globals) {
		if (written.has(name)) continue;
		if (!global.initializer || !isInlineableInitializer(global.initializer)) continue;
		constants.set(name, global.initializer);
	}
	if (constants.size === 0) return script;

	const globals = new Map<string, GlobalVar>();
	for (const [name, global] of script.globals) {
		if (constants.has(name)) continue;
		globals.set(name, {
			...global,
			initializer: global.initializer ? inlineExpr(global.initializer, constants, []) : undefined,
		});
	}

	return {
		...script,
		globals,
		functions: mapValues(script.functions, fn => inlineFunction(fn, constants)),
		states: mapValues(script.states, state => inlineState(state, constants)),
	};
}

function inlineFunction(fn: FnNode, constants: NameMap): FnNode {
	return {
		...fn,
		body: inlineStmt(fn.body, constants, [new Set(fn.parameters.keys())]),
	};
}

function inlineState(state: State, constants: NameMap): State {
	return {
		...state,
		events: state.events.map(event => ({
			...event,
			body: inlineStmt(event.body, constants, [new Set(event.parameters.keys())]),
		})),
	};
}

function inlineStmt(stmt: Stmt, constants: NameMap, scopes: Array<Set<string>>): Stmt {
	switch (stmt.kind) {
		case 'EmptyStmt':
		case 'ErrorStmt':
		case 'LabelStmt':
		case 'StateChangeStmt':
			return stmt;
		case 'ExprStmt':
			return { ...stmt, expression: inlineExpr(stmt.expression, constants, scopes) };
		case 'VarDecl': {
			const initializer = stmt.initializer ? inlineExpr(stmt.initializer, constants, scopes) : undefined;
			scopes[scopes.length - 1]!.add(stmt.name);
			return { ...stmt, initializer };
		}
		case 'ReturnStmt':
			return { ...stmt, expression: stmt.expression ? inlineExpr(stmt.expression, constants, scopes) : undefined };
		case 'IfStmt':
			return {
				...stmt,
				condition: inlineExpr(stmt.condition, constants, scopes),
				then: inlineStmt(stmt.then, constants, scopes),
				else: stmt.else ? inlineStmt(stmt.else, constants, scopes) : undefined,
			};
		case 'WhileStmt':
			return { ...stmt, condition: inlineExpr(stmt.condition, constants, scopes), body: inlineStmt(stmt.body, constants, scopes) };
		case 'DoWhileStmt':
			return { ...stmt, body: inlineStmt(stmt.body, constants, scopes), condition: inlineExpr(stmt.condition, constants, scopes) };
		case 'ForStmt':
			return {
				...stmt,
				init: stmt.init ? inlineExpr(stmt.init, constants, scopes) : undefined,
				condition: stmt.condition ? inlineExpr(stmt.condition, constants, scopes) : undefined,
				update: stmt.update ? inlineExpr(stmt.update, constants, scopes) : undefined,
				body: inlineStmt(stmt.body, constants, scopes),
			};
		case 'BlockStmt': {
			const blockScope = new Set<string>();
			const nextScopes = [...scopes, blockScope];
			return { ...stmt, statements: stmt.statements.map(child => inlineStmt(child, constants, nextScopes)) };
		}
		case 'JumpStmt':
			return { ...stmt, target: inlineExpr(stmt.target, constants, scopes) };
		default:
			AssertNever(stmt);
			return stmt;
	}
}

function inlineExpr(expr: Expr, constants: NameMap, scopes: Array<Set<string>>): Expr {
	switch (expr.kind) {
		case 'ErrorExpr':
		case 'StringLiteral':
		case 'NumberLiteral':
			return expr;
		case 'Identifier': {
			if (isShadowed(expr.name, scopes)) return expr;
			const value = constants.get(expr.name);
			return value ? cloneExpr(value) : expr;
		}
		case 'Call':
			return { ...expr, callee: expr.callee, args: expr.args.map(arg => inlineExpr(arg, constants, scopes)) };
		case 'Member':
			return { ...expr, object: inlineExpr(expr.object, constants, scopes) };
		case 'Unary':
			return { ...expr, argument: inlineExpr(expr.argument, constants, scopes) };
		case 'Binary':
			if (isAssignmentOp(expr.op)) {
				return { ...expr, right: inlineExpr(expr.right, constants, scopes) };
			}
			return { ...expr, left: inlineExpr(expr.left, constants, scopes), right: inlineExpr(expr.right, constants, scopes) };
		case 'Cast':
			return { ...expr, argument: inlineExpr(expr.argument, constants, scopes) };
		case 'Paren':
			return { ...expr, expression: inlineExpr(expr.expression, constants, scopes) };
		case 'ListLiteral':
			return { ...expr, elements: expr.elements.map(element => inlineExpr(element, constants, scopes)) };
		case 'VectorLiteral':
			return { ...expr, elements: expr.elements.map(element => inlineExpr(element, constants, scopes)) as [Expr, Expr, Expr] | [Expr, Expr, Expr, Expr] };
		default:
			AssertNever(expr);
			return expr;
	}
}

function collectWrittenNames(script: Script): Set<string> {
	const out = new Set<string>();
	for (const global of script.globals.values()) {
		if (global.initializer) collectWrittenNamesFromExpr(global.initializer, out);
	}
	for (const fn of script.functions.values()) collectWrittenNamesFromStmt(fn.body, out);
	for (const state of script.states.values()) {
		for (const event of state.events) collectWrittenNamesFromStmt(event.body, out);
	}
	return out;
}

function collectWrittenNamesFromStmt(stmt: Stmt, out: Set<string>): void {
	switch (stmt.kind) {
		case 'EmptyStmt':
		case 'ErrorStmt':
		case 'LabelStmt':
		case 'StateChangeStmt':
			return;
		case 'ExprStmt':
			collectWrittenNamesFromExpr(stmt.expression, out);
			return;
		case 'VarDecl':
			if (stmt.initializer) collectWrittenNamesFromExpr(stmt.initializer, out);
			return;
		case 'ReturnStmt':
			if (stmt.expression) collectWrittenNamesFromExpr(stmt.expression, out);
			return;
		case 'IfStmt':
			collectWrittenNamesFromExpr(stmt.condition, out);
			collectWrittenNamesFromStmt(stmt.then, out);
			if (stmt.else) collectWrittenNamesFromStmt(stmt.else, out);
			return;
		case 'WhileStmt':
			collectWrittenNamesFromExpr(stmt.condition, out);
			collectWrittenNamesFromStmt(stmt.body, out);
			return;
		case 'DoWhileStmt':
			collectWrittenNamesFromStmt(stmt.body, out);
			collectWrittenNamesFromExpr(stmt.condition, out);
			return;
		case 'ForStmt':
			if (stmt.init) collectWrittenNamesFromExpr(stmt.init, out);
			if (stmt.condition) collectWrittenNamesFromExpr(stmt.condition, out);
			if (stmt.update) collectWrittenNamesFromExpr(stmt.update, out);
			collectWrittenNamesFromStmt(stmt.body, out);
			return;
		case 'BlockStmt':
			for (const child of stmt.statements) collectWrittenNamesFromStmt(child, out);
			return;
		case 'JumpStmt':
			collectWrittenNamesFromExpr(stmt.target, out);
			return;
		default:
			AssertNever(stmt);
	}
}

function collectWrittenNamesFromExpr(expr: Expr, out: Set<string>): void {
	switch (expr.kind) {
		case 'ErrorExpr':
		case 'StringLiteral':
		case 'NumberLiteral':
		case 'Identifier':
			return;
		case 'Call':
			collectWrittenNamesFromExpr(expr.callee, out);
			for (const arg of expr.args) collectWrittenNamesFromExpr(arg, out);
			return;
		case 'Member':
			collectWrittenNamesFromExpr(expr.object, out);
			return;
		case 'Unary':
			if ((expr.op === '++' || expr.op === '--') && expr.argument.kind === 'Identifier') out.add(expr.argument.name);
			collectWrittenNamesFromExpr(expr.argument, out);
			return;
		case 'Binary':
			if (isAssignmentOp(expr.op)) collectAssignmentTarget(expr.left, out);
			else collectWrittenNamesFromExpr(expr.left, out);
			collectWrittenNamesFromExpr(expr.right, out);
			return;
		case 'Cast':
			collectWrittenNamesFromExpr(expr.argument, out);
			return;
		case 'Paren':
			collectWrittenNamesFromExpr(expr.expression, out);
			return;
		case 'ListLiteral':
			for (const element of expr.elements) collectWrittenNamesFromExpr(element, out);
			return;
		case 'VectorLiteral':
			for (const element of expr.elements) collectWrittenNamesFromExpr(element, out);
			return;
		default:
			AssertNever(expr);
	}
}

function collectAssignmentTarget(expr: Expr, out: Set<string>): void {
	if (expr.kind === 'Identifier') {
		out.add(expr.name);
		return;
	}
	if (expr.kind === 'Member') collectAssignmentTarget(expr.object, out);
}

function isInlineableInitializer(expr: Expr): boolean {
	switch (expr.kind) {
		case 'StringLiteral':
		case 'NumberLiteral':
		case 'Identifier':
			return true;
		case 'Cast':
			return isInlineableInitializer(expr.argument);
		case 'ListLiteral':
			return expr.elements.every(isInlineableInitializer);
		case 'VectorLiteral':
			return expr.elements.every(isInlineableInitializer);
		case 'Paren':
			return isInlineableInitializer(expr.expression);
		default:
			return false;
	}
}

function isShadowed(name: string, scopes: Array<Set<string>>): boolean {
	return scopes.some(scope => scope.has(name));
}

function cloneExpr(expr: Expr): Expr {
	switch (expr.kind) {
		case 'ErrorExpr':
		case 'StringLiteral':
		case 'NumberLiteral':
		case 'Identifier':
			return { ...expr };
		case 'Call':
			return { ...expr, callee: cloneExpr(expr.callee), args: expr.args.map(cloneExpr) };
		case 'Member':
			return { ...expr, object: cloneExpr(expr.object) };
		case 'Unary':
			return { ...expr, argument: cloneExpr(expr.argument) };
		case 'Binary':
			return { ...expr, left: cloneExpr(expr.left), right: cloneExpr(expr.right) };
		case 'Cast':
			return { ...expr, argument: cloneExpr(expr.argument) };
		case 'Paren':
			return { ...expr, expression: cloneExpr(expr.expression) };
		case 'ListLiteral':
			return { ...expr, elements: expr.elements.map(cloneExpr) };
		case 'VectorLiteral':
			return { ...expr, elements: expr.elements.map(cloneExpr) as [Expr, Expr, Expr] | [Expr, Expr, Expr, Expr] };
		default:
			AssertNever(expr);
			return expr;
	}
}

function isAssignmentOp(op: string): boolean {
	return ASSIGNMENT_OPS.has(op);
}

function mapValues<T, U>(map: ReadonlyMap<string, T>, fn: (value: T, key: string) => U): Map<string, U> {
	const out = new Map<string, U>();
	for (const [key, value] of map) out.set(key, fn(value, key));
	return out;
}
