import { KEYWORD_SET } from './lexer';
import type { Event, Expr, Function as FnNode, GlobalVar, Script, State, Stmt, Type } from './types';
import { AssertNever } from '../utils';

type NameMap = Map<string, string>;

const BUILTIN_CONSTANT_NAMES = [
	'TRUE',
	'FALSE',
	'NULL_KEY',
	'EOF',
	'PI',
	'TWO_PI',
	'PI_BY_TWO',
	'ZERO_VECTOR',
	'ZERO_ROTATION',
] as const;

const DEFAULT_RESERVED_LOCAL_NAMES = new Set<string>([
	...KEYWORD_SET,
	...BUILTIN_CONSTANT_NAMES,
]);

export interface ShrinkNamesOptions {
	enabled?: boolean;
	reservedTopLevelNames?: Iterable<string>;
	reservedLocalNames?: Iterable<string>;
}

export function shrinkScriptNames(script: Script, options: ShrinkNamesOptions = {}): Script {
	if (options.enabled === false) return script;
	const reserved = normalizeReservedNames(options);
	const topLevel = buildTopLevelMap(script, reserved.topLevel);
	return {
		...script,
		globals: renameGlobals(script.globals, topLevel),
		functions: renameFunctions(script.functions, topLevel, reserved.local),
		states: renameStates(script.states, topLevel, reserved.local),
	};
}

export function shrinkNameOptionsFromDefs(defs: { consts: ReadonlyMap<string, unknown>; funcs: ReadonlyMap<string, unknown>; events: ReadonlyMap<string, unknown> }): ShrinkNamesOptions {
	return {
		reservedTopLevelNames: [...defs.consts.keys(), ...defs.funcs.keys(), ...defs.events.keys()],
		reservedLocalNames: [...defs.consts.keys()],
	};
}

function normalizeReservedNames(options: ShrinkNamesOptions): { topLevel: ReadonlySet<string>; local: ReadonlySet<string> } {
	const topLevel = new Set(DEFAULT_RESERVED_LOCAL_NAMES);
	for (const name of options.reservedTopLevelNames ?? []) topLevel.add(name);
	const local = new Set(DEFAULT_RESERVED_LOCAL_NAMES);
	for (const name of options.reservedLocalNames ?? []) local.add(name);
	return { topLevel, local };
}

function buildTopLevelMap(script: Script, reservedTopLevelNames: ReadonlySet<string>): NameMap {
	const gen = new NameGenerator(reservedTopLevelNames);
	const map: NameMap = new Map();
	for (const name of script.states.keys()) {
		if (name !== 'default') map.set(name, gen.next());
	}
	for (const name of script.functions.keys()) map.set(name, gen.next());
	for (const name of script.globals.keys()) map.set(name, gen.next());
	return map;
}

function renameGlobals(globals: ReadonlyMap<string, GlobalVar>, topLevel: NameMap): Map<string, GlobalVar> {
	const out = new Map<string, GlobalVar>();
	for (const [name, global] of globals) {
		const renamed = {
			...global,
			name: topLevel.get(name) ?? name,
			initializer: global.initializer ? renameExpr(global.initializer, [topLevel]) : undefined,
		};
		out.set(renamed.name, renamed);
	}
	return out;
}

function renameFunctions(functions: ReadonlyMap<string, FnNode>, topLevel: NameMap, reservedLocalNames: ReadonlySet<string>): Map<string, FnNode> {
	const out = new Map<string, FnNode>();
	for (const [name, fn] of functions) {
		const gen = newLocalNameGenerator(topLevel, reservedLocalNames);
		const params = renameParams(fn.parameters, gen);
		const body = renameStmt(fn.body, [topLevel, params.map], gen);
		const renamed = {
			...fn,
			name: topLevel.get(name) ?? name,
			parameters: params.params,
			body,
		};
		out.set(renamed.name, renamed);
	}
	return out;
}

function renameStates(states: ReadonlyMap<string, State>, topLevel: NameMap, reservedLocalNames: ReadonlySet<string>): Map<string, State> {
	const out = new Map<string, State>();
	for (const [name, state] of states) {
		const renamed = {
			...state,
			name: topLevel.get(name) ?? name,
			events: state.events.map(event => renameEvent(event, topLevel, reservedLocalNames)),
		};
		out.set(renamed.name, renamed);
	}
	return out;
}

function renameEvent(event: Event, topLevel: NameMap, reservedLocalNames: ReadonlySet<string>): Event {
	const gen = newLocalNameGenerator(topLevel, reservedLocalNames);
	const params = renameParams(event.parameters, gen);
	return {
		...event,
		parameters: params.params,
		body: renameStmt(event.body, [topLevel, params.map], gen),
	};
}

function renameParams(params: ReadonlyMap<string, Type>, gen: NameGenerator): { params: Map<string, Type>; map: NameMap } {
	const out = new Map<string, Type>();
	const map: NameMap = new Map();
	for (const [name, type] of params) {
		const next = gen.next();
		map.set(name, next);
		out.set(next, type);
	}
	return { params: out, map };
}

