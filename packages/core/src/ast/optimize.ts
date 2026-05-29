import { inlineConstantGlobals } from './constantGlobals';
import { emitExpr, emitScript, emitStmt } from './emit';
import { Env, evalExpr, type Value } from './eval';
import { inferExprTypeFromAst, type SimpleType } from './infer';
import { measureAst } from './measure';
import { NULL_KEY_VALUE } from './key';
import { parseScriptFromText } from './parser';
import * as runtime from './runtime';
import { shrinkScriptNames, type ShrinkNamesOptions } from './shrinkNames';
import type { Event, Expr, Function as FnNode, GlobalVar, Script, State, Stmt, Type } from './types';
import type { DynamicMacros } from '../core/preproc';
import { AssertNever } from '../utils';

export interface OptimizeOptions {
	builtinConstants?: ReadonlyMap<string, Value>;
	builtinFunctionReturnTypes?: ReadonlyMap<string, SimpleType>;
	dynamicMacros?: DynamicMacros;
	constantFold?: boolean;
	dropDefaultInitializers?: boolean;
	dropNoOpCasts?: boolean;
	foldStringConcats?: boolean;
	inlineConstantGlobals?: boolean;
	inlineFunctions?: boolean;
	integerPeepholes?: boolean;
	bitwiseBooleanOps?: boolean;
	listAdd?: boolean;
	removeUnusedFunctions?: boolean;
	shrinkNames?: boolean;
	shrinkNameOptions?: ShrinkNamesOptions;
	maxPasses?: number;
}

export interface OptimizeResult {
	code: string;
	passes: number;
	changed: boolean;
	stable: boolean;
}

type ResolvedOptimizeOptions = Required<Omit<OptimizeOptions, 'builtinConstants' | 'builtinFunctionReturnTypes' | 'dynamicMacros' | 'shrinkNameOptions'>> & Pick<OptimizeOptions, 'builtinConstants' | 'builtinFunctionReturnTypes' | 'dynamicMacros' | 'shrinkNameOptions'>;

const DEFAULT_OPTIONS: Required<Omit<OptimizeOptions, 'builtinConstants' | 'builtinFunctionReturnTypes' | 'dynamicMacros' | 'shrinkNameOptions'>> = {
	constantFold: true,
	dropDefaultInitializers: false,
	dropNoOpCasts: true,
	foldStringConcats: false,
	inlineConstantGlobals: false,
	inlineFunctions: false,
	integerPeepholes: false,
	bitwiseBooleanOps: false,
	listAdd: false,
	removeUnusedFunctions: false,
	shrinkNames: false,
	maxPasses: 4,
};

export function optimizeScript(script: Script, options: OptimizeOptions = {}): OptimizeResult {
	const opts: ResolvedOptimizeOptions = { ...DEFAULT_OPTIONS, ...options };
	const initial = emitScript(script);
	let currentCode = initial;
	let currentScript = script;
	let passes = 0;
	let stable = false;

	for (; passes < opts.maxPasses; passes++) {
		const optimized = optimizeScriptOnce(currentScript, opts);
		const nextCode = emitScript(optimized);
		if (nextCode === currentCode) {
			stable = true;
			break;
		}
		currentCode = nextCode;
		currentScript = parseScriptFromText(currentCode, 'file:///optimized.lsl', { dynamicMacros: opts.dynamicMacros });
	}

	return {
		code: currentCode,
		passes,
		changed: currentCode !== initial,
		stable,
	};
}

function optimizeScriptOnce(script: Script, opts: ResolvedOptimizeOptions): Script {
	const globalTypes = globalSymbolTypes(script);
	for (const [name, type] of Object.entries(opts.dynamicMacros ?? {})) globalTypes.set(name, type);
	const functionReturnTypes = functionTypes(script, opts.builtinFunctionReturnTypes);
	const pureFunctions = collectPureFunctions(script);
	const constantValues = new Map(opts.builtinConstants);
	for (const [name, type] of Object.entries(opts.dynamicMacros ?? {})) constantValues.set(name, runtime.unknown(type));
	const constantEnv = new Env(constantValues, evalFunctionTypes(functionReturnTypes), script.functions, pureFunctions);
	const optimized = {
		...script,
		globals: mapValues(script.globals, global => optimizeGlobal(global, opts, globalTypes, functionReturnTypes, constantEnv)),
		functions: mapValues(script.functions, fn => optimizeFunction(fn, opts, globalTypes, functionReturnTypes, constantEnv)),
		states: mapValues(script.states, state => optimizeState(state, opts, globalTypes, functionReturnTypes, constantEnv)),
	};
	const compacted = opts.inlineConstantGlobals ? inlineConstantGlobals(optimized) : optimized;
	const beforeInline = opts.removeUnusedFunctions ? removeUnusedFunctions(compacted) : compacted;
	const afterSpecialize = opts.inlineFunctions ? specializeConstantArgumentFunctionsByMeasure(beforeInline) : beforeInline;
	const afterExprInline = opts.inlineFunctions ? inlineExpressionFunctionsByMeasure(afterSpecialize) : afterSpecialize;
	const afterInline = opts.inlineFunctions ? inlineSingleUseStatementFunctionsByMeasure(afterExprInline) : afterExprInline;
	const afterDce = opts.removeUnusedFunctions ? removeUnusedFunctions(afterInline) : afterInline;
	const withoutDefaultInitializers = opts.dropDefaultInitializers ? dropDefaultInitializers(afterDce) : afterDce;
	return opts.shrinkNames ? shrinkScriptNames(withoutDefaultInitializers, opts.shrinkNameOptions) : withoutDefaultInitializers;
}

function optimizeGlobal(global: GlobalVar, opts: ResolvedOptimizeOptions, globalTypes: ReadonlyMap<string, SimpleType>, functionReturnTypes: ReadonlyMap<string, SimpleType>, constantEnv: Env): GlobalVar {
	const scope = new TypeScope(undefined, globalTypes);
	return {
		...global,
		initializer: global.initializer ? optimizeExpr(global.initializer, opts, scope, functionReturnTypes, constantEnv, { preserveListLiteralShape: true }) : undefined,
	};
}

function optimizeFunction(fn: FnNode, opts: ResolvedOptimizeOptions, globalTypes: ReadonlyMap<string, SimpleType>, functionReturnTypes: ReadonlyMap<string, SimpleType>, constantEnv: Env): FnNode {
	const scope = new TypeScope(undefined, globalTypes).child();
	for (const [name, type] of fn.parameters) scope.set(name, type);
	return {
		...fn,
		body: optimizeStmt(fn.body, opts, scope, functionReturnTypes, constantEnv),
	};
}

function optimizeState(state: State, opts: ResolvedOptimizeOptions, globalTypes: ReadonlyMap<string, SimpleType>, functionReturnTypes: ReadonlyMap<string, SimpleType>, constantEnv: Env): State {
	return {
		...state,
		events: state.events.map(event => optimizeEvent(event, opts, globalTypes, functionReturnTypes, constantEnv)),
	};
}

function optimizeEvent(event: Event, opts: ResolvedOptimizeOptions, globalTypes: ReadonlyMap<string, SimpleType>, functionReturnTypes: ReadonlyMap<string, SimpleType>, constantEnv: Env): Event {
	const scope = new TypeScope(undefined, globalTypes).child();
	for (const [name, type] of event.parameters) scope.set(name, type);
	return {
		...event,
		body: optimizeStmt(event.body, opts, scope, functionReturnTypes, constantEnv),
	};
}

function optimizeStmt(stmt: Stmt, opts: ResolvedOptimizeOptions, scope: TypeScope, functionReturnTypes: ReadonlyMap<string, SimpleType>, constantEnv: Env): Stmt {
	switch (stmt.kind) {
		case 'EmptyStmt':
		case 'ErrorStmt':
		case 'LabelStmt':
		case 'StateChangeStmt':
			return stmt;
		case 'ExprStmt':
			return {
				...stmt,
				expression: optimizeStatementExpr(
					optimizeExpr(stmt.expression, opts, scope, functionReturnTypes, constantEnv),
					opts,
					scope,
					functionReturnTypes,
				),
			};
		case 'VarDecl': {
			const initializer = stmt.initializer ? optimizeExpr(stmt.initializer, opts, scope, functionReturnTypes, constantEnv) : undefined;
			scope.set(stmt.name, stmt.varType);
			return { ...stmt, initializer };
		}
		case 'ReturnStmt':
			return { ...stmt, expression: stmt.expression ? optimizeExpr(stmt.expression, opts, scope, functionReturnTypes, constantEnv) : undefined };
		case 'IfStmt': {
			const condition = optimizeCondition(stmt.condition, opts, scope, functionReturnTypes, constantEnv);
			const thenStmt = optimizeStmt(stmt.then, opts, scope.child(), functionReturnTypes, constantEnv);
			const elseStmt = stmt.else ? optimizeStmt(stmt.else, opts, scope.child(), functionReturnTypes, constantEnv) : undefined;
			const truth = constantTruth(condition, constantEnv);
			if (truth === true) return thenStmt;
			if (truth === false) return elseStmt ?? { ...stmt, kind: 'EmptyStmt' };
			if (opts.integerPeepholes && condition.kind === 'Unary' && condition.op === '!' && elseStmt) {
				return { ...stmt, condition: condition.argument, then: elseStmt, else: thenStmt };
			}
			return { ...stmt, condition, then: thenStmt, else: elseStmt };
		}
		case 'WhileStmt':
			return { ...stmt, condition: optimizeCondition(stmt.condition, opts, scope, functionReturnTypes, constantEnv), body: optimizeStmt(stmt.body, opts, scope.child(), functionReturnTypes, constantEnv) };
		case 'DoWhileStmt':
			return { ...stmt, body: optimizeStmt(stmt.body, opts, scope.child(), functionReturnTypes, constantEnv), condition: optimizeCondition(stmt.condition, opts, scope, functionReturnTypes, constantEnv) };
		case 'ForStmt':
			return {
				...stmt,
				init: stmt.init ? optimizeExpr(stmt.init, opts, scope, functionReturnTypes, constantEnv) : undefined,
				condition: stmt.condition ? optimizeCondition(stmt.condition, opts, scope, functionReturnTypes, constantEnv) : undefined,
				update: stmt.update ? optimizeStatementExpr(optimizeExpr(stmt.update, opts, scope, functionReturnTypes, constantEnv), opts, scope, functionReturnTypes) : undefined,
				body: optimizeStmt(stmt.body, opts, scope.child(), functionReturnTypes, constantEnv),
			};
		case 'BlockStmt':
			return { ...stmt, statements: optimizeBlockStatements(stmt.statements, opts, scope.child(), functionReturnTypes, constantEnv) };
		case 'JumpStmt':
			return { ...stmt, target: optimizeExpr(stmt.target, opts, scope, functionReturnTypes, constantEnv) };
		default:
			AssertNever(stmt);
			return stmt;
	}
}

function optimizeCondition(expr: Expr, opts: ResolvedOptimizeOptions, scope: TypeScope, functionReturnTypes: ReadonlyMap<string, SimpleType>, constantEnv: Env): Expr {
	const optimized = optimizeBooleanShape(optimizeExpr(expr, opts, scope, functionReturnTypes, constantEnv), scope, functionReturnTypes);
	return opts.integerPeepholes ? optimizeIntegerConditionPeephole(optimized, scope, functionReturnTypes) : optimized;
}

function optimizeStatementExpr(expr: Expr, opts: ResolvedOptimizeOptions, scope: TypeScope, functionReturnTypes: ReadonlyMap<string, SimpleType>): Expr {
	return opts.integerPeepholes ? optimizeIntegerStatementPeephole(expr, scope, functionReturnTypes) : expr;
}

function optimizeBlockStatements(statements: Stmt[], opts: ResolvedOptimizeOptions, scope: TypeScope, functionReturnTypes: ReadonlyMap<string, SimpleType>, constantEnv: Env): Stmt[] {
	return statements.map(child => optimizeStmt(child, opts, scope, functionReturnTypes, constantEnv)).filter(child => child.kind !== 'EmptyStmt');
}

function optimizeExpr(expr: Expr, opts: ResolvedOptimizeOptions, scope: TypeScope, functionReturnTypes: ReadonlyMap<string, SimpleType>, constantEnv: Env, context: { preserveStringProducer?: boolean; preserveListLiteralShape?: boolean } = {}): Expr {
	let next: Expr;
	switch (expr.kind) {
		case 'ErrorExpr':
		case 'StringLiteral':
		case 'NumberLiteral':
		case 'Identifier':
			next = expr;
			break;
		case 'Call':
			next = optimizeCall(expr, opts, scope, functionReturnTypes, constantEnv);
			break;
		case 'Member':
			next = { ...expr, object: optimizeExpr(expr.object, opts, scope, functionReturnTypes, constantEnv) };
			break;
		case 'Unary':
			next = { ...expr, argument: optimizeExpr(expr.argument, opts, scope, functionReturnTypes, constantEnv) };
			break;
		case 'Binary':
			if (!opts.foldStringConcats && expr.op === '+' && (hasStringProducingExpr(expr.left) || hasStringProducingExpr(expr.right)) && !isStringLiteralConcat(expr)) {
				next = {
					...expr,
					left: optimizeExpr(expr.left, opts, scope, functionReturnTypes, constantEnv, { preserveStringProducer: true }),
					right: optimizeExpr(expr.right, opts, scope, functionReturnTypes, constantEnv, { preserveStringProducer: true }),
				};
			} else {
				next = { ...expr, left: optimizeExpr(expr.left, opts, scope, functionReturnTypes, constantEnv), right: optimizeExpr(expr.right, opts, scope, functionReturnTypes, constantEnv) };
			}
			if (opts.bitwiseBooleanOps) next = optimizeBitwiseBooleanOp(next, scope, functionReturnTypes);
			if (opts.listAdd) next = optimizeListCompoundAdd(next, scope, functionReturnTypes);
			if (opts.integerPeepholes) next = optimizeIntegerExprPeephole(next, scope, functionReturnTypes);
			break;
		case 'Cast': {
			const argument = optimizeExpr(expr.argument, opts, scope, functionReturnTypes, constantEnv);
			next = opts.dropNoOpCasts && inferExprTypeFromAst(argument, scope.view(), new Map(functionReturnTypes)) === expr.type
				? argument
				: { ...expr, argument };
			break;
		}
		case 'Paren':
			next = optimizeExpr(expr.expression, opts, scope, functionReturnTypes, constantEnv);
			break;
		case 'ListLiteral':
			next = { ...expr, elements: expr.elements.map(element => optimizeExpr(element, opts, scope, functionReturnTypes, constantEnv, context)) };
			if (opts.listAdd && !context.preserveListLiteralShape) next = listLiteralToAdd(next, scope, functionReturnTypes);
			break;
		case 'VectorLiteral':
			next = { ...expr, elements: expr.elements.map(element => optimizeExpr(element, opts, scope, functionReturnTypes, constantEnv)) as Expr[] as ExprTuple<typeof expr.elements> };
			break;
		default:
			AssertNever(expr);
			next = expr;
			break;
	}

	if (!opts.constantFold || !isFoldCandidateExpr(next) || !mayFoldWholeExpr(next, opts)) return next;
	if (context.preserveStringProducer && isStringProducingExpr(next) && !needsStringCastMaterialization(next)) return next;
	const value = evalExpr(next, constantEnv, { allowRuntimeCalls: true });
	return valueToExpr(value, next) ?? next;
}

type ExprTuple<T> = T extends [Expr, Expr, Expr, Expr] ? [Expr, Expr, Expr, Expr] : [Expr, Expr, Expr];

function needsStringCastMaterialization(expr: Expr): boolean {
	return expr.kind === 'Cast' && expr.type === 'string' && (expr.argument.kind === 'Cast' || expr.argument.kind === 'VectorLiteral');
}

function optimizeCall(expr: Extract<Expr, { kind: 'Call' }>, opts: ResolvedOptimizeOptions, scope: TypeScope, functionReturnTypes: ReadonlyMap<string, SimpleType>, constantEnv: Env): Expr {
	const args = expr.args.map(arg => optimizeExpr(arg, opts, scope, functionReturnTypes, constantEnv));
	if (expr.callee.kind !== 'Identifier') return { ...expr, callee: expr.callee, args };
	if (expr.callee.name === 'llGetListLength' && args.length === 1) {
		const arg = args[0]!;
		if (inferExprTypeFromAst(arg, scope.view(), new Map(functionReturnTypes)) === 'list') {
			return { ...expr, kind: 'Binary', op: '!=', left: arg, right: { ...expr, kind: 'ListLiteral', elements: [] } };
		}
	}
	if (expr.callee.name === 'llDumpList2String' && args.length === 2) {
		const list = args[0]!;
		const separator = args[1]!;
		if (isEmptyStringLiteral(separator)) return { ...expr, kind: 'Cast', type: 'string', argument: list };
		if (list.kind === 'ListLiteral' && list.elements.length === 1 && isSideEffectFreeInlineArg(separator)) {
			const element = list.elements[0]!;
			if (inferExprTypeFromAst(element, scope.view(), new Map(functionReturnTypes)) !== 'list') {
				return { ...expr, kind: 'Cast', type: 'string', argument: element };
			}
		}
	}
	if (expr.callee.name === 'llDeleteSubList' && args.length === 3 && isZeroLiteral(args[1]!) && isMinusOne(args[2]!) && isSideEffectFreeInlineArg(args[0]!)) {
		return { ...expr, kind: 'ListLiteral', elements: [] };
	}
	if (expr.callee.name === 'llListReplaceList' && args.length === 4 && args[1]?.kind === 'ListLiteral' && args[1].elements.length === 0 && isZeroLiteral(args[2]!) && isMinusOne(args[3]!) && isSideEffectFreeInlineArg(args[0]!)) {
		return { ...expr, kind: 'ListLiteral', elements: [] };
	}
	return { ...expr, callee: expr.callee, args };
}

