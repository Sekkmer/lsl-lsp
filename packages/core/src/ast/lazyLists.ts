import type { Expr, Function as FnNode, Script, State, Stmt, Type } from './types';
import { spanFrom } from './types';
import { AssertNever } from '../utils';

const LAZY_INDEX_CALLEE = '__lsl_lsp_lazy_index';
const LAZY_SET_HELPER = '__lsl_lsp_lazy_list_set';

type LowerResult<T> = { node: T; needsSetHelper: boolean };

export function lazyListIndexCall(object: Expr, index: Expr): Expr {
	return {
		span: spanFrom(object.span.start, index.span.end),
		kind: 'Call',
		callee: { span: object.span, kind: 'Identifier', name: LAZY_INDEX_CALLEE },
		args: [object, index],
	};
}

export function lowerLazyListExpressions(script: Script): Script {
	let needsSetHelper = false;
	const functions = new Map<string, FnNode>();
	for (const [name, fn] of script.functions) {
		const lowered = lowerFunction(fn);
		needsSetHelper = needsSetHelper || lowered.needsSetHelper;
		functions.set(name, lowered.node);
	}
	const states = new Map<string, State>();
	for (const [name, state] of script.states) {
		const lowered = lowerState(state);
		needsSetHelper = needsSetHelper || lowered.needsSetHelper;
		states.set(name, lowered.node);
	}
	const globals = new Map(script.globals);
	for (const [name, global] of globals) {
		if (!global.initializer) continue;
		const lowered = lowerExpr(global.initializer);
		needsSetHelper = needsSetHelper || lowered.needsSetHelper;
		globals.set(name, { ...global, initializer: lowered.node });
	}
	if (needsSetHelper && !functions.has(LAZY_SET_HELPER)) {
		functions.set(LAZY_SET_HELPER, lazySetHelperFunction());
	}
	return { ...script, globals, functions, states };
}

function lowerFunction(fn: FnNode): LowerResult<FnNode> {
	const body = lowerStmt(fn.body);
	return { node: { ...fn, body: body.node }, needsSetHelper: body.needsSetHelper };
}

function lowerState(state: State): LowerResult<State> {
	let needsSetHelper = false;
	const events = state.events.map(event => {
		const body = lowerStmt(event.body);
		needsSetHelper = needsSetHelper || body.needsSetHelper;
		return { ...event, body: body.node };
	});
	return { node: { ...state, events }, needsSetHelper };
}

function lowerStmt(stmt: Stmt): LowerResult<Stmt> {
	switch (stmt.kind) {
		case 'EmptyStmt':
		case 'ErrorStmt':
		case 'LabelStmt':
		case 'StateChangeStmt':
			return { node: stmt, needsSetHelper: false };
		case 'ExprStmt': {
			const expression = lowerExpr(stmt.expression);
			return { node: { ...stmt, expression: expression.node }, needsSetHelper: expression.needsSetHelper };
		}
		case 'VarDecl': {
			const initializer = stmt.initializer ? lowerExpr(stmt.initializer) : null;
			return {
				node: initializer ? { ...stmt, initializer: initializer.node } : stmt,
				needsSetHelper: !!initializer?.needsSetHelper,
			};
		}
		case 'ReturnStmt': {
			const expression = stmt.expression ? lowerExpr(stmt.expression) : null;
			return {
				node: expression ? { ...stmt, expression: expression.node } : stmt,
				needsSetHelper: !!expression?.needsSetHelper,
			};
		}
		case 'IfStmt': {
			const condition = lowerExpr(stmt.condition);
			const then = lowerStmt(stmt.then);
			const els = stmt.else ? lowerStmt(stmt.else) : null;
			return {
				node: { ...stmt, condition: condition.node, then: then.node, else: els?.node },
				needsSetHelper: condition.needsSetHelper || then.needsSetHelper || !!els?.needsSetHelper,
			};
		}
		case 'WhileStmt': {
			const condition = lowerExpr(stmt.condition);
			const body = lowerStmt(stmt.body);
			return {
				node: { ...stmt, condition: condition.node, body: body.node },
				needsSetHelper: condition.needsSetHelper || body.needsSetHelper,
			};
		}
		case 'DoWhileStmt': {
			const body = lowerStmt(stmt.body);
			const condition = lowerExpr(stmt.condition);
			return {
				node: { ...stmt, body: body.node, condition: condition.node },
				needsSetHelper: body.needsSetHelper || condition.needsSetHelper,
			};
		}
		case 'ForStmt': {
			const init = stmt.init ? lowerExpr(stmt.init) : null;
			const condition = stmt.condition ? lowerExpr(stmt.condition) : null;
			const update = stmt.update ? lowerExpr(stmt.update) : null;
			const body = lowerStmt(stmt.body);
			return {
				node: { ...stmt, init: init?.node, condition: condition?.node, update: update?.node, body: body.node },
				needsSetHelper: !!init?.needsSetHelper || !!condition?.needsSetHelper || !!update?.needsSetHelper || body.needsSetHelper,
			};
		}
		case 'BlockStmt': {
			let needsSetHelper = false;
			const statements = stmt.statements.map(child => {
				const lowered = lowerStmt(child);
				needsSetHelper = needsSetHelper || lowered.needsSetHelper;
				return lowered.node;
			});
			return { node: { ...stmt, statements }, needsSetHelper };
		}
		case 'JumpStmt': {
			const target = lowerExpr(stmt.target);
			return { node: { ...stmt, target: target.node }, needsSetHelper: target.needsSetHelper };
		}
		default:
			AssertNever(stmt);
			return { node: stmt, needsSetHelper: false };
	}
}

