import type { Expr, Function as FnNode, Script, State, Stmt, Type } from './types';
import { canonicalType, isTypeName, spanFrom } from './types';
import { AssertNever } from '../utils';
import type { Defs } from '../defs';

const LAZY_INDEX_CALLEE = '__lsl_lsp_lazy_index';
const LAZY_SET_HELPER = '__lsl_lsp_lazy_list_set';

type LowerResult<T> = { node: T; needsSetHelper: boolean };
type LowerOptions = { defs?: Defs };
type LowerContext = { expectedType?: Type; signatures: Map<string, Type[][]> };

export function lazyListIndexCall(object: Expr, index: Expr): Expr {
	return {
		span: spanFrom(object.span.start, index.span.end),
		kind: 'Call',
		callee: { span: object.span, kind: 'Identifier', name: LAZY_INDEX_CALLEE },
		args: [object, index],
	};
}

export function lowerLazyListExpressions(script: Script, opts: LowerOptions = {}): Script {
	let needsSetHelper = false;
	const context: LowerContext = { signatures: collectCallSignatures(script, opts.defs) };
	const functions = new Map<string, FnNode>();
	for (const [name, fn] of script.functions) {
		const lowered = lowerFunction(fn, context);
		needsSetHelper = needsSetHelper || lowered.needsSetHelper;
		functions.set(name, lowered.node);
	}
	const states = new Map<string, State>();
	for (const [name, state] of script.states) {
		const lowered = lowerState(state, context);
		needsSetHelper = needsSetHelper || lowered.needsSetHelper;
		states.set(name, lowered.node);
	}
	const globals = new Map(script.globals);
	for (const [name, global] of globals) {
		if (!global.initializer) continue;
		const lowered = lowerExpr(global.initializer, { ...context, expectedType: global.varType });
		needsSetHelper = needsSetHelper || lowered.needsSetHelper;
		globals.set(name, { ...global, initializer: lowered.node });
	}
	if (needsSetHelper && !functions.has(LAZY_SET_HELPER)) {
		functions.set(LAZY_SET_HELPER, lazySetHelperFunction());
	}
	return { ...script, globals, functions, states };
}

function lowerFunction(fn: FnNode, context: LowerContext): LowerResult<FnNode> {
	const body = lowerStmt(fn.body, context);
	return { node: { ...fn, body: body.node }, needsSetHelper: body.needsSetHelper };
}

function lowerState(state: State, context: LowerContext): LowerResult<State> {
	let needsSetHelper = false;
	const events = state.events.map(event => {
		const body = lowerStmt(event.body, context);
		needsSetHelper = needsSetHelper || body.needsSetHelper;
		return { ...event, body: body.node };
	});
	return { node: { ...state, events }, needsSetHelper };
}

function lowerStmt(stmt: Stmt, context: LowerContext): LowerResult<Stmt> {
	switch (stmt.kind) {
		case 'EmptyStmt':
		case 'ErrorStmt':
		case 'LabelStmt':
		case 'StateChangeStmt':
			return { node: stmt, needsSetHelper: false };
		case 'ExprStmt': {
			const expression = lowerExpr(stmt.expression, context);
			return { node: { ...stmt, expression: expression.node }, needsSetHelper: expression.needsSetHelper };
		}
		case 'VarDecl': {
			const initializer = stmt.initializer ? lowerExpr(stmt.initializer, { ...context, expectedType: stmt.varType }) : null;
			return {
				node: initializer ? { ...stmt, initializer: initializer.node } : stmt,
				needsSetHelper: !!initializer?.needsSetHelper,
			};
		}
		case 'ReturnStmt': {
			const expression = stmt.expression ? lowerExpr(stmt.expression, context) : null;
			return {
				node: expression ? { ...stmt, expression: expression.node } : stmt,
				needsSetHelper: !!expression?.needsSetHelper,
			};
		}
		case 'IfStmt': {
			const condition = lowerExpr(stmt.condition, context);
			const then = lowerStmt(stmt.then, context);
			const els = stmt.else ? lowerStmt(stmt.else, context) : null;
			return {
				node: { ...stmt, condition: condition.node, then: then.node, else: els?.node },
				needsSetHelper: condition.needsSetHelper || then.needsSetHelper || !!els?.needsSetHelper,
			};
		}
		case 'WhileStmt': {
			const condition = lowerExpr(stmt.condition, context);
			const body = lowerStmt(stmt.body, context);
			return {
				node: { ...stmt, condition: condition.node, body: body.node },
				needsSetHelper: condition.needsSetHelper || body.needsSetHelper,
			};
		}
		case 'DoWhileStmt': {
			const body = lowerStmt(stmt.body, context);
			const condition = lowerExpr(stmt.condition, context);
			return {
				node: { ...stmt, body: body.node, condition: condition.node },
				needsSetHelper: body.needsSetHelper || condition.needsSetHelper,
			};
		}
		case 'ForStmt': {
			const init = stmt.init ? lowerExpr(stmt.init, context) : null;
			const condition = stmt.condition ? lowerExpr(stmt.condition, context) : null;
			const update = stmt.update ? lowerExpr(stmt.update, context) : null;
			const body = lowerStmt(stmt.body, context);
			return {
				node: { ...stmt, init: init?.node, condition: condition?.node, update: update?.node, body: body.node },
				needsSetHelper: !!init?.needsSetHelper || !!condition?.needsSetHelper || !!update?.needsSetHelper || body.needsSetHelper,
			};
		}
		case 'BlockStmt': {
			let needsSetHelper = false;
			const statements = stmt.statements.map(child => {
				const lowered = lowerStmt(child, context);
				needsSetHelper = needsSetHelper || lowered.needsSetHelper;
				return lowered.node;
			});
			return { node: { ...stmt, statements }, needsSetHelper };
		}
		case 'JumpStmt': {
			const target = lowerExpr(stmt.target, context);
			return { node: { ...stmt, target: target.node }, needsSetHelper: target.needsSetHelper };
		}
		default:
			AssertNever(stmt);
			return { node: stmt, needsSetHelper: false };
	}
}