function renameStmt(stmt: Stmt, scopes: NameMap[], gen: NameGenerator): Stmt {
	switch (stmt.kind) {
		case 'EmptyStmt':
		case 'ErrorStmt':
		case 'LabelStmt':
			return stmt;
		case 'StateChangeStmt':
			return { ...stmt, state: lookupName(stmt.state, scopes) ?? stmt.state };
		case 'ExprStmt':
			return { ...stmt, expression: renameExpr(stmt.expression, scopes) };
		case 'VarDecl': {
			const initializer = stmt.initializer ? renameExpr(stmt.initializer, scopes) : undefined;
			const local = scopes[scopes.length - 1]!;
			const name = gen.next();
			local.set(stmt.name, name);
			return { ...stmt, name, initializer };
		}
		case 'ReturnStmt':
			return { ...stmt, expression: stmt.expression ? renameExpr(stmt.expression, scopes) : undefined };
		case 'IfStmt':
			return {
				...stmt,
				condition: renameExpr(stmt.condition, scopes),
				then: renameStmt(stmt.then, scopes, gen),
				else: stmt.else ? renameStmt(stmt.else, scopes, gen) : undefined,
			};
		case 'WhileStmt':
			return { ...stmt, condition: renameExpr(stmt.condition, scopes), body: renameStmt(stmt.body, scopes, gen) };
		case 'DoWhileStmt':
			return { ...stmt, body: renameStmt(stmt.body, scopes, gen), condition: renameExpr(stmt.condition, scopes) };
		case 'ForStmt':
			return {
				...stmt,
				init: stmt.init ? renameExpr(stmt.init, scopes) : undefined,
				condition: stmt.condition ? renameExpr(stmt.condition, scopes) : undefined,
				update: stmt.update ? renameExpr(stmt.update, scopes) : undefined,
				body: renameStmt(stmt.body, scopes, gen),
			};
		case 'BlockStmt': {
			const blockScope: NameMap = new Map();
			const nextScopes = [...scopes, blockScope];
			return { ...stmt, statements: stmt.statements.map(child => renameStmt(child, nextScopes, gen)) };
		}
		case 'JumpStmt':
			return { ...stmt, target: stmt.target.kind === 'Identifier' ? stmt.target : renameExpr(stmt.target, scopes) };
		default:
			AssertNever(stmt);
			return stmt;
	}
}

function renameExpr(expr: Expr, scopes: NameMap[]): Expr {
	switch (expr.kind) {
		case 'ErrorExpr':
		case 'StringLiteral':
		case 'NumberLiteral':
			return expr;
		case 'Identifier':
			return { ...expr, name: lookupName(expr.name, scopes) ?? expr.name };
		case 'Call':
			return { ...expr, callee: renameCallCallee(expr.callee, scopes), args: expr.args.map(arg => renameExpr(arg, scopes)) };
		case 'Member':
			return { ...expr, object: renameExpr(expr.object, scopes) };
		case 'Unary':
			return { ...expr, argument: renameExpr(expr.argument, scopes) };
		case 'Binary':
			return { ...expr, left: renameExpr(expr.left, scopes), right: renameExpr(expr.right, scopes) };
		case 'Cast':
			return { ...expr, argument: renameExpr(expr.argument, scopes) };
		case 'Paren':
			return { ...expr, expression: renameExpr(expr.expression, scopes) };
		case 'ListLiteral':
			return { ...expr, elements: expr.elements.map(element => renameExpr(element, scopes)) };
		case 'VectorLiteral':
			return { ...expr, elements: expr.elements.map(element => renameExpr(element, scopes)) as [Expr, Expr, Expr] | [Expr, Expr, Expr, Expr] };
		default:
			AssertNever(expr);
			return expr;
	}
}

function renameCallCallee(expr: Expr, scopes: NameMap[]): Expr {
	if (expr.kind !== 'Identifier') return renameExpr(expr, scopes);
	const topLevel = scopes[0];
	return { ...expr, name: topLevel?.get(expr.name) ?? expr.name };
}

function lookupName(name: string, scopes: NameMap[]): string | undefined {
	for (let i = scopes.length - 1; i >= 0; i--) {
		const next = scopes[i]!.get(name);
		if (next) return next;
	}
	return undefined;
}

function newLocalNameGenerator(topLevel: NameMap, reservedLocalNames: ReadonlySet<string>): NameGenerator {
	return new NameGenerator([...reservedLocalNames, ...topLevel.values()]);
}

class NameGenerator {
	private index = 0;
	private readonly used = new Set<string>();

	constructor(reserved: Iterable<string> = []) {
		for (const name of reserved) this.used.add(name);
	}

	next(): string {
		for (;;) {
			const candidate = shortName(this.index++);
			if (this.used.has(candidate)) continue;
			this.used.add(candidate);
			return candidate;
		}
	}
}

function shortName(index: number): string {
	const first = '_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
	const rest = '0123456789_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
	if (index < first.length) return first[index]!;
	index -= first.length;
	let out = first[index % first.length]!;
	index = Math.floor(index / first.length);
	do {
		out += rest[index % rest.length]!;
		index = Math.floor(index / rest.length);
	} while (index > 0);
	return out;
}