function optimizeListCompoundAdd(expr: Expr, scope: TypeScope, functionReturnTypes: ReadonlyMap<string, SimpleType>): Expr {
	if (expr.kind !== 'Binary' || expr.op !== '+=' || expr.left.kind !== 'Identifier') return expr;
	if (inferExprTypeFromAst(expr.left, scope.view(), new Map(functionReturnTypes)) !== 'list') return expr;
	return {
		...expr,
		op: '=',
		right: prependListAdd(expr.left, expr.right),
	};
}

function prependListAdd(left: Expr, right: Expr): Expr {
	const stripped = stripLeadingListCast(right);
	if (stripped.kind === 'Binary' && stripped.op === '+') {
		return { ...stripped, left: prependListAdd(left, stripped.left) };
	}
	return {
		...right,
		kind: 'Binary',
		op: '+',
		left,
		right: stripped,
	};
}

function stripLeadingListCast(expr: Expr): Expr {
	if (expr.kind === 'Cast' && expr.type === 'list') return expr.argument;
	if (expr.kind === 'Binary' && expr.op === '+') return { ...expr, left: stripLeadingListCast(expr.left) };
	return expr;
}

function optimizeBitwiseBooleanOp(expr: Expr, scope: TypeScope, functionReturnTypes: ReadonlyMap<string, SimpleType>): Expr {
	if (expr.kind !== 'Binary' || (expr.op !== '&&' && expr.op !== '||')) return expr;
	if (!isBooleanValueExpr(expr.left, scope, functionReturnTypes) || !isBooleanValueExpr(expr.right, scope, functionReturnTypes)) return expr;
	return { ...expr, op: expr.op === '&&' ? '&' : '|' };
}

function optimizeIntegerExprPeephole(expr: Expr, scope: TypeScope, functionReturnTypes: ReadonlyMap<string, SimpleType>): Expr {
	if (expr.kind !== 'Binary' || (expr.op !== '+' && expr.op !== '-')) return expr;
	const leftInteger = inferExprTypeFromAst(expr.left, scope.view(), new Map(functionReturnTypes)) === 'integer';
	const rightInteger = inferExprTypeFromAst(expr.right, scope.view(), new Map(functionReturnTypes)) === 'integer';
	if (leftInteger && rightInteger) {
		const linear = optimizeLinearIntegerExpr(expr, scope, functionReturnTypes);
		if (linear) return linear;
	}
	if (expr.op === '+' && leftInteger && rightInteger && isIntegerLiteralValue(expr.right, 1)) return plusOne(expr.left);
	if (expr.op === '+' && leftInteger && rightInteger && isIntegerLiteralValue(expr.left, 1)) return plusOne(expr.right);
	if (expr.op === '-' && leftInteger && rightInteger && isIntegerLiteralValue(expr.right, 1)) return minusOne(expr.left);
	return expr;
}

interface LinearIntegerTerm {
	coefficient: number;
	identifier: Extract<Expr, { kind: 'Identifier' }>;
}

interface LinearIntegerExpr {
	constant: number;
	term?: LinearIntegerTerm;
}

function optimizeLinearIntegerExpr(expr: Expr, scope: TypeScope, functionReturnTypes: ReadonlyMap<string, SimpleType>): Expr | null {
	const linear = collectLinearIntegerExpr(expr, scope, functionReturnTypes, 1);
	if (!linear?.term) return null;
	if (linear.term.coefficient === 1 && linear.constant === 1) return null;
	if (linear.term.coefficient === 1 && linear.constant === -1) return null;
	const next = renderLinearIntegerExpr(expr, linear);
	return emitExpr(next).length < emitExpr(expr).length ? next : null;
}

function collectLinearIntegerExpr(expr: Expr, scope: TypeScope, functionReturnTypes: ReadonlyMap<string, SimpleType>, sign: number): LinearIntegerExpr | null {
	if (expr.kind === 'Paren') return collectLinearIntegerExpr(expr.expression, scope, functionReturnTypes, sign);
	if (expr.kind === 'NumberLiteral') {
		const value = integerLiteralNumber(expr);
		return value === null ? null : { constant: sign * value };
	}
	const incremented = incrementTargetExpr(expr);
	if (incremented) {
		const inner = collectLinearIntegerExpr(incremented, scope, functionReturnTypes, sign);
		return inner ? mergeLinearIntegerExpr(inner, { constant: sign }) : null;
	}
	const decremented = decrementTargetExpr(expr);
	if (decremented) {
		const inner = collectLinearIntegerExpr(decremented, scope, functionReturnTypes, sign);
		return inner ? mergeLinearIntegerExpr(inner, { constant: -sign }) : null;
	}
	if (expr.kind === 'Unary' && expr.op === '-') return collectLinearIntegerExpr(expr.argument, scope, functionReturnTypes, -sign);
	if (expr.kind === 'Identifier') {
		if (!isIntegerExpr(expr, scope, functionReturnTypes)) return null;
		return { constant: 0, term: { coefficient: sign, identifier: expr } };
	}
	if (expr.kind === 'Binary' && expr.op === '*') {
		return collectLinearIntegerProduct(expr, scope, functionReturnTypes, sign);
	}
	if (expr.kind !== 'Binary' || (expr.op !== '+' && expr.op !== '-')) return null;
	const left = collectLinearIntegerExpr(expr.left, scope, functionReturnTypes, sign);
	const right = collectLinearIntegerExpr(expr.right, scope, functionReturnTypes, expr.op === '+' ? sign : -sign);
	if (!left || !right) return null;
	return mergeLinearIntegerExpr(left, right);
}

function collectLinearIntegerProduct(expr: Extract<Expr, { kind: 'Binary' }>, scope: TypeScope, functionReturnTypes: ReadonlyMap<string, SimpleType>, sign: number): LinearIntegerExpr | null {
	const leftLiteral = integerLiteralNumber(expr.left);
	const rightLiteral = integerLiteralNumber(expr.right);
	if (leftLiteral !== null && rightLiteral === null) return scaleLinearIntegerTerm(expr.right, scope, functionReturnTypes, sign * leftLiteral);
	if (rightLiteral !== null && leftLiteral === null) return scaleLinearIntegerTerm(expr.left, scope, functionReturnTypes, sign * rightLiteral);
	return null;
}

function scaleLinearIntegerTerm(expr: Expr, scope: TypeScope, functionReturnTypes: ReadonlyMap<string, SimpleType>, coefficient: number): LinearIntegerExpr | null {
	const term = collectLinearIntegerExpr(expr, scope, functionReturnTypes, 1);
	if (!term || term.constant !== 0 || !term.term) return null;
	return {
		constant: 0,
		term: { ...term.term, coefficient: term.term.coefficient * coefficient },
	};
}

function mergeLinearIntegerExpr(left: LinearIntegerExpr, right: LinearIntegerExpr): LinearIntegerExpr | null {
	if (left.term && right.term && left.term.identifier.name !== right.term.identifier.name) return null;
	const term = left.term ?? right.term;
	const coefficient = (left.term?.coefficient ?? 0) + (right.term?.coefficient ?? 0);
	return {
		constant: left.constant + right.constant,
		term: term && coefficient !== 0 ? { ...term, coefficient } : undefined,
	};
}

function renderLinearIntegerExpr(source: Expr, linear: LinearIntegerExpr): Expr {
	const parts: Array<{ sign: 1 | -1; expr: Expr }> = [];
	if (linear.term && linear.term.coefficient !== 0) {
		parts.push({ sign: linear.term.coefficient < 0 ? -1 : 1, expr: renderLinearTerm(source, linear.term) });
	}
	if (linear.constant !== 0) {
		parts.push({ sign: linear.constant < 0 ? -1 : 1, expr: numberLiteral(source, Math.abs(linear.constant)) });
	}
	if (parts.length === 0) return numberLiteral(source, 0);
	const first = parts[0]!;
	let out = first.sign < 0 ? { ...source, kind: 'Unary', op: '-', argument: first.expr } as Expr : first.expr;
	for (const part of parts.slice(1)) {
		out = { ...source, kind: 'Binary', op: part.sign < 0 ? '-' : '+', left: out, right: part.expr };
	}
	return out;
}

function renderLinearTerm(source: Expr, term: LinearIntegerTerm): Expr {
	const coefficient = Math.abs(term.coefficient);
	if (coefficient === 1) return term.identifier;
	return {
		...source,
		kind: 'Binary',
		op: '*',
		left: numberLiteral(source, coefficient),
		right: term.identifier,
	};
}

function integerLiteralNumber(expr: Expr): number | null {
	if (expr.kind === 'Paren') return integerLiteralNumber(expr.expression);
	if (expr.kind !== 'NumberLiteral') return null;
	const value = Number(expr.raw);
	return Number.isInteger(value) ? value : null;
}

function numberLiteral(source: Expr, value: number): Expr {
	return { ...source, kind: 'NumberLiteral', raw: String(value) };
}

function optimizeIntegerConditionPeephole(expr: Expr, scope: TypeScope, functionReturnTypes: ReadonlyMap<string, SimpleType>): Expr {
	if (expr.kind !== 'Binary' || (expr.op !== '!=' && expr.op !== '==')) return expr;
	if (!isIntegerExpr(expr.left, scope, functionReturnTypes) || !isIntegerExpr(expr.right, scope, functionReturnTypes)) return expr;
	const leftZero = isIntegerLiteralValue(expr.left, 0);
	const rightZero = isIntegerLiteralValue(expr.right, 0);
	if (leftZero || rightZero) {
		const value = leftZero ? expr.right : expr.left;
		return expr.op === '!=' ? value : { ...expr, kind: 'Unary', op: '!', argument: value };
	}
	const xor: Expr = { ...expr, kind: 'Binary', op: '^', left: expr.left, right: expr.right };
	return expr.op === '!=' ? xor : { ...expr, kind: 'Unary', op: '!', argument: xor };
}

function optimizeIntegerStatementPeephole(expr: Expr, scope: TypeScope, functionReturnTypes: ReadonlyMap<string, SimpleType>): Expr {
	if (expr.kind !== 'Binary' || expr.left.kind !== 'Identifier') return expr;
	if (!isIntegerExpr(expr.left, scope, functionReturnTypes)) return expr;
	if ((expr.op === '+=' || expr.op === '-=') && isIntegerLiteralValue(expr.right, 1)) {
		return { ...expr, kind: 'Unary', op: expr.op === '+=' ? '++' : '--', argument: expr.left };
	}
	if (expr.op !== '=') return expr;
	const incremented = incrementTargetName(expr.right);
	if (incremented && incremented === expr.left.name) return { ...expr, kind: 'Unary', op: '++', argument: expr.left };
	const decremented = decrementTargetName(expr.right);
	if (decremented && decremented === expr.left.name) return { ...expr, kind: 'Unary', op: '--', argument: expr.left };
	return expr;
}

function incrementTargetName(expr: Expr): string | null {
	const target = incrementTargetExpr(expr);
	return target ? identifierName(target) : null;
}

function incrementTargetExpr(expr: Expr): Expr | null {
	if (expr.kind === 'Paren') return incrementTargetExpr(expr.expression);
	if (expr.kind === 'Unary' && expr.op === '-' && expr.argument.kind === 'Unary' && expr.argument.op === '~') {
		return expr.argument.argument;
	}
	return null;
}

function decrementTargetName(expr: Expr): string | null {
	const target = decrementTargetExpr(expr);
	return target ? identifierName(target) : null;
}

function decrementTargetExpr(expr: Expr): Expr | null {
	if (expr.kind === 'Paren') return decrementTargetExpr(expr.expression);
	if (expr.kind === 'Unary' && expr.op === '~' && expr.argument.kind === 'Unary' && expr.argument.op === '-') {
		return expr.argument.argument;
	}
	return null;
}

function identifierName(expr: Expr): string | null {
	return expr.kind === 'Identifier' ? expr.name : null;
}

function plusOne(expr: Expr): Expr {
	return { ...expr, kind: 'Unary', op: '-', argument: { ...expr, kind: 'Unary', op: '~', argument: expr } };
}

function minusOne(expr: Expr): Expr {
	return { ...expr, kind: 'Unary', op: '~', argument: { ...expr, kind: 'Unary', op: '-', argument: expr } };
}

function isIntegerExpr(expr: Expr, scope: TypeScope, functionReturnTypes: ReadonlyMap<string, SimpleType>): boolean {
	return inferExprTypeFromAst(expr, scope.view(), new Map(functionReturnTypes)) === 'integer';
}

function isIntegerLiteralValue(expr: Expr, value: number): boolean {
	if (expr.kind === 'Paren') return isIntegerLiteralValue(expr.expression, value);
	if (expr.kind === 'NumberLiteral') return Number.isInteger(Number(expr.raw)) && Number(expr.raw) === value;
	if (expr.kind === 'Unary' && expr.op === '-') return isIntegerLiteralValue(expr.argument, -value);
	return false;
}

function isBooleanValueExpr(expr: Expr, scope: TypeScope, functionReturnTypes: ReadonlyMap<string, SimpleType>): boolean {
	switch (expr.kind) {
		case 'Paren':
			return isBooleanValueExpr(expr.expression, scope, functionReturnTypes);
		case 'Unary':
			return expr.op === '!';
		case 'Binary':
			if (expr.op === '&&' || expr.op === '||' || expr.op === '&' || expr.op === '|') return isBooleanValueExpr(expr.left, scope, functionReturnTypes) && isBooleanValueExpr(expr.right, scope, functionReturnTypes);
			if (expr.op !== '==' && expr.op !== '!=' && expr.op !== '<' && expr.op !== '<=' && expr.op !== '>' && expr.op !== '>=') return false;
			return inferExprTypeFromAst(expr.left, scope.view(), new Map(functionReturnTypes)) !== 'list'
				&& inferExprTypeFromAst(expr.right, scope.view(), new Map(functionReturnTypes)) !== 'list';
		case 'NumberLiteral': {
			const value = Number(expr.raw);
			return value === 0 || value === 1;
		}
		default:
			return false;
	}
}

function listLiteralToAdd(expr: Expr, scope: TypeScope, functionReturnTypes: ReadonlyMap<string, SimpleType>): Expr {
	if (expr.kind !== 'ListLiteral' || expr.elements.length === 0) return expr;
	if (expr.elements.some(element => inferExprTypeFromAst(element, scope.view(), new Map(functionReturnTypes)) === 'list')) return expr;
	let out: Expr = { ...expr, kind: 'Cast', type: 'list', argument: expr.elements[0]! };
	for (const element of expr.elements.slice(1)) {
		out = { ...expr, kind: 'Binary', op: '+', left: out, right: element };
	}
	return out;
}

function optimizeBooleanShape(expr: Expr, scope: TypeScope, functionReturnTypes: ReadonlyMap<string, SimpleType>): Expr {
	const listLengthArg = listLengthCallArg(expr, scope, functionReturnTypes);
	if (listLengthArg) {
		return { ...expr, kind: 'Binary', op: '!=', left: listLengthArg, right: { ...expr, kind: 'ListLiteral', elements: [] } };
	}
	if (expr.kind !== 'Binary' || (expr.op !== '!=' && expr.op !== '==')) return expr;
	const leftMinusOne = isMinusOne(expr.left);
	const rightMinusOne = isMinusOne(expr.right);
	if (leftMinusOne === rightMinusOne) return expr;
	const value = leftMinusOne ? expr.right : expr.left;
	if (inferExprTypeFromAst(value, scope.view(), new Map(functionReturnTypes)) !== 'integer') return expr;
	const bitNot: Expr = { ...expr, kind: 'Unary', op: '~', argument: value };
	return expr.op === '!=' ? bitNot : { ...expr, kind: 'Unary', op: '!', argument: bitNot };
}

function listLengthCallArg(expr: Expr, scope: TypeScope, functionReturnTypes: ReadonlyMap<string, SimpleType>): Expr | null {
	if (expr.kind !== 'Call' || expr.callee.kind !== 'Identifier' || expr.callee.name !== 'llGetListLength' || expr.args.length !== 1) return null;
	const arg = expr.args[0]!;
	return inferExprTypeFromAst(arg, scope.view(), new Map(functionReturnTypes)) === 'list' ? arg : null;
}

function isMinusOne(expr: Expr): boolean {
	if (expr.kind === 'NumberLiteral') return Number(expr.raw) === -1;
	if (expr.kind === 'Unary' && expr.op === '-' && expr.argument.kind === 'NumberLiteral') return Number(expr.argument.raw) === 1;
	if (expr.kind === 'Paren') return isMinusOne(expr.expression);
	return false;
}

function isZeroLiteral(expr: Expr): boolean {
	if (expr.kind === 'NumberLiteral') return Number(expr.raw) === 0;
	if (expr.kind === 'Paren') return isZeroLiteral(expr.expression);
	return false;
}

function isEmptyStringLiteral(expr: Expr): boolean {
	if (expr.kind === 'StringLiteral') return expr.value === '';
	if (expr.kind === 'Paren') return isEmptyStringLiteral(expr.expression);
	return false;
}

function mayFoldWholeExpr(expr: Expr, opts: ResolvedOptimizeOptions): boolean {
	if (!opts.foldStringConcats && expr.kind === 'Binary' && expr.op === '+' && (hasStringProducingExpr(expr.left) || hasStringProducingExpr(expr.right)) && !isStringLiteralConcat(expr)) return false;
	return expr.kind !== 'ListLiteral';
}

function isStringLiteralConcat(expr: Expr): boolean {
	return expr.kind === 'Binary'
		&& expr.op === '+'
		&& expr.left.kind === 'StringLiteral'
		&& expr.right.kind === 'StringLiteral';
}