function lowerExpr(expr: Expr): LowerResult<Expr> {
	switch (expr.kind) {
		case 'ErrorExpr':
		case 'StringLiteral':
		case 'NumberLiteral':
		case 'Identifier':
			return { node: expr, needsSetHelper: false };
		case 'Member': {
			const object = lowerExpr(expr.object);
			return { node: { ...expr, object: object.node }, needsSetHelper: object.needsSetHelper };
		}
		case 'Unary': {
			const argument = lowerExpr(expr.argument);
			return { node: { ...expr, argument: argument.node }, needsSetHelper: argument.needsSetHelper };
		}
		case 'Binary': {
			const lazyAssign = lazyIndexArgs(expr.left);
			if (expr.op === '=' && lazyAssign) {
				const object = lowerExpr(lazyAssign[0]);
				const index = lowerExpr(lazyAssign[1]);
				const right = lowerExpr(expr.right);
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
			const left = lowerExpr(expr.left);
			const right = lowerExpr(expr.right);
			return {
				node: { ...expr, left: left.node, right: right.node },
				needsSetHelper: left.needsSetHelper || right.needsSetHelper,
			};
		}
		case 'Cast':
			{
				const lazy = lazyIndexArgs(expr.argument);
				if (lazy) {
					const object = lowerExpr(lazy[0]);
					const index = lowerExpr(lazy[1]);
					return {
						node: lazyReadCall(expr.type, object.node, index.node, expr.span),
						needsSetHelper: object.needsSetHelper || index.needsSetHelper,
					};
				}
			}
			{
				const argument = lowerExpr(expr.argument);
				return {
					node: { ...expr, argument: argument.node },
					needsSetHelper: argument.needsSetHelper,
				};
			}
		case 'Paren': {
			const expression = lowerExpr(expr.expression);
			return { node: { ...expr, expression: expression.node }, needsSetHelper: expression.needsSetHelper };
		}
		case 'ListLiteral': {
			let needsSetHelper = false;
			const elements = expr.elements.map(element => {
				const lowered = lowerExpr(element);
				needsSetHelper = needsSetHelper || lowered.needsSetHelper;
				return lowered.node;
			});
			return { node: { ...expr, elements }, needsSetHelper };
		}
		case 'VectorLiteral': {
			let needsSetHelper = false;
			const elements = expr.elements.map(element => {
				const lowered = lowerExpr(element);
				needsSetHelper = needsSetHelper || lowered.needsSetHelper;
				return lowered.node;
			}) as Expr[] as [Expr, Expr, Expr] | [Expr, Expr, Expr, Expr];
			return { node: { ...expr, elements }, needsSetHelper };
		}
		case 'Call':
			{
				const lazy = lazyIndexArgs(expr);
				if (lazy) {
					const object = lowerExpr(lazy[0]);
					const index = lowerExpr(lazy[1]);
					return {
						node: lazyReadCall('list', object.node, index.node, expr.span),
						needsSetHelper: object.needsSetHelper || index.needsSetHelper,
					};
				}
			}
			{
				const callee = lowerExpr(expr.callee);
				let needsSetHelper = callee.needsSetHelper;
				const args = expr.args.map((arg: Expr) => {
					const lowered = lowerExpr(arg);
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
