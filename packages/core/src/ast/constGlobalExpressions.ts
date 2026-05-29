import type { Script, GlobalVar, Expr, Type } from './types';
import { Env, evalExpr, type EvalOptions } from './eval';
import type { Value } from './runtime';
import type { DynamicMacros } from '../core/preproc';
import type { Defs } from '../defs';
import { normalizeType } from '../defs';
import { AssertNever } from '../utils';

export interface ConstGlobalExpressionOptions {
	builtinConstants?: ReadonlyMap<string, Value>;
	dynamicMacros?: DynamicMacros;
}

const EVAL_OPTIONS: EvalOptions = {
	maxNodes: 500,
	maxDepth: 64,
	maxLoopIters: 128,
	allowRuntimeCalls: true,
};

export function foldConstGlobalExpressions(script: Script, opts: ConstGlobalExpressionOptions = {}): Script {
	const env = new Env(new Map(opts.builtinConstants ?? []));
	for (const [name, type] of Object.entries(opts.dynamicMacros ?? {})) {
		env.setVar(name, { kind: 'unknown', type });
	}

	let changed = false;
	const globals = new Map<string, GlobalVar>();
	for (const [name, global] of script.globals) {
		let next = global;
		if (global.initializer && isFoldCandidateExpr(global.initializer)) {
			const value = evalExpr(global.initializer, env, EVAL_OPTIONS);
			const folded = valueToExpr(value, global.initializer, global.varType);
			if (folded) {
				next = { ...global, initializer: folded };
				changed = changed || folded !== global.initializer;
			}
		}
		globals.set(name, next);
		if (next.initializer) {
			env.setVar(name, evalExpr(next.initializer, env, EVAL_OPTIONS));
		}
	}

	return changed ? { ...script, globals } : script;
}

export function builtinConstantValuesFromDefs(defs: Pick<Defs, 'consts'>): ReadonlyMap<string, Value> {
	const out = new Map<string, Value>();
	for (const [name, constant] of defs.consts) {
		const value = constant.value;
		switch (normalizeType(constant.type)) {
			case 'integer':
				if (typeof value === 'number' || typeof value === 'boolean') {
					out.set(name, { kind: 'value', type: 'integer', value: Number(value) | 0 });
				}
				break;
			case 'float':
				if (typeof value === 'number') {
					out.set(name, { kind: 'value', type: 'float', value });
				}
				break;
			case 'string':
			case 'key':
				if (typeof value === 'string' && isFoldableBuiltinStringValue(value)) {
					out.set(name, { kind: 'value', type: normalizeType(constant.type) as 'string' | 'key', value });
				}
				break;
			default:
				break;
		}
	}
	return out;
}

function isFoldableBuiltinStringValue(value: string): boolean {
	// The official YAML stores EOF, NAK, and JSON sentinel constants as escaped
	// source text. Folding those identifiers would emit the escape text itself.
	return !value.includes('\\');
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
			return isFoldCandidateExpr(expr.argument);
		case 'Paren':
			return isFoldCandidateExpr(expr.expression);
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

function valueToExpr(value: Value, original: Expr, targetType: Type): Expr | null {
	if (value.kind !== 'value') return null;
	switch (value.type) {
		case 'integer':
			return { span: original.span, kind: 'NumberLiteral', raw: String(Math.trunc(value.value)) };
		case 'float':
			if (!Number.isFinite(value.value)) return null;
			return { span: original.span, kind: 'NumberLiteral', raw: floatLiteral(value.value) };
		case 'string':
			return { span: original.span, kind: 'StringLiteral', value: value.value };
		case 'key':
			return { span: original.span, kind: 'StringLiteral', value: value.value };
		case 'vector':
			if (targetType !== 'vector' && targetType !== 'list') return null;
			return {
				span: original.span,
				kind: 'VectorLiteral',
				elements: value.value.map(component => numberExpr(original, component)) as [Expr, Expr, Expr],
			};
		case 'rotation':
			if (targetType !== 'rotation' && targetType !== 'list') return null;
			return {
				span: original.span,
				kind: 'VectorLiteral',
				elements: value.value.map(component => numberExpr(original, component)) as [Expr, Expr, Expr, Expr],
			};
		case 'list': {
			if (targetType !== 'list') return null;
			const elements: Expr[] = [];
			for (const element of value.value) {
				const expr = valueToExpr(element, original, element.kind === 'value' ? element.type : 'integer');
				if (!expr) return null;
				elements.push(expr);
			}
			return { span: original.span, kind: 'ListLiteral', elements };
		}
		default:
			AssertNever(value);
			return null;
	}
}

function numberExpr(original: Expr, value: number): Expr {
	return { span: original.span, kind: 'NumberLiteral', raw: floatLiteral(value) };
}

function floatLiteral(value: number): string {
	if (Object.is(value, -0)) return '-0.0';
	if (Number.isInteger(value)) return `${value}.0`;
	return String(value);
}