function hasStringProducingExpr(expr: Expr): boolean {
	switch (expr.kind) {
		case 'StringLiteral':
			return true;
		case 'Paren':
			return hasStringProducingExpr(expr.expression);
		case 'Unary':
			return hasStringProducingExpr(expr.argument);
		case 'Cast':
			return expr.type === 'string' || expr.type === 'key' || hasStringProducingExpr(expr.argument);
		case 'Binary':
			return hasStringProducingExpr(expr.left) || hasStringProducingExpr(expr.right);
		case 'Call':
			return hasStringProducingExpr(expr.callee) || expr.args.some(hasStringProducingExpr);
		case 'Member':
			return hasStringProducingExpr(expr.object);
		case 'ListLiteral':
			return expr.elements.some(hasStringProducingExpr);
		case 'VectorLiteral':
			return expr.elements.some(hasStringProducingExpr);
		case 'ErrorExpr':
		case 'NumberLiteral':
		case 'Identifier':
			return false;
		default:
			AssertNever(expr);
			return false;
	}
}

function isStringProducingExpr(expr: Expr): boolean {
	return expr.kind === 'StringLiteral' || (expr.kind === 'Cast' && (expr.type === 'string' || expr.type === 'key'));
}

function isFoldCandidateExpr(expr: Expr): boolean {
	switch (expr.kind) {
		case 'ErrorExpr':
			return false;
		case 'StringLiteral':
		case 'NumberLiteral':
		case 'Identifier':
			return true;
		case 'Member':
			return isFoldCandidateExpr(expr.object);
		case 'Unary':
			return expr.op !== '++' && expr.op !== '--' && isFoldCandidateExpr(expr.argument);
		case 'Binary':
			return !isAssignmentOp(expr.op) && isFoldCandidateExpr(expr.left) && isFoldCandidateExpr(expr.right);
		case 'Cast':
		case 'Paren':
			return isFoldCandidateExpr(expr.kind === 'Cast' ? expr.argument : expr.expression);
		case 'ListLiteral':
			return expr.elements.every(isFoldCandidateExpr);
		case 'VectorLiteral':
			return expr.elements.every(isFoldCandidateExpr);
		case 'Call':
			return expr.callee.kind === 'Identifier' && expr.args.every(isFoldCandidateExpr);
		default:
			AssertNever(expr);
			return false;
	}
}

function isAssignmentOp(op: string): boolean {
	return op === '=' || op === '+=' || op === '-=' || op === '*=' || op === '/=' || op === '%=';
}

function collectPureFunctions(script: Script): Set<string> {
	const pure = new Set<string>();
	let changed = true;
	while (changed) {
		changed = false;
		for (const [name, fn] of script.functions) {
			if (pure.has(name) || !fn.returnType || fn.returnType === 'void') continue;
			if (isPureFunction(fn, pure)) {
				pure.add(name);
				changed = true;
			}
		}
	}
	return pure;
}

function isPureFunction(fn: FnNode, pureFunctions: ReadonlySet<string>): boolean {
	const locals = new Set(fn.parameters.keys());
	return isPureStmt(fn.body, pureFunctions, locals);
}

function isPureStmt(stmt: Stmt, pureFunctions: ReadonlySet<string>, locals: Set<string>): boolean {
	switch (stmt.kind) {
		case 'EmptyStmt':
		case 'LabelStmt':
			return true;
		case 'ExprStmt':
			return isPureFunctionExpr(stmt.expression, pureFunctions, locals);
		case 'VarDecl':
			if (stmt.initializer && !isPureFunctionExpr(stmt.initializer, pureFunctions, locals)) return false;
			locals.add(stmt.name);
			return true;
		case 'ReturnStmt':
			return !stmt.expression || isPureFunctionExpr(stmt.expression, pureFunctions, locals);
		case 'IfStmt':
			return isPureFunctionExpr(stmt.condition, pureFunctions, locals)
				&& isPureStmt(stmt.then, pureFunctions, new Set(locals))
				&& (!stmt.else || isPureStmt(stmt.else, pureFunctions, new Set(locals)));
		case 'WhileStmt':
			return isPureFunctionExpr(stmt.condition, pureFunctions, locals) && isPureStmt(stmt.body, pureFunctions, new Set(locals));
		case 'DoWhileStmt':
			return isPureStmt(stmt.body, pureFunctions, new Set(locals)) && isPureFunctionExpr(stmt.condition, pureFunctions, locals);
		case 'ForStmt':
			return (!stmt.init || isPureFunctionExpr(stmt.init, pureFunctions, locals))
				&& (!stmt.condition || isPureFunctionExpr(stmt.condition, pureFunctions, locals))
				&& (!stmt.update || isPureFunctionExpr(stmt.update, pureFunctions, locals))
				&& isPureStmt(stmt.body, pureFunctions, new Set(locals));
		case 'BlockStmt': {
			const blockLocals = new Set(locals);
			return stmt.statements.every(child => isPureStmt(child, pureFunctions, blockLocals));
		}
		case 'ErrorStmt':
		case 'JumpStmt':
		case 'StateChangeStmt':
			return false;
		default:
			AssertNever(stmt);
			return false;
	}
}

function isPureFunctionExpr(expr: Expr, pureFunctions: ReadonlySet<string>, locals: ReadonlySet<string>): boolean {
	switch (expr.kind) {
		case 'ErrorExpr':
			return false;
		case 'StringLiteral':
		case 'NumberLiteral':
		case 'Identifier':
			return true;
		case 'Member':
			return isPureFunctionExpr(expr.object, pureFunctions, locals);
		case 'Unary':
			return expr.op !== '++' && expr.op !== '--' && isPureFunctionExpr(expr.argument, pureFunctions, locals);
		case 'Binary':
			if (expr.op === '=') return expr.left.kind === 'Identifier' && locals.has(expr.left.name) && isPureFunctionExpr(expr.right, pureFunctions, locals);
			return !isAssignmentOp(expr.op) && isPureFunctionExpr(expr.left, pureFunctions, locals) && isPureFunctionExpr(expr.right, pureFunctions, locals);
		case 'Cast':
		case 'Paren':
			return isPureFunctionExpr(expr.kind === 'Cast' ? expr.argument : expr.expression, pureFunctions, locals);
		case 'ListLiteral':
			return expr.elements.every(element => isPureFunctionExpr(element, pureFunctions, locals));
		case 'VectorLiteral':
			return expr.elements.every(element => isPureFunctionExpr(element, pureFunctions, locals));
		case 'Call':
			return expr.callee.kind === 'Identifier'
				&& (isImplementedRuntimeFunction(expr.callee.name) || pureFunctions.has(expr.callee.name))
				&& expr.args.every(arg => isPureFunctionExpr(arg, pureFunctions, locals));
		default:
			AssertNever(expr);
			return false;
	}
}

function isImplementedRuntimeFunction(name: string): boolean {
	return name.startsWith('ll') && typeof (runtime as Record<string, unknown>)[name] === 'function';
}

type InlineCandidate = {
	name: string;
	params: string[];
	expression: Expr;
};

function inlineExpressionFunctionsByMeasure(script: Script): Script {
	let current = script;
	let changed = true;
	while (changed) {
		changed = false;
		for (const candidate of collectInlineCandidates(current)) {
			const beforeUsed = estimateMonoUsed(current);
			const inlined = removeUnusedFunctions(inlineSingleFunction(current, candidate));
			const afterUsed = estimateMonoUsed(inlined);
			if (afterUsed < beforeUsed) {
				current = inlined;
				changed = true;
				break;
			}
		}
	}
	return current;
}

function inlineSingleUseStatementFunctionsByMeasure(script: Script): Script {
	let current = script;
	let changed = true;
	while (changed) {
		changed = false;
		for (const candidate of collectStatementInlineCandidates(current)) {
			const beforeUsed = estimateMonoUsed(current);
			const inlined = removeUnusedFunctions(inlineSingleStatementFunction(current, candidate));
			const afterUsed = estimateMonoUsed(inlined);
			if (afterUsed < beforeUsed) {
				current = inlined;
				changed = true;
				break;
			}
		}
	}
	return current;
}

interface SpecializationCandidate {
	sourceName: string;
	targetName: string;
	fixed: Map<number, Expr>;
}

function specializeConstantArgumentFunctionsByMeasure(script: Script): Script {
	let current = script;
	let changed = true;
	while (changed) {
		changed = false;
		for (const candidate of collectSpecializationCandidates(current)) {
			const beforeUsed = estimateMonoUsed(current);
			const specialized = removeUnusedFunctions(foldConstantControlFlow(applyFunctionSpecialization(current, candidate)));
			const afterUsed = estimateMonoUsed(specialized);
			if (afterUsed < beforeUsed || emitScript(specialized).length < emitScript(current).length) {
				current = specialized;
				changed = true;
				break;
			}
		}
	}
	return current;
}

function estimateMonoUsed(script: Script): number {
	return measureAst(script).estimatedMonoUsedMemory;
}

function collectInlineCandidates(script: Script): InlineCandidate[] {
	const callCounts = collectFunctionCallCounts(script);
	const candidates: InlineCandidate[] = [];
	for (const [name, fn] of script.functions) {
		if ((callCounts.get(name) ?? 0) < 1) continue;
		const expression = singleReturnExpression(fn);
		if (!expression || exprCallsFunction(expression, name)) continue;
		const params = [...fn.parameters.keys()];
		const paramSet = new Set(params);
		if (!identifiersAreOnlyParams(expression, paramSet)) continue;
		if (maxParamUseCount(expression, paramSet) > 1) continue;
		candidates.push({ name, params, expression });
	}
	return candidates;
}

type StatementInlineCandidate = {
	name: string;
	fn: FnNode;
	endLabel: string;
};

function collectStatementInlineCandidates(script: Script): StatementInlineCandidate[] {
	const callCounts = collectFunctionCallCounts(script);
	const labels = collectLabelNames(script);
	const candidates: StatementInlineCandidate[] = [];
	for (const [name, fn] of script.functions) {
		if (callCounts.get(name) !== 1) continue;
		if (fn.returnType && fn.returnType !== 'void') continue;
		if (hasInlineHostileFlow(fn.body)) continue;
		if (countDirectStatementCalls(script, name) !== 1) continue;
		candidates.push({ name, fn, endLabel: uniqueGeneratedName(labels, `J_inline_${name}`) });
	}
	return candidates;
}

function collectSpecializationCandidates(script: Script): SpecializationCandidate[] {
	const used = new Set([...script.functions.keys(), ...script.globals.keys(), ...script.states.keys()]);
	const seen = new Set<string>();
	const candidates: SpecializationCandidate[] = [];
	visitScriptCallExprs(script, call => {
		if (call.callee.kind !== 'Identifier') return;
		const fn = script.functions.get(call.callee.name);
		if (!fn || stmtCallsFunction(fn.body, fn.name)) return;
		const params = [...fn.parameters.keys()];
		if (call.args.length !== params.length) return;
		const fixed = new Map<number, Expr>();
		call.args.forEach((arg, index) => {
			if (isSpecializableConstantArg(arg)) fixed.set(index, arg);
		});
		if (!fixed.size || fixed.size === params.length) return;
		const signature = `${fn.name}:${[...fixed].map(([index, expr]) => `${index}=${emitExpr(expr)}`).join(',')}`;
		if (seen.has(signature)) return;
		seen.add(signature);
		candidates.push({
			sourceName: fn.name,
			targetName: uniqueGeneratedName(used, `__spec_${fn.name}`),
			fixed,
		});
	});
	return candidates;
}

function isSpecializableConstantArg(expr: Expr): boolean {
	if (expr.kind === 'Paren') return isSpecializableConstantArg(expr.expression);
	if (expr.kind === 'StringLiteral' || expr.kind === 'NumberLiteral') return true;
	if (expr.kind === 'Unary') return (expr.op === '+' || expr.op === '-' || expr.op === '!' || expr.op === '~') && isSpecializableConstantArg(expr.argument);
	if (expr.kind === 'Cast') return isSpecializableConstantArg(expr.argument);
	if (expr.kind === 'VectorLiteral') return expr.elements.every(isSpecializableConstantArg);
	return expr.kind === 'ListLiteral' && expr.elements.length <= 4 && expr.elements.every(isSpecializableConstantArg);
}

function applyFunctionSpecialization(script: Script, candidate: SpecializationCandidate): Script {
	const source = script.functions.get(candidate.sourceName);
	if (!source) return script;
	const functions = new Map(script.functions);
	functions.set(candidate.targetName, specializeFunction(source, candidate));
	return replaceSpecializedCalls({ ...script, functions }, candidate);
}

function foldConstantControlFlow(script: Script): Script {
	const env = new Env();
	return {
		...script,
		functions: mapValues(script.functions, fn => ({ ...fn, body: foldConstantControlFlowStmt(fn.body, env) })),
		states: mapValues(script.states, state => ({
			...state,
			events: state.events.map(event => ({ ...event, body: foldConstantControlFlowStmt(event.body, env) })),
		})),
	};
}

function foldConstantControlFlowStmt(stmt: Stmt, env: Env): Stmt {
	switch (stmt.kind) {
		case 'IfStmt': {
			const thenStmt = foldConstantControlFlowStmt(stmt.then, env);
			const elseStmt = stmt.else ? foldConstantControlFlowStmt(stmt.else, env) : undefined;
			const truth = constantTruth(stmt.condition, env);
			if (truth === true) return thenStmt;
			if (truth === false) return elseStmt ?? { ...stmt, kind: 'EmptyStmt' };
			return { ...stmt, then: thenStmt, else: elseStmt };
		}
		case 'WhileStmt':
			return { ...stmt, body: foldConstantControlFlowStmt(stmt.body, env) };
		case 'DoWhileStmt':
			return { ...stmt, body: foldConstantControlFlowStmt(stmt.body, env) };
		case 'ForStmt':
			return { ...stmt, body: foldConstantControlFlowStmt(stmt.body, env) };
		case 'BlockStmt':
			return { ...stmt, statements: stmt.statements.map(child => foldConstantControlFlowStmt(child, env)) };
		case 'EmptyStmt':
		case 'ErrorStmt':
		case 'ExprStmt':
		case 'VarDecl':
		case 'ReturnStmt':
		case 'JumpStmt':
		case 'LabelStmt':
		case 'StateChangeStmt':
			return stmt;
		default:
			AssertNever(stmt);
			return stmt;
	}
}

function specializeFunction(fn: FnNode, candidate: SpecializationCandidate): FnNode {
	const replacements = new Map<string, Expr>();
	const parameters = new Map<string, Type>();
	let index = 0;
	for (const [name, type] of fn.parameters) {
		const fixed = candidate.fixed.get(index);
		if (fixed) replacements.set(name, fixed);
		else parameters.set(name, type);
		index++;
	}
	return {
		...fn,
		name: candidate.targetName,
		parameters,
		body: substituteParamsInStmt(fn.body, replacements),
	};
}

function replaceSpecializedCalls(script: Script, candidate: SpecializationCandidate): Script {
	return {
		...script,
		globals: mapValues(script.globals, global => ({
			...global,
			initializer: global.initializer ? replaceSpecializedCallsInExpr(global.initializer, candidate) : undefined,
		})),
		functions: mapValues(script.functions, fn => ({
			...fn,
			body: fn.name === candidate.sourceName || fn.name === candidate.targetName ? fn.body : replaceSpecializedCallsInStmt(fn.body, candidate),
		})),
		states: mapValues(script.states, state => ({
			...state,
			events: state.events.map(event => ({
				...event,
				body: replaceSpecializedCallsInStmt(event.body, candidate),
			})),
		})),
	};
}

function countDirectStatementCalls(script: Script, name: string): number {
	let count = 0;
	const visit = (stmt: Stmt): void => {
		if (stmt.kind === 'ExprStmt' && isDirectCall(stmt.expression, name)) count++;
		visitChildStatements(stmt, visit);
	};
	for (const fn of script.functions.values()) visit(fn.body);
	for (const state of script.states.values()) {
		for (const event of state.events) visit(event.body);
	}
	return count;
}

function isDirectCall(expr: Expr, name: string): expr is Extract<Expr, { kind: 'Call' }> {
	return expr.kind === 'Call' && expr.callee.kind === 'Identifier' && expr.callee.name === name;
}

function inlineSingleStatementFunction(script: Script, candidate: StatementInlineCandidate): Script {
	return {
		...script,
		functions: mapValues(script.functions, fn => ({
			...fn,
			body: fn.name === candidate.name ? fn.body : inlineStatementFunctionStmt(fn.body, candidate),
		})),
		states: mapValues(script.states, state => ({
			...state,
			events: state.events.map(event => ({
				...event,
				body: inlineStatementFunctionStmt(event.body, candidate),
			})),
		})),
	};
}

function removeUnusedFunctions(script: Script): Script {
	let current = script;
	for (let pass = 0; pass < 6; pass++) {
		const next = removeUnusedCodeOnce(current);
		if (emitScript(next) === emitScript(current)) return current;
		current = next;
	}
	return current;
}

function dropDefaultInitializers(script: Script): Script {
	return {
		...script,
		globals: mapValues(script.globals, global => ({
			...global,
			initializer: global.initializer && isDefaultInitializer(global.varType, global.initializer) ? undefined : global.initializer,
		})),
		functions: mapValues(script.functions, fn => ({
			...fn,
			body: dropDefaultInitializersStmt(fn.body),
		})),
		states: mapValues(script.states, state => ({
			...state,
			events: state.events.map(event => ({
				...event,
				body: dropDefaultInitializersStmt(event.body),
			})),
		})),
	};
}