function lowerExpr(expr: Expr, context: LowerContext): LowerResult<Expr> {
	switch (expr.kind) {
		case 'ErrorExpr':
		case 'StringLiteral':
		case 'NumberLiteral':
		case 'Identifier':
			return { node: expr, needsSetHelper: false };
		case 'Member': {
			const object = lowerExpr(expr.object, context);
			return { node: { ...expr, object: object.node }, needsSetHelper: object.needsSetHelper };
		}
		case 'Unary': {
			const argument = lowerExpr(expr.argument, context);
			return { node: { ...expr, argument: argument.node }, needsSetHelper: argument.needsSetHelper };
		}
		case 'Binary': {
			const lazyAssign = lazyIndexArgs(expr.left);
			if (expr.op === '=' && lazyAssign) {
				const object = lowerExpr(lazyAssign[0], context);
				const index = lowerExpr(lazyAssign[1], context);
				const right = lowerExpr(expr.right, context);
				return {
					node: {
						span: expr.span,
						kind: 'Binary',
						op: '=',
						left: object.node,
						right: lazySetCall(object.node, index.node, right.node, expr.span),
					},
					needsSetHelper: true,
				};
			}
			const left = lowerExpr(expr.left, context);
			const right = lowerExpr(expr.right, context);
			return {
				node: { ...expr, left: left.node, right: right.node },
				needsSetHelper: left.needsSetHelper || right.needsSetHelper,
			};
		}
		case 'Cast':
			{
				const lazy = lazyIndexArgs(expr.argument);
				if (lazy) {
					const object = lowerExpr(lazy[0], context);
					const index = lowerExpr(lazy[1], context);
					return {
						node: lazyReadCall(expr.type, object.node, index.node, expr.span),
						needsSetHelper: object.needsSetHelper || index.needsSetHelper,
					};
				}
			}
			{
				const argument = lowerExpr(expr.argument, context);
				return {
					node: { ...expr, argument: argument.node },
					needsSetHelper: argument.needsSetHelper,
				};
			}
		case 'Paren': {
			const expression = lowerExpr(expr.expression, context);
			return { node: { ...expr, expression: expression.node }, needsSetHelper: expression.needsSetHelper };
		}
		case 'ListLiteral': {
			let needsSetHelper = false;
			const elements = expr.elements.map(element => {
				const lowered = lowerExpr(element, context);
				needsSetHelper = needsSetHelper || lowered.needsSetHelper;
				return lowered.node;
			});
			return { node: { ...expr, elements }, needsSetHelper };
		}
		case 'VectorLiteral': {
			let needsSetHelper = false;
			const elements = expr.elements.map(element => {
				const lowered = lowerExpr(element, context);
				needsSetHelper = needsSetHelper || lowered.needsSetHelper;
				return lowered.node;
			}) as Expr[] as [Expr, Expr, Expr] | [Expr, Expr, Expr, Expr];
			return { node: { ...expr, elements }, needsSetHelper };
		}
		case 'Call':
			{
				const lazy = lazyIndexArgs(expr);
				if (lazy) {
					const object = lowerExpr(lazy[0], context);
					const index = lowerExpr(lazy[1], context);
					return {
						node: lazyReadCall(context.expectedType ?? 'list', object.node, index.node, expr.span),
						needsSetHelper: object.needsSetHelper || index.needsSetHelper,
					};
				}
			}
			{
				const callee = lowerExpr(expr.callee, context);
				let needsSetHelper = callee.needsSetHelper;
				const argTypes = expr.callee.kind === 'Identifier'
					? expectedCallArgTypes(context.signatures, expr.callee.name, expr.args.length)
					: [];
				const args = expr.args.map((arg: Expr, index) => {
					const expectedType = argTypes[index];
					const lowered = lowerExpr(arg, expectedType ? { ...context, expectedType } : context);
					needsSetHelper = needsSetHelper || lowered.needsSetHelper;
					return lowered.node;
				});
				return {
					node: { ...expr, callee: callee.node, args },
					needsSetHelper,
				};
			}
		default:
			AssertNever(expr);
			return { node: expr, needsSetHelper: false };
	}
}

