import { describe, expect, it } from 'vitest';
import { optimizeScript, parseScriptFromText } from '../src';
import type { OptimizeOptions } from '../src';
import type { Expr, Script, Stmt } from '../src/ast/types';

type RuntimeValue = number | string;

interface RuntimeState {
	vars: Map<string, RuntimeValue>;
	trace: string[];
}

const VALIDATION_OPTIMIZE_OPTIONS: OptimizeOptions = {
	bitwiseBooleanOps: true,
	builtinFunctionReturnTypes: new Map([['llGetUnixTime', 'integer']]),
	integerPeepholes: true,
	maxPasses: 12,
};

const OPTION_MATRIX: Array<{ name: string; options: OptimizeOptions }> = [
	{ name: 'integer-peepholes', options: { integerPeepholes: true, maxPasses: 12 } },
	{ name: 'bitwise-boolean-ops', options: { bitwiseBooleanOps: true, maxPasses: 12 } },
	{ name: 'integer-and-bitwise', options: VALIDATION_OPTIMIZE_OPTIONS },
	{ name: 'without-constant-fold', options: { ...VALIDATION_OPTIMIZE_OPTIONS, constantFold: false } },
	{ name: 'cli-like-shape', options: { ...VALIDATION_OPTIMIZE_OPTIONS, dropDefaultInitializers: true, inlineConstantGlobals: true } },
];

describe('optimizer semantic equivalence', () => {
	it('preserves generated integer-control observable traces', () => {
		for (const { name, options } of OPTION_MATRIX) {
			for (let seed = 1; seed <= 120; seed++) {
				const source = generatedProgram(seed);
				const original = parseScriptFromText(source, `file:///generated-${name}-${seed}.lsl`);
				expect(blockingDiagnostics(original), `source diagnostics for ${name} seed ${seed}`).toEqual([]);

				const optimized = optimizeScript(original, options);
				expect(optimized.stable, `optimizer stability for ${name} seed ${seed}`).toBe(true);

				const optimizedScript = parseScriptFromText(optimized.code, `file:///generated-${name}-${seed}.optimized.lsl`);
				expect(blockingDiagnostics(optimizedScript), `optimized diagnostics for ${name} seed ${seed}`).toEqual([]);
				expect(runStateEntry(optimizedScript), `trace mismatch for ${name} seed ${seed}\n${source}\n${optimized.code}`).toEqual(runStateEntry(original));
				expect(optimizeScript(optimizedScript, options).code, `re-optimized output for ${name} seed ${seed}`).toBe(optimized.code);
			}
		}
	}, 10000);

	it('preserves side-effecting eager logical condition traces', () => {
		const cases = [
			'eagerAndFalse',
			'eagerOrTrue',
			'eagerAndTrue',
			'eagerOrFalse',
			'nestedBranchInversion',
		];
		for (const name of cases) {
			const source = sideEffectProgram(name);
			const original = parseScriptFromText(source, `file:///side-effect-${name}.lsl`);
			expect(blockingDiagnostics(original), `source diagnostics for ${name}`).toEqual([]);
			for (const { name: optionName, options } of OPTION_MATRIX) {
				const optimized = optimizeScript(original, options);
				expect(optimized.stable, `optimizer stability for ${optionName} ${name}`).toBe(true);
				const optimizedScript = parseScriptFromText(optimized.code, `file:///side-effect-${optionName}-${name}.optimized.lsl`);
				expect(blockingDiagnostics(optimizedScript), `optimized diagnostics for ${optionName} ${name}`).toEqual([]);
				expect(runStateEntry(optimizedScript), `trace mismatch for ${optionName} ${name}\n${source}\n${optimized.code}`).toEqual(runStateEntry(original));
			}
		}
	});

	it('would catch dangling else drift after integer branch inversion', () => {
		const source = [
			'default { state_entry() {',
			'  integer value = 1;',
			'  if (value == 1) {',
			'    llOwnerSay("add");',
			'  } else if (value == 3) {',
			'    llOwnerSay("main");',
			'  }',
			'} }',
		].join('\n');
		const optimized = optimizeScript(parseScriptFromText(source), { integerPeepholes: true });
		expect(runStateEntry(parseScriptFromText(optimized.code))).toEqual(['add']);
	});

	it('preserves statement-inline argument evaluation order', () => {
		const source = [
			'inlineMe(integer left, integer right) {',
			'  llOwnerSay((string)left + ":" + (string)right);',
			'}',
			'integer mark(string label, integer value) {',
			'  llOwnerSay(label);',
			'  return value;',
			'}',
			'default { state_entry() {',
			'  inlineMe(mark("left", 1), mark("right", 2));',
			'} }',
		].join('\n');
		const optimized = optimizeScript(parseScriptFromText(source), { inlineFunctions: true, removeUnusedFunctions: true, maxPasses: 12 });
		expect(optimized.code).not.toContain('inlineMe');
		expect(runStateEntry(parseScriptFromText(optimized.code))).toEqual(['left', 'right', '1:2']);
	});
});