function dropDefaultInitializersStmt(stmt: Stmt): Stmt {
	switch (stmt.kind) {
		case 'EmptyStmt':
		case 'ErrorStmt':
		case 'ExprStmt':
		case 'ReturnStmt':
		case 'JumpStmt':
		case 'LabelStmt':
		case 'StateChangeStmt':
			return stmt;
		case 'VarDecl':
			return {
				...stmt,
				initializer: stmt.initializer && isDefaultInitializer(stmt.varType, stmt.initializer) ? undefined : stmt.initializer,
			};
		case 'IfStmt':
			return {
				...stmt,
				then: dropDefaultInitializersStmt(stmt.then),
				else: stmt.else ? dropDefaultInitializersStmt(stmt.else) : undefined,
			};
		case 'WhileStmt':
			return { ...stmt, body: dropDefaultInitializersStmt(stmt.body) };
		case 'DoWhileStmt':
			return { ...stmt, body: dropDefaultInitializersStmt(stmt.body) };
		case 'ForStmt':
			return { ...stmt, body: dropDefaultInitializersStmt(stmt.body) };
		case 'BlockStmt':
			return { ...stmt, statements: stmt.statements.map(dropDefaultInitializersStmt) };
		default:
			AssertNever(stmt);
			return stmt;
	}
}

function isDefaultInitializer(type: Type, expr: Expr): boolean {
	if (expr.kind === 'Paren') return isDefaultInitializer(type, expr.expression);
	switch (type) {
		case 'integer':
			return isNumericZero(expr);
		case 'float':
			return isNumericZero(expr);
		case 'string':
			return expr.kind === 'StringLiteral' && expr.value === '';
		case 'key':
			return isNullKeyInitializer(expr);
		case 'list':
			return expr.kind === 'ListLiteral' && expr.elements.length === 0;
		case 'vector':
			return isVectorInitializer(expr, [0, 0, 0]);
		case 'rotation':
			return isVectorInitializer(expr, [0, 0, 0, 1]);
		default:
			AssertNever(type);
			return false;
	}
}

function isNumericZero(expr: Expr): boolean {
	if (expr.kind === 'Paren') return isNumericZero(expr.expression);
	if (expr.kind === 'NumberLiteral') return Number(expr.raw) === 0;
	if (expr.kind === 'Unary' && expr.op === '-') return isNumericZero(expr.argument);
	return false;
}

function isNullKeyInitializer(expr: Expr): boolean {
	if (expr.kind === 'Paren') return isNullKeyInitializer(expr.expression);
	if (expr.kind === 'StringLiteral') return expr.value === NULL_KEY_VALUE;
	return expr.kind === 'Cast' && expr.type === 'key' && isNullKeyInitializer(expr.argument);
}

function isVectorInitializer(expr: Expr, values: readonly number[]): boolean {
	if (expr.kind === 'Paren') return isVectorInitializer(expr.expression, values);
	if (expr.kind !== 'VectorLiteral' || expr.elements.length !== values.length) return false;
	return expr.elements.every((element, index) => numericLiteralEquals(element, values[index]!));
}

function numericLiteralEquals(expr: Expr, value: number): boolean {
	if (expr.kind === 'Paren') return numericLiteralEquals(expr.expression, value);
	if (expr.kind === 'NumberLiteral') return Number(expr.raw) === value;
	if (expr.kind === 'Unary' && expr.op === '-') return numericLiteralEquals(expr.argument, -value);
	return false;
}

function removeUnusedCodeOnce(script: Script): Script {
	const withoutDeadStatements = removeDeadStatements(script);
	const withoutEvents = removeEmptyEvents(withoutDeadStatements);
	const withoutUnusedParameters = removeUnusedParameters(withoutEvents);
	const withoutFunctions = removeUnreachableFunctions(withoutUnusedParameters);
	return removeUnusedGlobals(withoutFunctions);
}

function removeUnreachableFunctions(script: Script): Script {
	const reachable = collectReachableFunctions(script);
	if (reachable.size === script.functions.size) return script;
	const functions = new Map<string, FnNode>();
	for (const [name, fn] of script.functions) {
		if (reachable.has(name)) functions.set(name, fn);
	}
	return { ...script, functions };
}

function removeDeadStatements(script: Script): Script {
	const pureFunctions = collectPureFunctions(script);
	const noOpFunctions = collectNoOpVoidFunctions(script, pureFunctions);
	return {
		...script,
		functions: mapValues(script.functions, fn => ({
			...fn,
			body: cleanupBody(cleanupStmt(fn.body, pureFunctions, noOpFunctions), fn.returnType),
		})),
		states: mapValues(script.states, state => ({
			...state,
			events: state.events.map(event => ({
				...event,
				body: cleanupBody(cleanupStmt(event.body, pureFunctions, noOpFunctions), 'void'),
			})),
		})),
	};
}

function removeEmptyEvents(script: Script): Script {
	return {
		...script,
		states: mapValues(script.states, state => ({
			...state,
			events: removeEmptyEventsFromState(state.events),
		})),
	};
}

function removeEmptyEventsFromState(events: Event[]): Event[] {
	const nonEmpty = events.filter(event => !isEmptyStmt(event.body));
	if (nonEmpty.length > 0) return nonEmpty;
	return events.length > 0 ? [events[0]!] : events;
}

function removeUnusedGlobals(script: Script): Script {
	const mentioned = new Set<string>();
	for (const [name, global] of script.globals) {
		if (global.initializer) {
			visitVariableIdentifiers(global.initializer, ref => {
				if (ref !== name) mentioned.add(ref);
			});
		}
	}
	for (const fn of script.functions.values()) collectMentionedInStmt(fn.body, mentioned);
	for (const state of script.states.values()) {
		for (const event of state.events) collectMentionedInStmt(event.body, mentioned);
	}
	const globals = new Map<string, GlobalVar>();
	for (const [name, global] of script.globals) {
		if (!mentioned.has(name) && (!global.initializer || isSideEffectFreeExpr(global.initializer, new Set(), new Set()))) continue;
		globals.set(name, global);
	}
	return globals.size === script.globals.size ? script : { ...script, globals };
}

function removeUnusedParameters(script: Script): Script {
	const pureFunctions = collectPureFunctions(script);
	const noOpFunctions = collectNoOpVoidFunctions(script, pureFunctions);
	let current = script;
	let changed = true;
	while (changed) {
		changed = false;
		for (const [name, fn] of current.functions) {
			const unused = unusedParameterIndexes(fn);
			if (!unused.size) continue;
			if (!canDropCallArgs(current, name, unused, pureFunctions, noOpFunctions)) continue;
			current = dropFunctionParameters(current, name, unused);
			changed = true;
			break;
		}
	}
	return current;
}

function unusedParameterIndexes(fn: FnNode): Set<number> {
	const out = new Set<number>();
	let index = 0;
	for (const name of fn.parameters.keys()) {
		if (countVariableRefsInStmt(fn.body, name) === 0) out.add(index);
		index++;
	}
	return out;
}

function canDropCallArgs(script: Script, name: string, indexes: ReadonlySet<number>, pureFunctions: ReadonlySet<string>, noOpFunctions: ReadonlySet<string>): boolean {
	let ok = true;
	visitScriptCallExprs(script, call => {
		if (!ok || call.callee.kind !== 'Identifier' || call.callee.name !== name) return;
		for (const index of indexes) {
			const arg = call.args[index];
			if (arg && !isSideEffectFreeExpr(arg, pureFunctions, noOpFunctions)) ok = false;
		}
	});
	return ok;
}

function dropFunctionParameters(script: Script, name: string, indexes: ReadonlySet<number>): Script {
	return dropCallArgsScript({
		...script,
		functions: mapValues(script.functions, fn => fn.name === name ? { ...fn, parameters: filterParams(fn.parameters, indexes) } : fn),
	}, name, indexes);
}

function filterParams(params: ReadonlyMap<string, Type>, indexes: ReadonlySet<number>): Map<string, Type> {
	const out = new Map<string, Type>();
	let index = 0;
	for (const [name, type] of params) {
		if (!indexes.has(index)) out.set(name, type);
		index++;
	}
	return out;
}

function dropCallArgsScript(script: Script, name: string, indexes: ReadonlySet<number>): Script {
	return {
		...script,
		globals: mapValues(script.globals, global => ({
			...global,
			initializer: global.initializer ? dropCallArgsExpr(global.initializer, name, indexes) : undefined,
		})),
		functions: mapValues(script.functions, fn => ({
			...fn,
			body: dropCallArgsStmt(fn.body, name, indexes),
		})),
		states: mapValues(script.states, state => ({
			...state,
			events: state.events.map(event => ({
				...event,
				body: dropCallArgsStmt(event.body, name, indexes),
			})),
		})),
	};
}

function dropCallArgsStmt(stmt: Stmt, name: string, indexes: ReadonlySet<number>): Stmt {
	switch (stmt.kind) {
		case 'EmptyStmt':
		case 'ErrorStmt':
		case 'LabelStmt':
		case 'StateChangeStmt':
			return stmt;
		case 'ExprStmt':
			return { ...stmt, expression: dropCallArgsExpr(stmt.expression, name, indexes) };
		case 'VarDecl':
			return { ...stmt, initializer: stmt.initializer ? dropCallArgsExpr(stmt.initializer, name, indexes) : undefined };
		case 'ReturnStmt':
			return { ...stmt, expression: stmt.expression ? dropCallArgsExpr(stmt.expression, name, indexes) : undefined };
		case 'IfStmt':
			return { ...stmt, condition: dropCallArgsExpr(stmt.condition, name, indexes), then: dropCallArgsStmt(stmt.then, name, indexes), else: stmt.else ? dropCallArgsStmt(stmt.else, name, indexes) : undefined };
		case 'WhileStmt':
			return { ...stmt, condition: dropCallArgsExpr(stmt.condition, name, indexes), body: dropCallArgsStmt(stmt.body, name, indexes) };
		case 'DoWhileStmt':
			return { ...stmt, body: dropCallArgsStmt(stmt.body, name, indexes), condition: dropCallArgsExpr(stmt.condition, name, indexes) };
		case 'ForStmt':
			return {
				...stmt,
				init: stmt.init ? dropCallArgsExpr(stmt.init, name, indexes) : undefined,
				condition: stmt.condition ? dropCallArgsExpr(stmt.condition, name, indexes) : undefined,
				update: stmt.update ? dropCallArgsExpr(stmt.update, name, indexes) : undefined,
				body: dropCallArgsStmt(stmt.body, name, indexes),
			};
		case 'BlockStmt':
			return { ...stmt, statements: stmt.statements.map(child => dropCallArgsStmt(child, name, indexes)) };
		case 'JumpStmt':
			return { ...stmt, target: dropCallArgsExpr(stmt.target, name, indexes) };
		default:
			AssertNever(stmt);
			return stmt;
	}
}

function dropCallArgsExpr(expr: Expr, name: string, indexes: ReadonlySet<number>): Expr {
	switch (expr.kind) {
		case 'ErrorExpr':
		case 'StringLiteral':
		case 'NumberLiteral':
		case 'Identifier':
			return expr;
		case 'Member':
			return { ...expr, object: dropCallArgsExpr(expr.object, name, indexes) };
		case 'Unary':
			return { ...expr, argument: dropCallArgsExpr(expr.argument, name, indexes) };
		case 'Binary':
			return { ...expr, left: dropCallArgsExpr(expr.left, name, indexes), right: dropCallArgsExpr(expr.right, name, indexes) };
		case 'Cast':
			return { ...expr, argument: dropCallArgsExpr(expr.argument, name, indexes) };
		case 'Paren':
			return { ...expr, expression: dropCallArgsExpr(expr.expression, name, indexes) };
		case 'ListLiteral':
			return { ...expr, elements: expr.elements.map(element => dropCallArgsExpr(element, name, indexes)) };
		case 'VectorLiteral':
			return { ...expr, elements: expr.elements.map(element => dropCallArgsExpr(element, name, indexes)) as Expr[] as ExprTuple<typeof expr.elements> };
		case 'Call': {
			const callee = dropCallArgsExpr(expr.callee, name, indexes);
			const args = expr.args.map(arg => dropCallArgsExpr(arg, name, indexes));
			return callee.kind === 'Identifier' && callee.name === name
				? { ...expr, callee, args: args.filter((_, index) => !indexes.has(index)) }
				: { ...expr, callee, args };
		}
		default:
			AssertNever(expr);
			return expr;
	}
}

function singleReturnExpression(fn: FnNode): Expr | null {
	if (!fn.returnType || fn.returnType === 'void') return null;
	const body = fn.body;
	if (body.kind === 'ReturnStmt') return body.expression ?? null;
	if (body.kind === 'BlockStmt' && body.statements.length === 1 && body.statements[0]?.kind === 'ReturnStmt') {
		return body.statements[0].expression ?? null;
	}
	return null;
}

function collectNoOpVoidFunctions(script: Script, pureFunctions: ReadonlySet<string>): Set<string> {
	const noOp = new Set<string>();
	let changed = true;
	while (changed) {
		changed = false;
		for (const [name, fn] of script.functions) {
			if (noOp.has(name) || (fn.returnType && fn.returnType !== 'void')) continue;
			if (stmtHasNoEffects(fn.body, pureFunctions, noOp)) {
				noOp.add(name);
				changed = true;
			}
		}
	}
	return noOp;
}

function cleanupStmt(stmt: Stmt, pureFunctions: ReadonlySet<string>, noOpFunctions: ReadonlySet<string>): Stmt {
	switch (stmt.kind) {
		case 'EmptyStmt':
		case 'ErrorStmt':
		case 'LabelStmt':
		case 'StateChangeStmt':
			return stmt;
		case 'ExprStmt':
			return isSideEffectFreeExpr(stmt.expression, pureFunctions, noOpFunctions) ? { ...stmt, kind: 'EmptyStmt' } : stmt;
		case 'VarDecl':
			return stmt;
		case 'ReturnStmt':
			return stmt;
		case 'IfStmt': {
			const thenStmt = cleanupStmt(stmt.then, pureFunctions, noOpFunctions);
			const elseStmt = stmt.else ? cleanupStmt(stmt.else, pureFunctions, noOpFunctions) : undefined;
			if (isEmptyStmt(thenStmt) && (!elseStmt || isEmptyStmt(elseStmt)) && isSideEffectFreeExpr(stmt.condition, pureFunctions, noOpFunctions)) {
				return { ...stmt, kind: 'EmptyStmt' };
			}
			return { ...stmt, then: thenStmt, else: elseStmt };
		}
		case 'WhileStmt': {
			const body = cleanupStmt(stmt.body, pureFunctions, noOpFunctions);
			if (isEmptyStmt(body) && isLiteralFalse(stmt.condition) && isSideEffectFreeExpr(stmt.condition, pureFunctions, noOpFunctions)) return { ...stmt, kind: 'EmptyStmt' };
			return { ...stmt, body };
		}
		case 'DoWhileStmt': {
			const body = cleanupStmt(stmt.body, pureFunctions, noOpFunctions);
			if (isEmptyStmt(body) && isLiteralFalse(stmt.condition) && isSideEffectFreeExpr(stmt.condition, pureFunctions, noOpFunctions)) return { ...stmt, kind: 'EmptyStmt' };
			return { ...stmt, body };
		}
		case 'ForStmt': {
			const body = cleanupStmt(stmt.body, pureFunctions, noOpFunctions);
			if (
				isEmptyStmt(body)
				&& stmt.condition
				&& isLiteralFalse(stmt.condition)
				&& (!stmt.init || isSideEffectFreeExpr(stmt.init, pureFunctions, noOpFunctions))
				&& (!stmt.update || isSideEffectFreeExpr(stmt.update, pureFunctions, noOpFunctions))
			) return { ...stmt, kind: 'EmptyStmt' };
			return { ...stmt, body };
		}
		case 'BlockStmt': {
			const statements = stmt.statements
				.map(child => cleanupStmt(child, pureFunctions, noOpFunctions))
				.filter(child => !isEmptyStmt(child));
			const reachable = dropStatementsAfterTerminal(statements);
			const withoutUnused = removeUnusedLocalDecls(reachable, pureFunctions, noOpFunctions);
			const withValueFlow = propagateLocalValueFlow(withoutUnused, pureFunctions, noOpFunctions);
			const withoutDeadAssignments = removeDeadLocalAssignments(withValueFlow, pureFunctions, noOpFunctions);
			const propagated = inlineLocalDeclsBySize(withoutDeadAssignments, pureFunctions, noOpFunctions);
			const reusedLocals = reuseNonEscapingLocalSlots(propagated);
			const withoutDeadInitializers = dropDeadLocalInitializers(reusedLocals, pureFunctions, noOpFunctions);
			return { ...stmt, statements: removeImmediateJumpLabels(withoutDeadInitializers) };
		}
		case 'JumpStmt':
			return stmt;
		default:
			AssertNever(stmt);
			return stmt;
	}
}

function dropStatementsAfterTerminal(statements: Stmt[]): Stmt[] {
	if (statements.some(stmt => stmt.kind === 'LabelStmt')) return statements;
	const out: Stmt[] = [];
	for (const stmt of statements) {
		out.push(stmt);
		if (isTerminalStmt(stmt)) break;
	}
	return out.length === statements.length ? statements : out;
}

function isTerminalStmt(stmt: Stmt): boolean {
	if (stmt.kind === 'ReturnStmt' || stmt.kind === 'StateChangeStmt' || stmt.kind === 'JumpStmt') return true;
	if (stmt.kind !== 'BlockStmt') return false;
	const last = stmt.statements[stmt.statements.length - 1];
	return !!last && isTerminalStmt(last);
}

function cleanupBody(stmt: Stmt, returnType?: Type | 'void'): Stmt {
	const withoutLabels = removeUnreferencedLabels(stmt);
	return returnType === undefined || returnType === 'void' ? dropTrailingBareReturn(withoutLabels) : withoutLabels;
}

function dropTrailingBareReturn(stmt: Stmt): Stmt {
	if (stmt.kind === 'ReturnStmt' && !stmt.expression) return { ...stmt, kind: 'EmptyStmt' };
	if (stmt.kind !== 'BlockStmt') return stmt;
	const statements = [...stmt.statements];
	while (statements.length && isEmptyStmt(statements[statements.length - 1]!)) statements.pop();
	const last = statements[statements.length - 1];
	if (last?.kind === 'ReturnStmt' && !last.expression) statements.pop();
	return { ...stmt, statements };
}