function collectCallSignatures(script: Script, defs?: Defs): Map<string, Type[][]> {
	const signatures = new Map<string, Type[][]>();
	if (defs) {
		for (const [name, overloads] of defs.funcs) {
			for (const overload of overloads) {
				const params: Type[] = [];
				let valid = true;
				for (const param of overload.params ?? []) {
					const type = concreteType(param.type);
					if (!type) {
						valid = false;
						break;
					}
					params.push(type);
				}
				if (valid) appendSignature(signatures, name, params);
			}
		}
	}
	for (const [name, fn] of script.functions) {
		appendSignature(signatures, name, [...fn.parameters.values()]);
	}
	return signatures;
}

function concreteType(type: string | undefined): Type | null {
	const normalized = (type ?? '').trim();
	return isTypeName(normalized) ? canonicalType(normalized) : null;
}

function appendSignature(signatures: Map<string, Type[][]>, name: string, params: Type[]): void {
	const existing = signatures.get(name) ?? [];
	existing.push(params);
	signatures.set(name, existing);
}

function expectedCallArgTypes(signatures: Map<string, Type[][]>, name: string, arity: number): Array<Type | undefined> {
	const sameArity = (signatures.get(name) ?? []).filter(params => params.length === arity);
	if (!sameArity.length) return [];
	const out: Array<Type | undefined> = [];
	for (let index = 0; index < arity; index++) {
		const first = sameArity[0]![index];
		out[index] = first && sameArity.every(params => params[index] === first) ? first : undefined;
	}
	return out;
}

function lazyIndexArgs(expr: Expr): [Expr, Expr] | null {
	if (expr.kind === 'Call'
		&& expr.callee.kind === 'Identifier'
		&& expr.callee.name === LAZY_INDEX_CALLEE
		&& expr.args.length === 2) {
		return [expr.args[0]!, expr.args[1]!];
	}
	return null;
}

function lazyReadCall(type: Type, object: Expr, index: Expr, span = object.span): Expr {
	const callee = type === 'integer' ? 'llList2Integer'
		: type === 'float' ? 'llList2Float'
			: type === 'string' ? 'llList2String'
				: type === 'key' ? 'llList2Key'
					: type === 'vector' ? 'llList2Vector'
						: type === 'rotation' ? 'llList2Rot'
							: 'llList2List';
	const args = type === 'list' ? [object, index, index] : [object, index];
	return {
		span,
		kind: 'Call',
		callee: { span, kind: 'Identifier', name: callee },
		args,
	};
}

function lazySetCall(object: Expr, index: Expr, value: Expr, span = object.span): Expr {
	return {
		span,
		kind: 'Call',
		callee: { span, kind: 'Identifier', name: LAZY_SET_HELPER },
		args: [object, index, { span: value.span, kind: 'ListLiteral', elements: [value] }],
	};
}

function id(name: string): Expr {
	return { span: spanFrom(0, 0), kind: 'Identifier', name };
}

function number(raw: string): Expr {
	return { span: spanFrom(0, 0), kind: 'NumberLiteral', raw };
}

function call(name: string, args: Expr[]): Expr {
	return { span: spanFrom(0, 0), kind: 'Call', callee: id(name), args };
}

function lazySetHelperFunction(): FnNode {
	const L = id('L');
	const i = id('i');
	return {
		span: spanFrom(0, 0),
		kind: 'Function',
		returnType: 'list',
		name: LAZY_SET_HELPER,
		parameters: new Map<string, Type>([['L', 'list'], ['i', 'integer'], ['v', 'list']]),
		body: {
			span: spanFrom(0, 0),
			kind: 'BlockStmt',
			statements: [
				{
					span: spanFrom(0, 0),
					kind: 'WhileStmt',
					condition: {
						span: spanFrom(0, 0),
						kind: 'Binary',
						op: '<',
						left: call('llGetListLength', [L]),
						right: i,
					},
					body: {
						span: spanFrom(0, 0),
						kind: 'ExprStmt',
						expression: {
							span: spanFrom(0, 0),
							kind: 'Binary',
							op: '=',
							left: L,
							right: {
								span: spanFrom(0, 0),
								kind: 'Binary',
								op: '+',
								left: L,
								right: number('0'),
							},
						},
					},
				},
				{
					span: spanFrom(0, 0),
					kind: 'ReturnStmt',
					expression: call('llListReplaceList', [L, id('v'), i, i]),
				},
			],
		},
	};
}