function blockingDiagnostics(script: Script) {
	return script.diagnostics?.filter(diagnostic => diagnostic.severity !== 'warning' && diagnostic.severity !== 'info') ?? [];
}

function runStateEntry(script: Script): string[] {
	const event = script.states.get('default')?.events.find(candidate => candidate.name === 'state_entry');
	if (!event) throw new Error('missing default.state_entry');
	const state: RuntimeState = { vars: new Map(), trace: [] };
	for (const global of script.globals.values()) {
		state.vars.set(global.name, global.initializer ? evalExprValue(global.initializer, state) : defaultValue(global.varType));
	}
	execStmt(event.body, state);
	return state.trace;
}

function execStmt(stmt: Stmt, state: RuntimeState): void {
	switch (stmt.kind) {
		case 'EmptyStmt':
		case 'ErrorStmt':
		case 'LabelStmt':
			return;
		case 'BlockStmt':
			for (const child of stmt.statements) execStmt(child, state);
			return;
		case 'VarDecl':
			state.vars.set(stmt.name, stmt.initializer ? evalExprValue(stmt.initializer, state) : defaultValue(stmt.varType));
			return;
		case 'ExprStmt':
			evalExprValue(stmt.expression, state);
			return;
		case 'IfStmt':
			execStmt(truthy(evalExprValue(stmt.condition, state)) ? stmt.then : stmt.else ?? { ...stmt, kind: 'EmptyStmt' }, state);
			return;
		case 'ReturnStmt':
			return;
		case 'StateChangeStmt':
		case 'JumpStmt':
		case 'WhileStmt':
		case 'DoWhileStmt':
		case 'ForStmt':
			throw new Error(`unsupported generated statement ${stmt.kind}`);
		default:
			stmt satisfies never;
	}
}