function removeImmediateJumpLabels(statements: Stmt[]): Stmt[] {
	const out: Stmt[] = [];
	for (let index = 0; index < statements.length; index++) {
		const stmt = statements[index]!;
		const next = statements[index + 1];
		if (stmt.kind === 'JumpStmt' && next?.kind === 'LabelStmt' && jumpTargetName(stmt.target) === next.name) {
			continue;
		}
		out.push(stmt);
	}
	return out;
}

function removeUnreferencedLabels(stmt: Stmt): Stmt {
	const referenced = new Set<string>();
	collectJumpTargets(stmt, referenced);
	return removeUnreferencedLabelsInner(stmt, referenced);
}

function removeUnreferencedLabelsInner(stmt: Stmt, referenced: ReadonlySet<string>): Stmt {
	switch (stmt.kind) {
		case 'IfStmt':
			return { ...stmt, then: removeUnreferencedLabelsInner(stmt.then, referenced), else: stmt.else ? removeUnreferencedLabelsInner(stmt.else, referenced) : undefined };
		case 'WhileStmt':
			return { ...stmt, body: removeUnreferencedLabelsInner(stmt.body, referenced) };
		case 'DoWhileStmt':
			return { ...stmt, body: removeUnreferencedLabelsInner(stmt.body, referenced) };
		case 'ForStmt':
			return { ...stmt, body: removeUnreferencedLabelsInner(stmt.body, referenced) };
		case 'BlockStmt':
			return { ...stmt, statements: stmt.statements.map(child => removeUnreferencedLabelsInner(child, referenced)).filter(child => child.kind !== 'LabelStmt' || referenced.has(child.name)) };
		case 'EmptyStmt':
		case 'ErrorStmt':
		case 'ExprStmt':
		case 'VarDecl':
		case 'ReturnStmt':
		case 'JumpStmt':
		case 'LabelStmt':
		case 'StateChangeStmt':
			return stmt;
		default:
			AssertNever(stmt);
			return stmt;
	}
}

function collectJumpTargets(stmt: Stmt, out: Set<string>): void {
	switch (stmt.kind) {
		case 'JumpStmt': {
			const name = jumpTargetName(stmt.target);
			if (name) out.add(name);
			return;
		}
		case 'IfStmt':
			collectJumpTargets(stmt.then, out);
			if (stmt.else) collectJumpTargets(stmt.else, out);
			return;
		case 'WhileStmt':
			collectJumpTargets(stmt.body, out);
			return;
		case 'DoWhileStmt':
			collectJumpTargets(stmt.body, out);
			return;
		case 'ForStmt':
			collectJumpTargets(stmt.body, out);
			return;
		case 'BlockStmt':
			for (const child of stmt.statements) collectJumpTargets(child, out);
			return;
		case 'EmptyStmt':
		case 'ErrorStmt':
		case 'ExprStmt':
		case 'VarDecl':
		case 'ReturnStmt':
		case 'LabelStmt':
		case 'StateChangeStmt':
			return;
		default:
			AssertNever(stmt);
	}
}

function jumpTargetName(expr: Expr): string | null {
	if (expr.kind === 'Identifier') return expr.name;
	if (expr.kind === 'StringLiteral') return expr.value;
	return null;
}

function removeUnusedLocalDecls(statements: Stmt[], pureFunctions: ReadonlySet<string>, noOpFunctions: ReadonlySet<string>): Stmt[] {
	const mentioned = new Set<string>();
	const out: Stmt[] = [];
	for (let index = statements.length - 1; index >= 0; index--) {
		const stmt = statements[index]!;
		if (stmt.kind === 'VarDecl') {
			if (!mentioned.has(stmt.name) && (!stmt.initializer || isSideEffectFreeExpr(stmt.initializer, pureFunctions, noOpFunctions))) {
				mentioned.delete(stmt.name);
				continue;
			}
			if (stmt.initializer) visitVariableIdentifiers(stmt.initializer, name => mentioned.add(name));
			mentioned.delete(stmt.name);
			out.push(stmt);
			continue;
		}
		collectMentionedInStmt(stmt, mentioned);
		out.push(stmt);
	}
	out.reverse();
	return out;
}

interface LocalValueFact {
	expr: Expr;
	dependencies: Set<string>;
}

function propagateLocalValueFlow(statements: Stmt[], pureFunctions: ReadonlySet<string>, noOpFunctions: ReadonlySet<string>): Stmt[] {
	if (statements.some(stmt => stmt.kind === 'LabelStmt' || stmt.kind === 'JumpStmt')) return statements;
	const locals = collectDirectLocalDeclarations(statements);
	if (!locals.size) return statements;
	const facts = new Map<string, LocalValueFact>();
	const out: Stmt[] = [];
	let changed = false;
	for (const stmt of statements) {
		const rewritten = replaceLocalValueFactsInStmt(stmt, facts);
		if (rewritten !== stmt) changed = true;
		const written = collectWrittenNamesInStmt(rewritten);
		invalidateLocalValueFacts(facts, written);
		updateLocalValueFacts(rewritten, locals, facts, pureFunctions, noOpFunctions);
		out.push(rewritten);
	}
	return changed ? out : statements;
}

function invalidateLocalValueFacts(facts: Map<string, LocalValueFact>, written: ReadonlySet<string>): void {
	if (!written.size) return;
	for (const [name, fact] of facts) {
		if (written.has(name) || intersects(written, fact.dependencies)) facts.delete(name);
	}
}

function updateLocalValueFacts(stmt: Stmt, locals: ReadonlySet<string>, facts: Map<string, LocalValueFact>, pureFunctions: ReadonlySet<string>, noOpFunctions: ReadonlySet<string>): void {
	if (stmt.kind === 'VarDecl') {
		facts.delete(stmt.name);
		if (locals.has(stmt.name) && stmt.initializer) addLocalValueFact(stmt.name, stmt.initializer, locals, facts, pureFunctions, noOpFunctions);
		return;
	}
	if (stmt.kind !== 'ExprStmt') return;
	const assignment = simpleIdentifierAssignment(stmt.expression);
	if (!assignment || !locals.has(assignment.name)) return;
	facts.delete(assignment.name);
	addLocalValueFact(assignment.name, assignment.value, locals, facts, pureFunctions, noOpFunctions);
}

function addLocalValueFact(name: string, expr: Expr, locals: ReadonlySet<string>, facts: Map<string, LocalValueFact>, pureFunctions: ReadonlySet<string>, noOpFunctions: ReadonlySet<string>): void {
	if (!isCheapLocalValueExpr(expr, locals, pureFunctions, noOpFunctions)) return;
	const dependencies = new Set<string>();
	visitVariableIdentifiers(expr, ref => {
		if (ref !== name) dependencies.add(ref);
	});
	facts.set(name, { expr, dependencies });
}

function isCheapLocalValueExpr(expr: Expr, locals: ReadonlySet<string>, pureFunctions: ReadonlySet<string>, noOpFunctions: ReadonlySet<string>): boolean {
	if (!isSideEffectFreeExpr(expr, pureFunctions, noOpFunctions)) return false;
	let ok = true;
	let hasCall = false;
	visitVariableIdentifiers(expr, name => {
		if (!locals.has(name)) ok = false;
	});
	visitExprCalls(expr, () => {
		hasCall = true;
	});
	return ok && !hasCall && emitExpr(expr).length <= 48;
}

function replaceLocalValueFactsInStmt(stmt: Stmt, facts: ReadonlyMap<string, LocalValueFact>): Stmt {
	if (!facts.size) return stmt;
	switch (stmt.kind) {
		case 'ExprStmt': {
			const expression = replaceLocalValueFactsInExpr(stmt.expression, facts);
			return expression === stmt.expression ? stmt : { ...stmt, expression };
		}
		case 'VarDecl': {
			const initializer = stmt.initializer ? replaceLocalValueFactsInExpr(stmt.initializer, facts) : undefined;
			return initializer === stmt.initializer ? stmt : { ...stmt, initializer };
		}
		case 'ReturnStmt': {
			const expression = stmt.expression ? replaceLocalValueFactsInExpr(stmt.expression, facts) : undefined;
			return expression === stmt.expression ? stmt : { ...stmt, expression };
		}
		case 'IfStmt': {
			const condition = replaceLocalValueFactsInExpr(stmt.condition, facts);
			return condition === stmt.condition ? stmt : { ...stmt, condition };
		}
		case 'EmptyStmt':
		case 'ErrorStmt':
		case 'WhileStmt':
		case 'DoWhileStmt':
		case 'ForStmt':
		case 'BlockStmt':
		case 'JumpStmt':
		case 'LabelStmt':
		case 'StateChangeStmt':
			return stmt;
		default:
			AssertNever(stmt);
			return stmt;
	}
}

function replaceLocalValueFactsInExpr(expr: Expr, facts: ReadonlyMap<string, LocalValueFact>): Expr {
	switch (expr.kind) {
		case 'ErrorExpr':
		case 'StringLiteral':
		case 'NumberLiteral':
			return expr;
		case 'Identifier':
			return facts.has(expr.name) ? cloneExpr(facts.get(expr.name)!.expr) : expr;
		case 'Call': {
			const callee = expr.callee.kind === 'Identifier' ? expr.callee : replaceLocalValueFactsInExpr(expr.callee, facts);
			const args = expr.args.map(arg => replaceLocalValueFactsInExpr(arg, facts));
			return callee === expr.callee && args.every((arg, index) => arg === expr.args[index]) ? expr : { ...expr, callee, args };
		}
		case 'Member':
			return expr;
		case 'Unary':
			if (expr.op === '++' || expr.op === '--') return expr;
			return replaceLocalValueFactsUnary(expr, facts);
		case 'Binary':
			if (isAssignmentOp(expr.op)) return replaceLocalValueFactsAssignment(expr, facts);
			return replaceLocalValueFactsBinary(expr, facts);
		case 'Cast': {
			const argument = replaceLocalValueFactsInExpr(expr.argument, facts);
			return argument === expr.argument ? expr : { ...expr, argument };
		}
		case 'Paren': {
			const expression = replaceLocalValueFactsInExpr(expr.expression, facts);
			return expression === expr.expression ? expr : { ...expr, expression };
		}
		case 'ListLiteral': {
			const elements = expr.elements.map(element => replaceLocalValueFactsInExpr(element, facts));
			return elements.every((element, index) => element === expr.elements[index]) ? expr : { ...expr, elements };
		}
		case 'VectorLiteral': {
			const elements = expr.elements.map(element => replaceLocalValueFactsInExpr(element, facts)) as Expr[] as ExprTuple<typeof expr.elements>;
			return elements.every((element, index) => element === expr.elements[index]) ? expr : { ...expr, elements };
		}
		default:
			AssertNever(expr);
			return expr;
	}
}

function replaceLocalValueFactsUnary(expr: Extract<Expr, { kind: 'Unary' }>, facts: ReadonlyMap<string, LocalValueFact>): Expr {
	const argument = replaceLocalValueFactsInExpr(expr.argument, facts);
	return argument === expr.argument ? expr : { ...expr, argument };
}

function replaceLocalValueFactsBinary(expr: Extract<Expr, { kind: 'Binary' }>, facts: ReadonlyMap<string, LocalValueFact>): Expr {
	const left = replaceLocalValueFactsInExpr(expr.left, facts);
	const right = replaceLocalValueFactsInExpr(expr.right, facts);
	return left === expr.left && right === expr.right ? expr : { ...expr, left, right };
}

function replaceLocalValueFactsAssignment(expr: Extract<Expr, { kind: 'Binary' }>, facts: ReadonlyMap<string, LocalValueFact>): Expr {
	const right = replaceLocalValueFactsInExpr(expr.right, facts);
	return right === expr.right ? expr : { ...expr, right };
}

function removeDeadLocalAssignments(statements: Stmt[], pureFunctions: ReadonlySet<string>, noOpFunctions: ReadonlySet<string>): Stmt[] {
	if (statements.some(stmt => stmt.kind === 'LabelStmt' || stmt.kind === 'JumpStmt')) return statements;
	const locals = collectDirectLocalDeclarations(statements);
	if (!locals.size) return statements;
	const live = new Set<string>();
	const out: Stmt[] = [];
	for (let index = statements.length - 1; index >= 0; index--) {
		const stmt = statements[index]!;
		if (isDeadLocalAssignment(stmt, locals, live, pureFunctions, noOpFunctions)) continue;
		collectReadNamesFromStmt(stmt, live);
		removeDefiniteLocalWritesFromLive(stmt, locals, live);
		out.push(stmt);
	}
	out.reverse();
	return out.length === statements.length ? statements : out;
}

function dropDeadLocalInitializers(statements: Stmt[], pureFunctions: ReadonlySet<string>, noOpFunctions: ReadonlySet<string>): Stmt[] {
	if (statements.some(stmt => stmt.kind === 'LabelStmt' || stmt.kind === 'JumpStmt')) return statements;
	const locals = collectDirectLocalDeclarations(statements);
	if (!locals.size) return statements;
	const live = new Set<string>();
	const out: Stmt[] = [];
	let changed = false;
	for (let index = statements.length - 1; index >= 0; index--) {
		const stmt = statements[index]!;
		if (
			stmt.kind === 'VarDecl'
			&& stmt.initializer
			&& locals.has(stmt.name)
			&& !live.has(stmt.name)
			&& isSideEffectFreeExpr(stmt.initializer, pureFunctions, noOpFunctions)
		) {
			out.push({ ...stmt, initializer: undefined });
			live.delete(stmt.name);
			changed = true;
			continue;
		}
		collectReadNamesFromStmt(stmt, live);
		removeDefiniteLocalWritesFromLive(stmt, locals, live);
		out.push(stmt);
	}
	out.reverse();
	return changed ? out : statements;
}

function collectDirectLocalDeclarations(statements: readonly Stmt[]): Set<string> {
	const locals = new Set<string>();
	for (const stmt of statements) {
		if (stmt.kind === 'VarDecl') locals.add(stmt.name);
	}
	return locals;
}

function isDeadLocalAssignment(stmt: Stmt, locals: ReadonlySet<string>, live: ReadonlySet<string>, pureFunctions: ReadonlySet<string>, noOpFunctions: ReadonlySet<string>): boolean {
	if (stmt.kind !== 'ExprStmt') return false;
	const assignment = simpleIdentifierAssignment(stmt.expression);
	if (!assignment || !locals.has(assignment.name) || live.has(assignment.name)) return false;
	return isSideEffectFreeExpr(assignment.value, pureFunctions, noOpFunctions);
}

function simpleIdentifierAssignment(expr: Expr): { name: string; value: Expr } | null {
	if (expr.kind === 'Paren') return simpleIdentifierAssignment(expr.expression);
	if (expr.kind !== 'Binary' || expr.op !== '=' || expr.left.kind !== 'Identifier') return null;
	return { name: expr.left.name, value: expr.right };
}

function removeDefiniteLocalWritesFromLive(stmt: Stmt, locals: ReadonlySet<string>, live: Set<string>): void {
	switch (stmt.kind) {
		case 'VarDecl':
			if (locals.has(stmt.name)) live.delete(stmt.name);
			return;
		case 'ExprStmt': {
			const assignment = simpleIdentifierAssignment(stmt.expression);
			if (assignment && locals.has(assignment.name)) live.delete(assignment.name);
			return;
		}
		case 'EmptyStmt':
		case 'ErrorStmt':
		case 'ReturnStmt':
		case 'IfStmt':
		case 'WhileStmt':
		case 'DoWhileStmt':
		case 'ForStmt':
		case 'BlockStmt':
		case 'JumpStmt':
		case 'LabelStmt':
		case 'StateChangeStmt':
			return;
		default:
			AssertNever(stmt);
	}
}

function collectReadNamesFromStmt(stmt: Stmt, out: Set<string>): void {
	switch (stmt.kind) {
		case 'EmptyStmt':
		case 'ErrorStmt':
		case 'LabelStmt':
		case 'StateChangeStmt':
			return;
		case 'ExprStmt':
			collectReadNamesFromExpr(stmt.expression, out);
			return;
		case 'VarDecl':
			if (stmt.initializer) collectReadNamesFromExpr(stmt.initializer, out);
			return;
		case 'ReturnStmt':
			if (stmt.expression) collectReadNamesFromExpr(stmt.expression, out);
			return;
		case 'IfStmt':
			collectReadNamesFromExpr(stmt.condition, out);
			collectReadNamesFromStmt(stmt.then, out);
			if (stmt.else) collectReadNamesFromStmt(stmt.else, out);
			return;
		case 'WhileStmt':
			collectReadNamesFromExpr(stmt.condition, out);
			collectReadNamesFromStmt(stmt.body, out);
			return;
		case 'DoWhileStmt':
			collectReadNamesFromStmt(stmt.body, out);
			collectReadNamesFromExpr(stmt.condition, out);
			return;
		case 'ForStmt':
			if (stmt.init) collectReadNamesFromExpr(stmt.init, out);
			if (stmt.condition) collectReadNamesFromExpr(stmt.condition, out);
			if (stmt.update) collectReadNamesFromExpr(stmt.update, out);
			collectReadNamesFromStmt(stmt.body, out);
			return;
		case 'BlockStmt':
			for (const child of stmt.statements) collectReadNamesFromStmt(child, out);
			return;
		case 'JumpStmt':
			collectReadNamesFromExpr(stmt.target, out);
			return;
		default:
			AssertNever(stmt);
	}
}