function evalExprValue(expr: Expr, state: RuntimeState): RuntimeValue {
	switch (expr.kind) {
		case 'NumberLiteral':
			return Math.trunc(Number(expr.raw));
		case 'StringLiteral':
			return expr.value;
		case 'Identifier':
			if (!state.vars.has(expr.name)) throw new Error(`unknown runtime variable ${expr.name}`);
			return state.vars.get(expr.name)!;
		case 'Paren':
			return evalExprValue(expr.expression, state);
		case 'Cast':
			return castValue(expr.type, evalExprValue(expr.argument, state));
		case 'Unary': {
			if ((expr.op === '++' || expr.op === '--') && expr.argument.kind === 'Identifier') {
				const current = asInteger(state.vars.get(expr.argument.name) ?? 0);
				const next = expr.op === '++' ? current + 1 : current - 1;
				state.vars.set(expr.argument.name, next);
				return expr.postfix ? current : next;
			}
			const value = evalExprValue(expr.argument, state);
			if (expr.op === '!') return truthy(value) ? 0 : 1;
			if (expr.op === '~') return ~asInteger(value);
			if (expr.op === '-') return -asInteger(value);
			if (expr.op === '+') return asInteger(value);
			throw new Error(`unsupported generated unary operator ${expr.op}`);
		}
		case 'Binary':
			if (expr.op === '=') {
				if (expr.left.kind !== 'Identifier') throw new Error('unsupported assignment target');
				const value = evalExprValue(expr.right, state);
				state.vars.set(expr.left.name, value);
				return value;
			}
			return evalBinary(expr, state);
		case 'Call':
			if (expr.callee.kind === 'Identifier' && expr.callee.name === 'llOwnerSay') {
				state.trace.push(asString(evalExprValue(expr.args[0]!, state)));
				return 0;
			}
			if (expr.callee.kind === 'Identifier' && expr.callee.name === 'mark') {
				state.trace.push(asString(evalExprValue(expr.args[0]!, state)));
				return asInteger(evalExprValue(expr.args[1]!, state));
			}
			if (expr.callee.kind === 'Identifier' && expr.callee.name === 'llGetUnixTime') return 17;
			throw new Error(`unsupported generated call ${expr.callee.kind === 'Identifier' ? expr.callee.name : expr.callee.kind}`);
		case 'ErrorExpr':
		case 'ListLiteral':
		case 'Member':
		case 'VectorLiteral':
			throw new Error(`unsupported generated expression ${expr.kind}`);
		default:
			expr satisfies never;
			throw new Error('unreachable');
	}
}

function evalBinary(expr: Extract<Expr, { kind: 'Binary' }>, state: RuntimeState): RuntimeValue {
	if (expr.op === '&&') {
		const right = evalExprValue(expr.right, state);
		const left = evalExprValue(expr.left, state);
		return truthy(left) && truthy(right) ? 1 : 0;
	}
	if (expr.op === '||') {
		const right = evalExprValue(expr.right, state);
		const left = evalExprValue(expr.left, state);
		return truthy(left) || truthy(right) ? 1 : 0;
	}
	const right = evalExprValue(expr.right, state);
	const left = evalExprValue(expr.left, state);
	if (expr.op === '+' && (typeof left === 'string' || typeof right === 'string')) return asString(left) + asString(right);
	const a = asInteger(left);
	const b = asInteger(right);
	switch (expr.op) {
		case '+': return a + b;
		case '-': return a - b;
		case '*': return a * b;
		case '/': return b === 0 ? 0 : Math.trunc(a / b);
		case '%': return b === 0 ? 0 : a % b;
		case '&': return a & b;
		case '|': return a | b;
		case '^': return a ^ b;
		case '==': return a === b ? 1 : 0;
		case '!=': return a !== b ? 1 : 0;
		case '<': return a < b ? 1 : 0;
		case '<=': return a <= b ? 1 : 0;
		case '>': return a > b ? 1 : 0;
		case '>=': return a >= b ? 1 : 0;
		default:
			throw new Error(`unsupported generated binary operator ${expr.op}`);
	}
}

function castValue(type: string, value: RuntimeValue): RuntimeValue {
	if (type === 'integer') return asInteger(value);
	if (type === 'string') return asString(value);
	throw new Error(`unsupported generated cast ${type}`);
}

function asInteger(value: RuntimeValue): number {
	return typeof value === 'number' ? Math.trunc(value) : Math.trunc(Number(value)) || 0;
}

function asString(value: RuntimeValue): string {
	return typeof value === 'string' ? value : String(Math.trunc(value));
}

function truthy(value: RuntimeValue): boolean {
	return typeof value === 'string' ? value.length > 0 : Math.trunc(value) !== 0;
}

function defaultValue(type: string): RuntimeValue {
	return type === 'string' ? '' : 0;
}

function generatedProgram(seed: number): string {
	const random = lcg(seed);
	const values = ['x', 'y', 'z'].map((_, index) => (nextInt(random, 11) - 5 + index * 3));
	const body = generatedStmtBlock(random, 0, `s${seed}`);
	return [
		'default { state_entry() {',
		`  integer x = ${values[0]};`,
		`  integer y = ${values[1]};`,
		`  integer z = ${values[2]};`,
		body,
		'  llOwnerSay((string)x + "|" + (string)y + "|" + (string)z);',
		'} }',
	].join('\n');
}