function collectReadNamesFromExpr(expr: Expr, out: Set<string>): void {
	switch (expr.kind) {
		case 'ErrorExpr':
		case 'StringLiteral':
		case 'NumberLiteral':
			return;
		case 'Identifier':
			out.add(expr.name);
			return;
		case 'Call':
			if (expr.callee.kind !== 'Identifier') collectReadNamesFromExpr(expr.callee, out);
			for (const arg of expr.args) collectReadNamesFromExpr(arg, out);
			return;
		case 'Member':
			collectReadNamesFromExpr(expr.object, out);
			return;
		case 'Unary':
			collectReadNamesFromExpr(expr.argument, out);
			return;
		case 'Binary':
			if (isAssignmentOp(expr.op)) {
				if (expr.left.kind === 'Member') collectReadNamesFromExpr(expr.left.object, out);
				if (expr.op !== '=') collectReadNamesFromExpr(expr.left, out);
				collectReadNamesFromExpr(expr.right, out);
				return;
			}
			collectReadNamesFromExpr(expr.left, out);
			collectReadNamesFromExpr(expr.right, out);
			return;
		case 'Cast':
			collectReadNamesFromExpr(expr.argument, out);
			return;
		case 'Paren':
			collectReadNamesFromExpr(expr.expression, out);
			return;
		case 'ListLiteral':
			for (const element of expr.elements) collectReadNamesFromExpr(element, out);
			return;
		case 'VectorLiteral':
			for (const element of expr.elements) collectReadNamesFromExpr(element, out);
			return;
		default:
			AssertNever(expr);
	}
}

function inlineLocalDeclsBySize(statements: Stmt[], pureFunctions: ReadonlySet<string>, noOpFunctions: ReadonlySet<string>): Stmt[] {
	let current = statements;
	let changed = true;
	while (changed) {
		changed = false;
		for (let index = 0; index < current.length; index++) {
			const stmt = current[index]!;
			if (stmt.kind !== 'VarDecl' || !stmt.initializer) continue;
			if (!isSideEffectFreeExpr(stmt.initializer, pureFunctions, noOpFunctions)) continue;
			const next = inlineLocalDeclCandidate(current, index, stmt);
			if (!next) continue;
			const beforeBytes = emitBlockStatements(current);
			const afterBytes = emitBlockStatements(next);
			if (afterBytes < beforeBytes || (afterBytes <= beforeBytes + 64 && mayInlineLocalForMemory(stmt.initializer, pureFunctions))) {
				current = next;
				changed = true;
				break;
			}
		}
	}
	return current;
}

function reuseNonEscapingLocalSlots(statements: Stmt[]): Stmt[] {
	if (statements.some(stmtContainsLabelOrJump)) return statements;
	let current = statements;
	let changed = false;
	for (let index = 0; index < current.length; index++) {
		const stmt = current[index]!;
		if (stmt.kind !== 'VarDecl' || !stmt.initializer || countVariableRefs(stmt.initializer, stmt.name) > 0) continue;
		const reusable = findReusableLocalSlot(current, index, stmt);
		if (!reusable) continue;
		current = reuseLocalSlot(current, index, reusable.name, stmt);
		changed = true;
	}
	return changed ? current : statements;
}

function findReusableLocalSlot(statements: readonly Stmt[], declarationIndex: number, declaration: Extract<Stmt, { kind: 'VarDecl' }>): Extract<Stmt, { kind: 'VarDecl' }> | null {
	for (let index = declarationIndex - 1; index >= 0; index--) {
		const candidate = statements[index]!;
		if (candidate.kind !== 'VarDecl' || candidate.varType !== declaration.varType || candidate.name === declaration.name) continue;
		if (canReuseLocalSlot(statements, declarationIndex, candidate.name, declaration.name)) return candidate;
	}
	return null;
}

function canReuseLocalSlot(statements: readonly Stmt[], declarationIndex: number, oldName: string, newName: string): boolean {
	for (const stmt of statements.slice(declarationIndex + 1)) {
		if (countVariableRefsInStmt(stmt, oldName) > 0) return false;
		if (declaresNameInStmt(stmt, oldName) || declaresNameInStmt(stmt, newName)) return false;
	}
	return true;
}

function reuseLocalSlot(statements: readonly Stmt[], declarationIndex: number, oldName: string, declaration: Extract<Stmt, { kind: 'VarDecl' }>): Stmt[] {
	const out = statements.slice(0, declarationIndex);
	out.push({
		...declaration,
		kind: 'ExprStmt',
		expression: {
			...declaration.initializer!,
			kind: 'Binary',
			op: '=',
			left: { ...declaration.initializer!, kind: 'Identifier', name: oldName },
			right: declaration.initializer!,
		},
	});
	for (const stmt of statements.slice(declarationIndex + 1)) {
		out.push(renameLocalRefsInStmt(stmt, declaration.name, oldName));
	}
	return out;
}

function renameLocalRefsInStmt(stmt: Stmt, from: string, to: string): Stmt {
	return substituteParamsInStmt(stmt, new Map([[from, { ...stmt, kind: 'Identifier', name: to } as Expr]]));
}

function declaresNameInStmt(stmt: Stmt, name: string): boolean {
	let found = false;
	visitDeclaredNamesInStmt(stmt, declared => {
		if (declared === name) found = true;
	});
	return found;
}

function visitDeclaredNamesInStmt(stmt: Stmt, visit: (name: string) => void): void {
	switch (stmt.kind) {
		case 'VarDecl':
			visit(stmt.name);
			return;
		case 'IfStmt':
			visitDeclaredNamesInStmt(stmt.then, visit);
			if (stmt.else) visitDeclaredNamesInStmt(stmt.else, visit);
			return;
		case 'WhileStmt':
		case 'DoWhileStmt':
			visitDeclaredNamesInStmt(stmt.body, visit);
			return;
		case 'ForStmt':
			visitDeclaredNamesInStmt(stmt.body, visit);
			return;
		case 'BlockStmt':
			for (const child of stmt.statements) visitDeclaredNamesInStmt(child, visit);
			return;
		case 'EmptyStmt':
		case 'ErrorStmt':
		case 'ExprStmt':
		case 'ReturnStmt':
		case 'JumpStmt':
		case 'LabelStmt':
		case 'StateChangeStmt':
			return;
		default:
			AssertNever(stmt);
	}
}

function stmtContainsLabelOrJump(stmt: Stmt): boolean {
	if (stmt.kind === 'LabelStmt' || stmt.kind === 'JumpStmt') return true;
	let found = false;
	visitChildStatements(stmt, child => {
		if (stmtContainsLabelOrJump(child)) found = true;
	});
	return found;
}

function inlineLocalDeclCandidate(statements: Stmt[], declarationIndex: number, declaration: Extract<Stmt, { kind: 'VarDecl' }>): Stmt[] | null {
	const dependencies = new Set<string>();
	visitVariableIdentifiers(declaration.initializer!, name => {
		if (name !== declaration.name) dependencies.add(name);
	});
	const totalRefs = statements.slice(declarationIndex + 1).reduce((count, stmt) => count + countVariableRefsInStmt(stmt, declaration.name), 0);
	if (totalRefs === 0) return null;

	for (let index = declarationIndex + 1; index < statements.length; index++) {
		const stmt = statements[index]!;
		const written = collectWrittenNamesInStmt(stmt);
		if (written.has(declaration.name)) return null;
		if (intersects(written, dependencies)) return null;
	}

	const directRefs = statements.slice(declarationIndex + 1).reduce((count, stmt) => count + countReplaceableDirectRefs(stmt, declaration.name), 0);
	if (directRefs !== totalRefs) return null;

	const next = [...statements.slice(0, declarationIndex)];
	for (const stmt of statements.slice(declarationIndex + 1)) {
		next.push(countReplaceableDirectRefs(stmt, declaration.name) ? replaceDirectRefs(stmt, declaration.name, declaration.initializer!) : stmt);
	}
	return next;
}

function mayInlineLocalForMemory(expr: Expr, pureFunctions: ReadonlySet<string>): boolean {
	if (expr.kind === 'Paren') return mayInlineLocalForMemory(expr.expression, pureFunctions);
	return expr.kind === 'Call' && expr.callee.kind === 'Identifier' && pureFunctions.has(expr.callee.name);
}

function emitBlockStatements(statements: Stmt[]): number {
	return Buffer.byteLength(statements.map(emitStmt).join(''), 'utf8');
}

function intersects(left: ReadonlySet<string>, right: ReadonlySet<string>): boolean {
	for (const value of left) if (right.has(value)) return true;
	return false;
}

function countVariableRefsInStmt(stmt: Stmt, name: string): number {
	return countVariableRefsInStmtInner(stmt, name);
}

function countVariableRefsInStmtInner(stmt: Stmt, name: string): number {
	switch (stmt.kind) {
		case 'EmptyStmt':
		case 'ErrorStmt':
		case 'LabelStmt':
		case 'StateChangeStmt':
			return 0;
		case 'ExprStmt':
			return countVariableRefs(stmt.expression, name);
		case 'VarDecl':
			return stmt.initializer ? countVariableRefs(stmt.initializer, name) : 0;
		case 'ReturnStmt':
			return stmt.expression ? countVariableRefs(stmt.expression, name) : 0;
		case 'IfStmt':
			return countVariableRefs(stmt.condition, name) + countVariableRefsInStmtInner(stmt.then, name) + (stmt.else ? countVariableRefsInStmtInner(stmt.else, name) : 0);
		case 'WhileStmt':
			return countVariableRefs(stmt.condition, name) + countVariableRefsInStmtInner(stmt.body, name);
		case 'DoWhileStmt':
			return countVariableRefsInStmtInner(stmt.body, name) + countVariableRefs(stmt.condition, name);
		case 'ForStmt':
			return (stmt.init ? countVariableRefs(stmt.init, name) : 0)
				+ (stmt.condition ? countVariableRefs(stmt.condition, name) : 0)
				+ (stmt.update ? countVariableRefs(stmt.update, name) : 0)
				+ countVariableRefsInStmtInner(stmt.body, name);
		case 'BlockStmt':
			return stmt.statements.reduce((count, child) => count + countVariableRefsInStmtInner(child, name), 0);
		case 'JumpStmt':
			return countVariableRefs(stmt.target, name);
		default:
			AssertNever(stmt);
			return 0;
	}
}

function countVariableRefs(expr: Expr, name: string): number {
	let count = 0;
	visitVariableIdentifiers(expr, ref => {
		if (ref === name) count++;
	});
	return count;
}

function countReplaceableDirectRefs(stmt: Stmt, name: string): number {
	return directStmtExpressions(stmt).reduce((count, expr) => count + countReplaceableRefs(expr, name), 0);
}

function replaceDirectRefs(stmt: Stmt, name: string, replacement: Expr): Stmt {
	switch (stmt.kind) {
		case 'ExprStmt':
			return { ...stmt, expression: replaceReplaceableRefs(stmt.expression, name, replacement) };
		case 'VarDecl':
			return { ...stmt, initializer: stmt.initializer ? replaceReplaceableRefs(stmt.initializer, name, replacement) : undefined };
		case 'ReturnStmt':
			return { ...stmt, expression: stmt.expression ? replaceReplaceableRefs(stmt.expression, name, replacement) : undefined };
		case 'IfStmt':
			return { ...stmt, condition: replaceReplaceableRefs(stmt.condition, name, replacement) };
		case 'WhileStmt':
			return { ...stmt, condition: replaceReplaceableRefs(stmt.condition, name, replacement) };
		case 'DoWhileStmt':
			return { ...stmt, condition: replaceReplaceableRefs(stmt.condition, name, replacement) };
		case 'ForStmt':
			return {
				...stmt,
				init: stmt.init ? replaceReplaceableRefs(stmt.init, name, replacement) : undefined,
				condition: stmt.condition ? replaceReplaceableRefs(stmt.condition, name, replacement) : undefined,
				update: stmt.update ? replaceReplaceableRefs(stmt.update, name, replacement) : undefined,
			};
		case 'JumpStmt':
			return { ...stmt, target: replaceReplaceableRefs(stmt.target, name, replacement) };
		case 'EmptyStmt':
		case 'ErrorStmt':
		case 'LabelStmt':
		case 'StateChangeStmt':
		case 'BlockStmt':
			return stmt;
		default:
			AssertNever(stmt);
			return stmt;
	}
}

function directStmtExpressions(stmt: Stmt): Expr[] {
	switch (stmt.kind) {
		case 'ExprStmt':
			return [stmt.expression];
		case 'VarDecl':
			return stmt.initializer ? [stmt.initializer] : [];
		case 'ReturnStmt':
			return stmt.expression ? [stmt.expression] : [];
		case 'IfStmt':
		case 'WhileStmt':
			return [stmt.condition];
		case 'DoWhileStmt':
			return [stmt.condition];
		case 'ForStmt':
			return [stmt.init, stmt.condition, stmt.update].filter((expr): expr is Expr => !!expr);
		case 'JumpStmt':
			return [stmt.target];
		case 'EmptyStmt':
		case 'ErrorStmt':
		case 'LabelStmt':
		case 'StateChangeStmt':
		case 'BlockStmt':
			return [];
		default:
			AssertNever(stmt);
			return [];
	}
}

function countReplaceableRefs(expr: Expr, name: string): number {
	switch (expr.kind) {
		case 'ErrorExpr':
		case 'StringLiteral':
		case 'NumberLiteral':
			return 0;
		case 'Identifier':
			return expr.name === name ? 1 : 0;
		case 'Call':
			return (expr.callee.kind === 'Identifier' ? 0 : countReplaceableRefs(expr.callee, name))
				+ expr.args.reduce((count, arg) => count + countReplaceableRefs(arg, name), 0);
		case 'Member':
			return 0;
		case 'Unary':
			if (expr.op === '++' || expr.op === '--') return 0;
			return countReplaceableRefs(expr.argument, name);
		case 'Binary':
			if (isAssignmentOp(expr.op)) return countReplaceableRefs(expr.right, name);
			return countReplaceableRefs(expr.left, name) + countReplaceableRefs(expr.right, name);
		case 'Cast':
			return countReplaceableRefs(expr.argument, name);
		case 'Paren':
			return countReplaceableRefs(expr.expression, name);
		case 'ListLiteral':
			return expr.elements.reduce((count, element) => count + countReplaceableRefs(element, name), 0);
		case 'VectorLiteral':
			return expr.elements.reduce((count, element) => count + countReplaceableRefs(element, name), 0);
		default:
			AssertNever(expr);
			return 0;
	}
}

function replaceReplaceableRefs(expr: Expr, name: string, replacement: Expr): Expr {
	switch (expr.kind) {
		case 'ErrorExpr':
		case 'StringLiteral':
		case 'NumberLiteral':
			return expr;
		case 'Identifier':
			return expr.name === name ? cloneExpr(replacement) : expr;
		case 'Call':
			return {
				...expr,
				callee: expr.callee.kind === 'Identifier' ? expr.callee : replaceReplaceableRefs(expr.callee, name, replacement),
				args: expr.args.map(arg => replaceReplaceableRefs(arg, name, replacement)),
			};
		case 'Member':
			return expr;
		case 'Unary':
			if (expr.op === '++' || expr.op === '--') return expr;
			return { ...expr, argument: replaceReplaceableRefs(expr.argument, name, replacement) };
		case 'Binary':
			if (isAssignmentOp(expr.op)) return { ...expr, right: replaceReplaceableRefs(expr.right, name, replacement) };
			return { ...expr, left: replaceReplaceableRefs(expr.left, name, replacement), right: replaceReplaceableRefs(expr.right, name, replacement) };
		case 'Cast':
			return { ...expr, argument: replaceReplaceableRefs(expr.argument, name, replacement) };
		case 'Paren':
			return { ...expr, expression: replaceReplaceableRefs(expr.expression, name, replacement) };
		case 'ListLiteral':
			return { ...expr, elements: expr.elements.map(element => replaceReplaceableRefs(element, name, replacement)) };
		case 'VectorLiteral':
			return { ...expr, elements: expr.elements.map(element => replaceReplaceableRefs(element, name, replacement)) as Expr[] as ExprTuple<typeof expr.elements> };
		default:
			AssertNever(expr);
			return expr;
	}
}

function collectWrittenNamesInStmt(stmt: Stmt): Set<string> {
	const out = new Set<string>();
	collectWrittenNamesFromStmt(stmt, out);
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
			out.add(stmt.name);
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
			if (expr.callee.kind !== 'Identifier') collectWrittenNamesFromExpr(expr.callee, out);
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
			return { ...expr, elements: expr.elements.map(cloneExpr) as Expr[] as ExprTuple<typeof expr.elements> };
		default:
			AssertNever(expr);
			return expr;
	}
}

function stmtHasNoEffects(stmt: Stmt, pureFunctions: ReadonlySet<string>, noOpFunctions: ReadonlySet<string>): boolean {
	switch (stmt.kind) {
		case 'EmptyStmt':
		case 'LabelStmt':
			return true;
		case 'ExprStmt':
			return isSideEffectFreeExpr(stmt.expression, pureFunctions, noOpFunctions);
		case 'VarDecl':
			return !stmt.initializer || isSideEffectFreeExpr(stmt.initializer, pureFunctions, noOpFunctions);
		case 'IfStmt':
			return isSideEffectFreeExpr(stmt.condition, pureFunctions, noOpFunctions)
				&& stmtHasNoEffects(stmt.then, pureFunctions, noOpFunctions)
				&& (!stmt.else || stmtHasNoEffects(stmt.else, pureFunctions, noOpFunctions));
		case 'BlockStmt':
			return stmt.statements.every(child => stmtHasNoEffects(child, pureFunctions, noOpFunctions));
		case 'WhileStmt':
		case 'DoWhileStmt':
		case 'ForStmt':
			return false;
		case 'ErrorStmt':
		case 'JumpStmt':
		case 'ReturnStmt':
		case 'StateChangeStmt':
			return false;
		default:
			AssertNever(stmt);
			return false;
	}
}

function inlineSingleFunction(script: Script, candidate: InlineCandidate): Script {
	return {
		...script,
		globals: mapValues(script.globals, global => ({
			...global,
			initializer: global.initializer ? inlineExpr(global.initializer, candidate) : undefined,
		})),
		functions: mapValues(script.functions, fn => ({
			...fn,
			body: fn.name === candidate.name ? fn.body : inlineStmt(fn.body, candidate),
		})),
		states: mapValues(script.states, state => ({
			...state,
			events: state.events.map(event => ({
				...event,
				body: inlineStmt(event.body, candidate),
			})),
		})),
	};
}

function inlineStmt(stmt: Stmt, candidate: InlineCandidate): Stmt {
	switch (stmt.kind) {
		case 'EmptyStmt':
		case 'ErrorStmt':
		case 'LabelStmt':
		case 'StateChangeStmt':
			return stmt;
		case 'ExprStmt':
			return { ...stmt, expression: inlineExpr(stmt.expression, candidate) };
		case 'VarDecl':
			return { ...stmt, initializer: stmt.initializer ? inlineExpr(stmt.initializer, candidate) : undefined };
		case 'ReturnStmt':
			return { ...stmt, expression: stmt.expression ? inlineExpr(stmt.expression, candidate) : undefined };
		case 'IfStmt':
			return {
				...stmt,
				condition: inlineExpr(stmt.condition, candidate),
				then: inlineStmt(stmt.then, candidate),
				else: stmt.else ? inlineStmt(stmt.else, candidate) : undefined,
			};
		case 'WhileStmt':
			return { ...stmt, condition: inlineExpr(stmt.condition, candidate), body: inlineStmt(stmt.body, candidate) };
		case 'DoWhileStmt':
			return { ...stmt, body: inlineStmt(stmt.body, candidate), condition: inlineExpr(stmt.condition, candidate) };
		case 'ForStmt':
			return {
				...stmt,
				init: stmt.init ? inlineExpr(stmt.init, candidate) : undefined,
				condition: stmt.condition ? inlineExpr(stmt.condition, candidate) : undefined,
				update: stmt.update ? inlineExpr(stmt.update, candidate) : undefined,
				body: inlineStmt(stmt.body, candidate),
			};
		case 'BlockStmt':
			return { ...stmt, statements: stmt.statements.map(child => inlineStmt(child, candidate)) };
		case 'JumpStmt':
			return { ...stmt, target: inlineExpr(stmt.target, candidate) };
		default:
			AssertNever(stmt);
			return stmt;
	}
}

function inlineStatementFunctionStmt(stmt: Stmt, candidate: StatementInlineCandidate): Stmt {
	if (stmt.kind === 'ExprStmt' && isDirectCall(stmt.expression, candidate.name)) {
		return statementInlineBlock(candidate, stmt.expression.args);
	}
	switch (stmt.kind) {
		case 'EmptyStmt':
		case 'ErrorStmt':
		case 'LabelStmt':
		case 'StateChangeStmt':
		case 'ExprStmt':
		case 'VarDecl':
		case 'ReturnStmt':
		case 'JumpStmt':
			return stmt;
		case 'IfStmt':
			return {
				...stmt,
				then: inlineStatementFunctionStmt(stmt.then, candidate),
				else: stmt.else ? inlineStatementFunctionStmt(stmt.else, candidate) : undefined,
			};
		case 'WhileStmt':
			return { ...stmt, body: inlineStatementFunctionStmt(stmt.body, candidate) };
		case 'DoWhileStmt':
			return { ...stmt, body: inlineStatementFunctionStmt(stmt.body, candidate) };
		case 'ForStmt':
			return { ...stmt, body: inlineStatementFunctionStmt(stmt.body, candidate) };
		case 'BlockStmt':
			return { ...stmt, statements: stmt.statements.map(child => inlineStatementFunctionStmt(child, candidate)) };
		default:
			AssertNever(stmt);
			return stmt;
	}
}

function statementInlineBlock(candidate: StatementInlineCandidate, args: Expr[]): Stmt {
	const statements: Stmt[] = [];
	let index = 0;
	for (const [name, type] of candidate.fn.parameters) {
		statements.push({
			kind: 'VarDecl',
			varType: type,
			name,
			initializer: args[index] ? cloneExpr(args[index]!) : undefined,
			span: candidate.fn.span,
		});
		index++;
	}
	const body = rewriteInlineReturns(candidate.fn.body, candidate.endLabel);
	const bodyStatements = body.kind === 'BlockStmt' ? body.statements : [body];
	statements.push(...bodyStatements);
	if (stmtContainsBareReturn(candidate.fn.body)) {
		statements.push({ kind: 'LabelStmt', name: candidate.endLabel, span: candidate.fn.span });
	}
	return { kind: 'BlockStmt', statements, span: candidate.fn.span };
}

function rewriteInlineReturns(stmt: Stmt, endLabel: string): Stmt {
	switch (stmt.kind) {
		case 'ReturnStmt':
			return stmt.expression
				? stmt
				: { ...stmt, kind: 'JumpStmt', target: { kind: 'Identifier', name: endLabel, span: stmt.span } };
		case 'IfStmt':
			return { ...stmt, then: rewriteInlineReturns(stmt.then, endLabel), else: stmt.else ? rewriteInlineReturns(stmt.else, endLabel) : undefined };
		case 'WhileStmt':
			return { ...stmt, body: rewriteInlineReturns(stmt.body, endLabel) };
		case 'DoWhileStmt':
			return { ...stmt, body: rewriteInlineReturns(stmt.body, endLabel) };
		case 'ForStmt':
			return { ...stmt, body: rewriteInlineReturns(stmt.body, endLabel) };
		case 'BlockStmt':
			return { ...stmt, statements: stmt.statements.map(child => rewriteInlineReturns(child, endLabel)) };
		case 'EmptyStmt':
		case 'ErrorStmt':
		case 'ExprStmt':
		case 'VarDecl':
		case 'JumpStmt':
		case 'LabelStmt':
		case 'StateChangeStmt':
			return stmt;
		default:
			AssertNever(stmt);
			return stmt;
	}
}

function inlineExpr(expr: Expr, candidate: InlineCandidate): Expr {
	switch (expr.kind) {
		case 'ErrorExpr':
		case 'StringLiteral':
		case 'NumberLiteral':
		case 'Identifier':
			return expr;
		case 'Member':
			return { ...expr, object: inlineExpr(expr.object, candidate) };
		case 'Unary':
			return { ...expr, argument: inlineExpr(expr.argument, candidate) };
		case 'Binary':
			return { ...expr, left: inlineExpr(expr.left, candidate), right: inlineExpr(expr.right, candidate) };
		case 'Cast':
			return { ...expr, argument: inlineExpr(expr.argument, candidate) };
		case 'Paren':
			return { ...expr, expression: inlineExpr(expr.expression, candidate) };
		case 'ListLiteral':
			return { ...expr, elements: expr.elements.map(element => inlineExpr(element, candidate)) };
		case 'VectorLiteral':
			return { ...expr, elements: expr.elements.map(element => inlineExpr(element, candidate)) as Expr[] as ExprTuple<typeof expr.elements> };
		case 'Call': {
			const args = expr.args.map(arg => inlineExpr(arg, candidate));
			if (expr.callee.kind === 'Identifier' && expr.callee.name === candidate.name && args.length === candidate.params.length && args.every(isSideEffectFreeInlineArg)) {
				return substituteParams(candidate.expression, new Map(candidate.params.map((name, index) => [name, args[index]!])));
			}
			return { ...expr, callee: expr.callee, args };
		}
		default:
			AssertNever(expr);
			return expr;
	}
}

function collectFunctionCallCounts(script: Script): Map<string, number> {
	const out = new Map<string, number>();
	const count = (name: string) => {
		if (script.functions.has(name)) out.set(name, (out.get(name) ?? 0) + 1);
	};
	visitScriptCalls(script, count);
	return out;
}

function collectLabelNames(script: Script): Set<string> {
	const out = new Set<string>();
	const collect = (stmt: Stmt): void => {
		if (stmt.kind === 'LabelStmt') out.add(stmt.name);
		visitChildStatements(stmt, collect);
	};
	for (const fn of script.functions.values()) collect(fn.body);
	for (const state of script.states.values()) {
		for (const event of state.events) collect(event.body);
	}
	return out;
}

function uniqueGeneratedName(used: Set<string>, base: string): string {
	let name = base;
	let index = 0;
	while (used.has(name)) name = `${base}_${++index}`;
	used.add(name);
	return name;
}

function hasInlineHostileFlow(stmt: Stmt): boolean {
	let hostile = false;
	const visit = (child: Stmt): void => {
		if (child.kind === 'JumpStmt' || child.kind === 'LabelStmt' || child.kind === 'StateChangeStmt' || (child.kind === 'ReturnStmt' && !!child.expression)) hostile = true;
		if (!hostile) visitChildStatements(child, visit);
	};
	visit(stmt);
	return hostile;
}

function stmtContainsBareReturn(stmt: Stmt): boolean {
	let found = false;
	const visit = (child: Stmt): void => {
		if (child.kind === 'ReturnStmt' && !child.expression) found = true;
		if (!found) visitChildStatements(child, visit);
	};
	visit(stmt);
	return found;
}

function visitChildStatements(stmt: Stmt, visit: (stmt: Stmt) => void): void {
	switch (stmt.kind) {
		case 'IfStmt':
			visit(stmt.then);
			if (stmt.else) visit(stmt.else);
			return;
		case 'WhileStmt':
		case 'DoWhileStmt':
			visit(stmt.body);
			return;
		case 'ForStmt':
			visit(stmt.body);
			return;
		case 'BlockStmt':
			for (const child of stmt.statements) visit(child);
			return;
		case 'EmptyStmt':
		case 'ErrorStmt':
		case 'ExprStmt':
		case 'VarDecl':
		case 'ReturnStmt':
		case 'JumpStmt':
		case 'LabelStmt':
		case 'StateChangeStmt':
			return;
		default:
			AssertNever(stmt);
	}
}

function collectReachableFunctions(script: Script): Set<string> {
	const reachable = new Set<string>();
	const pending: string[] = [];
	const add = (name: string) => {
		if (!script.functions.has(name) || reachable.has(name)) return;
		reachable.add(name);
		pending.push(name);
	};
	for (const global of script.globals.values()) {
		if (global.initializer) visitExprCalls(global.initializer, add);
	}
	for (const state of script.states.values()) {
		for (const event of state.events) visitStmtCalls(event.body, add);
	}
	for (let index = 0; index < pending.length; index++) {
		const fn = script.functions.get(pending[index]!);
		if (fn) visitStmtCalls(fn.body, add);
	}
	return reachable;
}

function visitScriptCalls(script: Script, visit: (name: string) => void): void {
	for (const global of script.globals.values()) {
		if (global.initializer) visitExprCalls(global.initializer, visit);
	}
	for (const fn of script.functions.values()) visitStmtCalls(fn.body, visit);
	for (const state of script.states.values()) {
		for (const event of state.events) visitStmtCalls(event.body, visit);
	}
}

function visitScriptCallExprs(script: Script, visit: (expr: Extract<Expr, { kind: 'Call' }>) => void): void {
	for (const global of script.globals.values()) {
		if (global.initializer) visitExprCallExprs(global.initializer, visit);
	}
	for (const fn of script.functions.values()) visitStmtCallExprs(fn.body, visit);
	for (const state of script.states.values()) {
		for (const event of state.events) visitStmtCallExprs(event.body, visit);
	}
}

function visitStmtCallExprs(stmt: Stmt, visit: (expr: Extract<Expr, { kind: 'Call' }>) => void): void {
	switch (stmt.kind) {
		case 'EmptyStmt':
		case 'ErrorStmt':
		case 'LabelStmt':
		case 'StateChangeStmt':
			return;
		case 'ExprStmt':
			visitExprCallExprs(stmt.expression, visit);
			return;
		case 'VarDecl':
			if (stmt.initializer) visitExprCallExprs(stmt.initializer, visit);
			return;
		case 'ReturnStmt':
			if (stmt.expression) visitExprCallExprs(stmt.expression, visit);
			return;
		case 'IfStmt':
			visitExprCallExprs(stmt.condition, visit);
			visitStmtCallExprs(stmt.then, visit);
			if (stmt.else) visitStmtCallExprs(stmt.else, visit);
			return;
		case 'WhileStmt':
			visitExprCallExprs(stmt.condition, visit);
			visitStmtCallExprs(stmt.body, visit);
			return;
		case 'DoWhileStmt':
			visitStmtCallExprs(stmt.body, visit);
			visitExprCallExprs(stmt.condition, visit);
			return;
		case 'ForStmt':
			if (stmt.init) visitExprCallExprs(stmt.init, visit);
			if (stmt.condition) visitExprCallExprs(stmt.condition, visit);
			if (stmt.update) visitExprCallExprs(stmt.update, visit);
			visitStmtCallExprs(stmt.body, visit);
			return;
		case 'BlockStmt':
			for (const child of stmt.statements) visitStmtCallExprs(child, visit);
			return;
		case 'JumpStmt':
			visitExprCallExprs(stmt.target, visit);
			return;
		default:
			AssertNever(stmt);
	}
}

function visitExprCallExprs(expr: Expr, visit: (expr: Extract<Expr, { kind: 'Call' }>) => void): void {
	switch (expr.kind) {
		case 'ErrorExpr':
		case 'StringLiteral':
		case 'NumberLiteral':
		case 'Identifier':
			return;
		case 'Call':
			visit(expr);
			visitExprCallExprs(expr.callee, visit);
			for (const arg of expr.args) visitExprCallExprs(arg, visit);
			return;
		case 'Member':
			visitExprCallExprs(expr.object, visit);
			return;
		case 'Unary':
			visitExprCallExprs(expr.argument, visit);
			return;
		case 'Binary':
			visitExprCallExprs(expr.left, visit);
			visitExprCallExprs(expr.right, visit);
			return;
		case 'Cast':
			visitExprCallExprs(expr.argument, visit);
			return;
		case 'Paren':
			visitExprCallExprs(expr.expression, visit);
			return;
		case 'ListLiteral':
			for (const element of expr.elements) visitExprCallExprs(element, visit);
			return;
		case 'VectorLiteral':
			for (const element of expr.elements) visitExprCallExprs(element, visit);
			return;
		default:
			AssertNever(expr);
	}
}

function visitStmtCalls(stmt: Stmt, visit: (name: string) => void): void {
	switch (stmt.kind) {
		case 'EmptyStmt':
		case 'ErrorStmt':
		case 'LabelStmt':
		case 'StateChangeStmt':
			return;
		case 'ExprStmt':
			visitExprCalls(stmt.expression, visit);
			return;
		case 'VarDecl':
			if (stmt.initializer) visitExprCalls(stmt.initializer, visit);
			return;
		case 'ReturnStmt':
			if (stmt.expression) visitExprCalls(stmt.expression, visit);
			return;
		case 'IfStmt':
			visitExprCalls(stmt.condition, visit);
			visitStmtCalls(stmt.then, visit);
			if (stmt.else) visitStmtCalls(stmt.else, visit);
			return;
		case 'WhileStmt':
			visitExprCalls(stmt.condition, visit);
			visitStmtCalls(stmt.body, visit);
			return;
		case 'DoWhileStmt':
			visitStmtCalls(stmt.body, visit);
			visitExprCalls(stmt.condition, visit);
			return;
		case 'ForStmt':
			if (stmt.init) visitExprCalls(stmt.init, visit);
			if (stmt.condition) visitExprCalls(stmt.condition, visit);
			if (stmt.update) visitExprCalls(stmt.update, visit);
			visitStmtCalls(stmt.body, visit);
			return;
		case 'BlockStmt':
			for (const child of stmt.statements) visitStmtCalls(child, visit);
			return;
		case 'JumpStmt':
			visitExprCalls(stmt.target, visit);
			return;
		default:
			AssertNever(stmt);
	}
}

function visitExprCalls(expr: Expr, visit: (name: string) => void): void {
	switch (expr.kind) {
		case 'ErrorExpr':
		case 'StringLiteral':
		case 'NumberLiteral':
		case 'Identifier':
			return;
		case 'Call':
			if (expr.callee.kind === 'Identifier') visit(expr.callee.name);
			visitExprCalls(expr.callee, visit);
			for (const arg of expr.args) visitExprCalls(arg, visit);
			return;
		case 'Member':
			visitExprCalls(expr.object, visit);
			return;
		case 'Unary':
			visitExprCalls(expr.argument, visit);
			return;
		case 'Binary':
			visitExprCalls(expr.left, visit);
			visitExprCalls(expr.right, visit);
			return;
		case 'Cast':
			visitExprCalls(expr.argument, visit);
			return;
		case 'Paren':
			visitExprCalls(expr.expression, visit);
			return;
		case 'ListLiteral':
			for (const element of expr.elements) visitExprCalls(element, visit);
			return;
		case 'VectorLiteral':
			for (const element of expr.elements) visitExprCalls(element, visit);
			return;
		default:
			AssertNever(expr);
	}
}

function exprCallsFunction(expr: Expr, name: string): boolean {
	let found = false;
	visitExprCalls(expr, callee => {
		if (callee === name) found = true;
	});
	return found;
}

function stmtCallsFunction(stmt: Stmt, name: string): boolean {
	let found = false;
	visitStmtCalls(stmt, callee => {
		if (callee === name) found = true;
	});
	return found;
}

function identifiersAreOnlyParams(expr: Expr, params: ReadonlySet<string>): boolean {
	let valid = true;
	visitVariableIdentifiers(expr, name => {
		if (!params.has(name)) valid = false;
	});
	return valid;
}

function maxParamUseCount(expr: Expr, params: ReadonlySet<string>): number {
	const counts = new Map<string, number>();
	visitVariableIdentifiers(expr, name => {
		if (params.has(name)) counts.set(name, (counts.get(name) ?? 0) + 1);
	});
	return Math.max(0, ...counts.values());
}