function sideEffectProgram(name: string): string {
	const condition = sideEffectCondition(name);
	return [
		'integer mark(string label, integer value) {',
		'  llOwnerSay(label);',
		'  return value;',
		'}',
		'default { state_entry() {',
		`  if (${condition}) {`,
		'    llOwnerSay("then");',
		'  } else {',
		'    llOwnerSay("else");',
		'  }',
		'} }',
	].join('\n');
}

function sideEffectCondition(name: string): string {
	switch (name) {
		case 'eagerAndFalse':
			return '(mark("a", 0) == 1) && (mark("b", 1) == 1)';
		case 'eagerOrTrue':
			return '(mark("a", 1) == 1) || (mark("b", 1) == 1)';
		case 'eagerAndTrue':
			return '(mark("a", 1) == 1) && (mark("b", 1) == 1)';
		case 'eagerOrFalse':
			return '(mark("a", 0) == 1) || (mark("b", 1) == 1)';
		case 'nestedBranchInversion':
			return '(mark("a", 1) == 1) == (mark("b", 1) == 1)';
		default:
			throw new Error(`unknown side-effect condition case ${name}`);
	}
}

function generatedStmtBlock(random: () => number, depth: number, tag: string): string {
	const lines: string[] = [];
	const count = depth >= 3 ? 1 : 2 + nextInt(random, 3);
	for (let index = 0; index < count; index++) {
		const choice = depth >= 3 ? nextInt(random, 2) : nextInt(random, 5);
		if (choice === 0) {
			const variable = pick(random, ['x', 'y', 'z']);
			const delta = nextInt(random, 7) - 3;
			lines.push(`  ${variable} = ${variable} + ${delta};`);
		} else if (choice === 1) {
			lines.push(`  llOwnerSay("${tag}.${depth}.${index}");`);
		} else {
			const condition = generatedCondition(random, 0);
			const thenLines = indent(generatedStmtBlock(random, depth + 1, `${tag}t${index}`));
			const elseLines = choice === 2
				? ` else if (${generatedCondition(random, 0)}) {\n${indent(generatedStmtBlock(random, depth + 1, `${tag}e${index}`))}\n  }`
				: ` else {\n${indent(generatedStmtBlock(random, depth + 1, `${tag}e${index}`))}\n  }`;
			lines.push(`  if (${condition}) {\n${thenLines}\n  }${elseLines}`);
		}
	}
	return lines.join('\n');
}

function generatedCondition(random: () => number, depth: number): string {
	if (depth > 2) return generatedComparison(random);
	const choice = nextInt(random, 8);
	if (choice === 0) return `!(${generatedCondition(random, depth + 1)})`;
	if (choice === 1) return `(${generatedCondition(random, depth + 1)}) && (${generatedCondition(random, depth + 1)})`;
	if (choice === 2) return `(${generatedCondition(random, depth + 1)}) || (${generatedCondition(random, depth + 1)})`;
	if (choice === 3) return `(${pick(random, ['x', 'y', 'z'])} ^ ${nextInt(random, 8) - 4})`;
	return generatedComparison(random);
}

function generatedComparison(random: () => number): string {
	const lhs = pick(random, ['x', 'y', 'z', 'llGetUnixTime()']);
	const op = pick(random, ['==', '!=', '<', '<=', '>', '>=']);
	const rhs = nextInt(random, 13) - 6;
	return `${lhs} ${op} ${rhs}`;
}

function indent(text: string): string {
	return text.split('\n').map(line => `  ${line}`).join('\n');
}

function pick<T>(random: () => number, values: T[]): T {
	return values[nextInt(random, values.length)]!;
}

function nextInt(random: () => number, max: number): number {
	return Math.floor(random() * max);
}

function lcg(seed: number): () => number {
	let state = seed >>> 0;
	return () => {
		state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
		return state / 0x100000000;
	};
}