function visitVariableIdentifiers(expr: Expr, visit: (name: string) => void): void {
	switch (expr.kind) {
		case 'ErrorExpr':
		case 'StringLiteral':
		case 'NumberLiteral':
			return;
		case 'Identifier':
			visit(expr.name);
			return;
		case 'Call':
			if (expr.callee.kind !== 'Identifier') visitVariableIdentifiers(expr.callee, visit);
			for (const arg of expr.args) visitVariableIdentifiers(arg, visit);
			return;
		case 'Member':
			visitVariableIdentifiers(expr.object, visit);
			return;
		case 'Unary':
			visitVariableIdentifiers(expr.argument, visit);
			return;
		case 'Binary':
			visitVariableIdentifiers(expr.left, visit);
			visitVariableIdentifiers(expr.right, visit);
			return;
		case 'Cast':
			visitVariableIdentifiers(expr.argument, visit);
			return;
		case 'Paren':
			visitVariableIdentifiers(expr.expression, visit);
			return;
		case 'ListLiteral':
			for (const element of expr.elements) visitVariableIdentifiers(element, visit);
			return;
		case 'VectorLiteral':
			for (const element of expr.elements) visitVariableIdentifiers(element, visit);
			return;
		default:
			AssertNever(expr);
	}
}

function isSideEffectFreeInlineArg(expr: Expr): boolean {
	switch (expr.kind) {
		case 'ErrorExpr':
			return false;
		case 'StringLiteral':
		case 'NumberLiteral':
		case 'Identifier':
			return true;
		case 'Member':
			return isSideEffectFreeInlineArg(expr.object);
		case 'Unary':
			return expr.op !== '++' && expr.op !== '--' && isSideEffectFreeInlineArg(expr.argument);
		case 'Binary':
			return !isAssignmentOp(expr.op) && isSideEffectFreeInlineArg(expr.left) && isSideEffectFreeInlineArg(expr.right);
		case 'Cast':
			return isSideEffectFreeInlineArg(expr.argument);
		case 'Paren':
			return isSideEffectFreeInlineArg(expr.expression);
		case 'ListLiteral':
			return expr.elements.every(isSideEffectFreeInlineArg);
		case 'VectorLiteral':
			return expr.elements.every(isSideEffectFreeInlineArg);
		case 'Call':
			return expr.callee.kind === 'Identifier' && isImplementedRuntimeFunction(expr.callee.name) && expr.args.every(isSideEffectFreeInlineArg);
		default:
			AssertNever(expr);
			return false;
	}
}

function substituteParamsInStmt(stmt: Stmt, replacements: ReadonlyMap<string, Expr>): Stmt {
	switch (stmt.kind) {
		case 'EmptyStmt':
		case 'ErrorStmt':
		case 'LabelStmt':
		case 'StateChangeStmt':
			return stmt;
		case 'ExprStmt':
			return { ...stmt, expression: substituteParams(stmt.expression, replacements) };
		case 'VarDecl':
			return { ...stmt, initializer: stmt.initializer ? substituteParams(stmt.initializer, replacements) : undefined };
		case 'ReturnStmt':
			return { ...stmt, expression: stmt.expression ? substituteParams(stmt.expression, replacements) : undefined };
		case 'IfStmt':
			return { ...stmt, condition: substituteParams(stmt.condition, replacements), then: substituteParamsInStmt(stmt.then, replacements), else: stmt.else ? substituteParamsInStmt(stmt.else, replacements) : undefined };
		case 'WhileStmt':
			return { ...stmt, condition: substituteParams(stmt.condition, replacements), body: substituteParamsInStmt(stmt.body, replacements) };
		case 'DoWhileStmt':
			return { ...stmt, body: substituteParamsInStmt(stmt.body, replacements), condition: substituteParams(stmt.condition, replacements) };
		case 'ForStmt':
			return {
				...stmt,
				init: stmt.init ? substituteParams(stmt.init, replacements) : undefined,
				condition: stmt.condition ? substituteParams(stmt.condition, replacements) : undefined,
				update: stmt.update ? substituteParams(stmt.update, replacements) : undefined,
				body: substituteParamsInStmt(stmt.body, replacements),
			};
		case 'BlockStmt':
			return { ...stmt, statements: stmt.statements.map(child => substituteParamsInStmt(child, replacements)) };
		case 'JumpStmt':
			return { ...stmt, target: substituteParams(stmt.target, replacements) };
		default:
			AssertNever(stmt);
			return stmt;
	}
}

function replaceSpecializedCallsInStmt(stmt: Stmt, candidate: SpecializationCandidate): Stmt {
	switch (stmt.kind) {
		case 'EmptyStmt':
		case 'ErrorStmt':
		case 'LabelStmt':
		case 'StateChangeStmt':
			return stmt;
		case 'ExprStmt':
			return { ...stmt, expression: replaceSpecializedCallsInExpr(stmt.expression, candidate) };
		case 'VarDecl':
			return { ...stmt, initializer: stmt.initializer ? replaceSpecializedCallsInExpr(stmt.initializer, candidate) : undefined };
		case 'ReturnStmt':
			return { ...stmt, expression: stmt.expression ? replaceSpecializedCallsInExpr(stmt.expression, candidate) : undefined };
		case 'IfStmt':
			return { ...stmt, condition: replaceSpecializedCallsInExpr(stmt.condition, candidate), then: replaceSpecializedCallsInStmt(stmt.then, candidate), else: stmt.else ? replaceSpecializedCallsInStmt(stmt.else, candidate) : undefined };
		case 'WhileStmt':
			return { ...stmt, condition: replaceSpecializedCallsInExpr(stmt.condition, candidate), body: replaceSpecializedCallsInStmt(stmt.body, candidate) };
		case 'DoWhileStmt':
			return { ...stmt, body: replaceSpecializedCallsInStmt(stmt.body, candidate), condition: replaceSpecializedCallsInExpr(stmt.condition, candidate) };
		case 'ForStmt':
			return {
				...stmt,
				init: stmt.init ? replaceSpecializedCallsInExpr(stmt.init, candidate) : undefined,
				condition: stmt.condition ? replaceSpecializedCallsInExpr(stmt.condition, candidate) : undefined,
				update: stmt.update ? replaceSpecializedCallsInExpr(stmt.update, candidate) : undefined,
				body: replaceSpecializedCallsInStmt(stmt.body, candidate),
			};
		case 'BlockStmt':
			return { ...stmt, statements: stmt.statements.map(child => replaceSpecializedCallsInStmt(child, candidate)) };
		case 'JumpStmt':
			return { ...stmt, target: replaceSpecializedCallsInExpr(stmt.target, candidate) };
		default:
			AssertNever(stmt);
			return stmt;
	}
}

function replaceSpecializedCallsInExpr(expr: Expr, candidate: SpecializationCandidate): Expr {
	switch (expr.kind) {
		case 'ErrorExpr':
		case 'StringLiteral':
		case 'NumberLiteral':
		case 'Identifier':
			return expr;
		case 'Member':
			return { ...expr, object: replaceSpecializedCallsInExpr(expr.object, candidate) };
		case 'Unary':
			return { ...expr, argument: replaceSpecializedCallsInExpr(expr.argument, candidate) };
		case 'Binary':
			return { ...expr, left: replaceSpecializedCallsInExpr(expr.left, candidate), right: replaceSpecializedCallsInExpr(expr.right, candidate) };
		case 'Cast':
			return { ...expr, argument: replaceSpecializedCallsInExpr(expr.argument, candidate) };
		case 'Paren':
			return { ...expr, expression: replaceSpecializedCallsInExpr(expr.expression, candidate) };
		case 'ListLiteral':
			return { ...expr, elements: expr.elements.map(element => replaceSpecializedCallsInExpr(element, candidate)) };
		case 'VectorLiteral':
			return { ...expr, elements: expr.elements.map(element => replaceSpecializedCallsInExpr(element, candidate)) as Expr[] as ExprTuple<typeof expr.elements> };
		case 'Call': {
			const callee = expr.callee.kind === 'Identifier' ? expr.callee : replaceSpecializedCallsInExpr(expr.callee, candidate);
			const args = expr.args.map(arg => replaceSpecializedCallsInExpr(arg, candidate));
			if (callee.kind === 'Identifier' && callee.name === candidate.sourceName && callMatchesSpecialization(args, candidate)) {
				return {
					...expr,
					callee: { ...callee, name: candidate.targetName },
					args: args.filter((_, index) => !candidate.fixed.has(index)),
				};
			}
			return { ...expr, callee, args };
		}
		default:
			AssertNever(expr);
			return expr;
	}
}

function callMatchesSpecialization(args: readonly Expr[], candidate: SpecializationCandidate): boolean {
	for (const [index, expr] of candidate.fixed) {
		const arg = args[index];
		if (!arg || emitExpr(arg) !== emitExpr(expr)) return false;
	}
	return true;
}

function substituteParams(expr: Expr, replacements: ReadonlyMap<string, Expr>): Expr {
	switch (expr.kind) {
		case 'ErrorExpr':
		case 'StringLiteral':
		case 'NumberLiteral':
			return expr;
		case 'Identifier':
			return replacements.get(expr.name) ?? expr;
		case 'Call':
			return {
				...expr,
				callee: expr.callee.kind === 'Identifier' ? expr.callee : substituteParams(expr.callee, replacements),
				args: expr.args.map(arg => substituteParams(arg, replacements)),
			};
		case 'Member':
			return { ...expr, object: substituteParams(expr.object, replacements) };
		case 'Unary':
			return { ...expr, argument: substituteParams(expr.argument, replacements) };
		case 'Binary':
			return { ...expr, left: substituteParams(expr.left, replacements), right: substituteParams(expr.right, replacements) };
		case 'Cast':
			return { ...expr, argument: substituteParams(expr.argument, replacements) };
		case 'Paren':
			return { ...expr, expression: substituteParams(expr.expression, replacements) };
		case 'ListLiteral':
			return { ...expr, elements: expr.elements.map(element => substituteParams(element, replacements)) };
		case 'VectorLiteral':
			return { ...expr, elements: expr.elements.map(element => substituteParams(element, replacements)) as Expr[] as ExprTuple<typeof expr.elements> };
		default:
			AssertNever(expr);
			return expr;
	}
}

function isEmptyStmt(stmt: Stmt): boolean {
	return stmt.kind === 'EmptyStmt' || (stmt.kind === 'BlockStmt' && stmt.statements.length === 0);
}

function isLiteralFalse(expr: Expr): boolean {
	switch (expr.kind) {
		case 'NumberLiteral':
			return Number(expr.raw) === 0;
		case 'StringLiteral':
			return expr.value === '';
		case 'ListLiteral':
			return expr.elements.length === 0;
		case 'VectorLiteral':
			return expr.elements.every(element => element.kind === 'NumberLiteral' && Number(element.raw) === 0);
		case 'Cast':
		case 'Paren':
			return isLiteralFalse(expr.kind === 'Cast' ? expr.argument : expr.expression);
		default:
			return false;
	}
}

function isSideEffectFreeExpr(expr: Expr, pureFunctions: ReadonlySet<string>, noOpFunctions: ReadonlySet<string>): boolean {
	switch (expr.kind) {
		case 'ErrorExpr':
			return false;
		case 'StringLiteral':
		case 'NumberLiteral':
		case 'Identifier':
			return true;
		case 'Member':
			return isSideEffectFreeExpr(expr.object, pureFunctions, noOpFunctions);
		case 'Unary':
			return expr.op !== '++' && expr.op !== '--' && isSideEffectFreeExpr(expr.argument, pureFunctions, noOpFunctions);
		case 'Binary':
			return !isAssignmentOp(expr.op) && isSideEffectFreeExpr(expr.left, pureFunctions, noOpFunctions) && isSideEffectFreeExpr(expr.right, pureFunctions, noOpFunctions);
		case 'Cast':
			return isSideEffectFreeExpr(expr.argument, pureFunctions, noOpFunctions);
		case 'Paren':
			return isSideEffectFreeExpr(expr.expression, pureFunctions, noOpFunctions);
		case 'ListLiteral':
			return expr.elements.every(element => isSideEffectFreeExpr(element, pureFunctions, noOpFunctions));
		case 'VectorLiteral':
			return expr.elements.every(element => isSideEffectFreeExpr(element, pureFunctions, noOpFunctions));
		case 'Call':
			return expr.callee.kind === 'Identifier'
				&& (isImplementedRuntimeFunction(expr.callee.name) || pureFunctions.has(expr.callee.name) || noOpFunctions.has(expr.callee.name))
				&& expr.args.every(arg => isSideEffectFreeExpr(arg, pureFunctions, noOpFunctions));
		default:
			AssertNever(expr);
			return false;
	}
}

function collectMentionedInStmt(stmt: Stmt, mentioned: Set<string>): void {
	switch (stmt.kind) {
		case 'EmptyStmt':
		case 'ErrorStmt':
		case 'LabelStmt':
		case 'StateChangeStmt':
			return;
		case 'ExprStmt':
			visitVariableIdentifiers(stmt.expression, name => mentioned.add(name));
			return;
		case 'VarDecl':
			if (stmt.initializer) visitVariableIdentifiers(stmt.initializer, name => mentioned.add(name));
			return;
		case 'ReturnStmt':
			if (stmt.expression) visitVariableIdentifiers(stmt.expression, name => mentioned.add(name));
			return;
		case 'IfStmt':
			visitVariableIdentifiers(stmt.condition, name => mentioned.add(name));
			collectMentionedInStmt(stmt.then, mentioned);
			if (stmt.else) collectMentionedInStmt(stmt.else, mentioned);
			return;
		case 'WhileStmt':
			visitVariableIdentifiers(stmt.condition, name => mentioned.add(name));
			collectMentionedInStmt(stmt.body, mentioned);
			return;
		case 'DoWhileStmt':
			collectMentionedInStmt(stmt.body, mentioned);
			visitVariableIdentifiers(stmt.condition, name => mentioned.add(name));
			return;
		case 'ForStmt':
			if (stmt.init) visitVariableIdentifiers(stmt.init, name => mentioned.add(name));
			if (stmt.condition) visitVariableIdentifiers(stmt.condition, name => mentioned.add(name));
			if (stmt.update) visitVariableIdentifiers(stmt.update, name => mentioned.add(name));
			collectMentionedInStmt(stmt.body, mentioned);
			return;
		case 'BlockStmt':
			for (const child of stmt.statements) collectMentionedInStmt(child, mentioned);
			return;
		case 'JumpStmt':
			visitVariableIdentifiers(stmt.target, name => mentioned.add(name));
			return;
		default:
			AssertNever(stmt);
	}
}


function constantTruth(expr: Expr, constantEnv: Env): boolean | null {
	if (!isFoldCandidateExpr(expr)) return null;
	const value = evalExpr(expr, constantEnv, { allowRuntimeCalls: true });
	if (value.kind !== 'value') return null;
	switch (value.type) {
		case 'integer':
		case 'float':
			return Math.trunc(value.value) !== 0;
		case 'string':
			return value.value.length !== 0;
		case 'key':
			return value.value !== '' && value.value !== '00000000-0000-0000-0000-000000000000';
		case 'vector':
		case 'rotation':
			return value.value.some(component => component !== 0);
		case 'list':
			return value.value.length !== 0;
		default:
			AssertNever(value);
			return null;
	}
}

function valueToExpr(value: Value, original: Expr): Expr | null {
	if (value.kind !== 'value') return null;
	switch (value.type) {
		case 'integer':
			return { ...original, kind: 'NumberLiteral', raw: String(Math.trunc(value.value)) };
		case 'float':
			if (!Number.isFinite(value.value)) return null;
			return { ...original, kind: 'NumberLiteral', raw: floatLiteral(value.value) };
		case 'string':
			return { ...original, kind: 'StringLiteral', value: value.value };
		case 'key':
			return { ...original, kind: 'Cast', type: 'key', argument: { ...original, kind: 'StringLiteral', value: value.value } };
		case 'vector':
			return {
				...original,
				kind: 'VectorLiteral',
				elements: value.value.map(component => ({ ...original, kind: 'NumberLiteral', raw: floatLiteral(component) })) as [Expr, Expr, Expr],
			};
		case 'rotation':
			return {
				...original,
				kind: 'VectorLiteral',
				elements: value.value.map(component => ({ ...original, kind: 'NumberLiteral', raw: floatLiteral(component) })) as [Expr, Expr, Expr, Expr],
			};
		case 'list':
			return null;
		default:
			AssertNever(value);
			return null;
	}
}

function floatLiteral(value: number): string {
	if (Object.is(value, -0)) return '-0.0';
	if (Number.isInteger(value)) return `${value}.0`;
	return String(value);
}

function globalSymbolTypes(script: Script): Map<string, SimpleType> {
	const out = new Map<string, SimpleType>();
	for (const [name, global] of script.globals) out.set(name, global.varType);
	return out;
}

function functionTypes(script: Script, builtins: ReadonlyMap<string, SimpleType> = new Map()): ReadonlyMap<string, SimpleType> {
	const out = new Map(builtins);
	for (const [name, fn] of script.functions) out.set(name, fn.returnType ?? 'void');
	return out;
}

function evalFunctionTypes(types: ReadonlyMap<string, SimpleType>): Map<string, Type | 'void'> {
	const out = new Map<string, Type | 'void'>();
	for (const [name, type] of types) {
		if (type !== 'any') out.set(name, type);
	}
	return out;
}

class TypeScope {
	private readonly local = new Map<string, SimpleType>();

	constructor(
		private readonly parent?: TypeScope,
		private readonly base: ReadonlyMap<string, SimpleType> = new Map(),
	) { }

	child(): TypeScope {
		return new TypeScope(this, this.base);
	}

	set(name: string, type: SimpleType): void {
		this.local.set(name, type);
	}

	view(): Map<string, SimpleType> {
		const out = this.parent?.view() ?? new Map(this.base);
		for (const [name, type] of this.local) out.set(name, type);
		return out;
	}
}

function mapValues<T, U>(input: ReadonlyMap<string, T>, fn: (value: T) => U): Map<string, U> {
	const out = new Map<string, U>();
	for (const [key, value] of input) out.set(key, fn(value));
	return out;
}
