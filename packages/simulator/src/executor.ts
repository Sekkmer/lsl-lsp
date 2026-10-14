import {
	type Event,
	type Expr,
	type Function as LslFunction,
	type Script,
	type Stmt,
	type Type,
	type Value,
} from '@lsl-lsp/core';
import { parseNumberLiteral } from '@lsl-lsp/core/ast/numberLiteral';
import * as Runtime from '@lsl-lsp/core/ast/runtime';
import {
	NULL_KEY,
	asInteger,
	asNumber,
	asString,
	cloneValue,
	coerceValue,
	defaultValue,
	floatValue,
	intValue,
	isTruthy,
	keyValue,
	listValue,
	lslString,
	requireConcrete,
	rotationValue,
	stringValue,
	valueEquals,
	vectorValue,
} from './value.js';

export type BuiltinResult =
	| { handled: false }
	| { handled: true; value?: Value; delay?: number; stopped?: boolean };

export interface ExecutionHost {
	callBuiltin(name: string, args: Value[]): BuiltinResult;
}

export type ExecutionSuspension =
	| { kind: 'delay'; seconds: number }
	| { kind: 'stopped' };

type Execution<T> = Generator<ExecutionSuspension, T, void>;

export interface ExecuteOptions {
	maxInstructions?: number;
	constants?: ReadonlyMap<string, Value>;
}

export type ExecutionResult =
	| { kind: 'complete'; value?: Value }
	| { kind: 'state-change'; state: string }
	| { kind: 'reset' };

export class ScriptResetSignal {}

const DEFAULT_MAX_INSTRUCTIONS = 100_000;

const CONSTANTS = new Map<string, Value>([
	['TRUE', intValue(1)],
	['FALSE', intValue(0)],
	['PI', floatValue(Math.PI)],
	['TWO_PI', floatValue(Math.PI * 2)],
	['PI_BY_TWO', floatValue(Math.PI / 2)],
	['DEG_TO_RAD', floatValue(Math.PI / 180)],
	['RAD_TO_DEG', floatValue(180 / Math.PI)],
	['NULL_KEY', keyValue(NULL_KEY)],
	['ZERO_VECTOR', vectorValue([0, 0, 0])],
	['ZERO_ROTATION', rotationValue([0, 0, 0, 1])],
	['LINK_ROOT', intValue(1)],
	['LINK_SET', intValue(-1)],
	['LINK_ALL_OTHERS', intValue(-2)],
	['LINK_ALL_CHILDREN', intValue(-3)],
	['LINK_THIS', intValue(-4)],
	['STRING_TRIM_HEAD', intValue(1)],
	['STRING_TRIM_TAIL', intValue(2)],
	['STRING_TRIM', intValue(3)],
	['LINKSETDATA_RESET', intValue(0)],
	['LINKSETDATA_UPDATE', intValue(1)],
	['LINKSETDATA_DELETE', intValue(2)],
	['LINKSETDATA_MULTIDELETE', intValue(3)],
	['LINKSETDATA_OK', intValue(0)],
	['LINKSETDATA_EMEMORY', intValue(1)],
	['LINKSETDATA_ENOKEY', intValue(2)],
	['LINKSETDATA_EPROTECTED', intValue(3)],
	['LINKSETDATA_NOTFOUND', intValue(4)],
	['LINKSETDATA_NOUPDATE', intValue(5)],
	['PERMISSION_DEBIT', intValue(0x00002)],
	['PERMISSION_TAKE_CONTROLS', intValue(0x00004)],
	['PERMISSION_TRIGGER_ANIMATION', intValue(0x00010)],
	['PERMISSION_ATTACH', intValue(0x00020)],
	['PERMISSION_TRACK_CAMERA', intValue(0x00400)],
	['PERMISSION_CONTROL_CAMERA', intValue(0x00800)],
	['PERMISSION_TELEPORT', intValue(0x01000)],
	['CONTROL_FWD', intValue(0x00000001)],
	['AGENT', intValue(0x00000001)],
	['ACTIVE', intValue(0x00000002)],
	['PASSIVE', intValue(0x00000004)],
	['SCRIPTED', intValue(0x00000008)],
	['INVENTORY_NONE', intValue(-1)],
	['INVENTORY_SCRIPT', intValue(10)],
	['OBJECT_NAME', intValue(1)],
	['OBJECT_POS', intValue(3)],
	['OBJECT_ROT', intValue(4)],
	['OBJECT_ROOT', intValue(18)],
	['OBJECT_ATTACHED_POINT', intValue(19)],
	['PRIM_TEXT', intValue(26)],
	['PSYS_PART_FLAGS', intValue(0)],
	['PSYS_PART_START_COLOR', intValue(1)],
	['PSYS_PART_START_ALPHA', intValue(2)],
	['PSYS_PART_END_COLOR', intValue(3)],
	['PSYS_PART_END_ALPHA', intValue(4)],
	['PSYS_PART_START_SCALE', intValue(5)],
	['PSYS_PART_END_SCALE', intValue(6)],
	['PSYS_PART_MAX_AGE', intValue(7)],
	['PSYS_SRC_PATTERN', intValue(9)],
	['PSYS_SRC_TEXTURE', intValue(12)],
	['PSYS_SRC_BURST_RATE', intValue(13)],
	['PSYS_SRC_BURST_PART_COUNT', intValue(15)],
	['PSYS_SRC_MAX_AGE', intValue(19)],
	['PSYS_SRC_TARGET_KEY', intValue(20)],
	['PSYS_SRC_ACCEL', intValue(8)],
	['PSYS_PART_INTERP_COLOR_MASK', intValue(0x01)],
	['PSYS_PART_INTERP_SCALE_MASK', intValue(0x02)],
	['PSYS_PART_FOLLOW_SRC_MASK', intValue(0x10)],
	['PSYS_PART_FOLLOW_VELOCITY_MASK', intValue(0x20)],
	['PSYS_PART_TARGET_POS_MASK', intValue(0x40)],
	['PSYS_PART_EMISSIVE_MASK', intValue(0x100)],
	['PSYS_SRC_PATTERN_DROP', intValue(0x01)],
	['CHANGED_OWNER', intValue(0x00000080)],
	['CHANGED_REGION', intValue(0x00000100)],
	['CHANGED_TELEPORT', intValue(0x00000200)],
	['JSON_INVALID', stringValue('\uFDD0')],
	['JSON_OBJECT', stringValue('\uFDD1')],
	['JSON_ARRAY', stringValue('\uFDD2')],
	['JSON_NUMBER', stringValue('\uFDD3')],
	['JSON_STRING', stringValue('\uFDD4')],
	['JSON_NULL', stringValue('\uFDD5')],
	['JSON_TRUE', stringValue('\uFDD6')],
	['JSON_FALSE', stringValue('\uFDD7')],
]);

class Scope {
	private readonly values = new Map<string, Value>();

	constructor(private readonly parent?: Scope) {}

	define(name: string, value: Value): void {
		this.values.set(name, cloneValue(value));
	}

	hasOwn(name: string): boolean {
		return this.values.has(name);
	}

	get(name: string): Value | undefined {
		const value = this.values.get(name) ?? this.parent?.get(name);
		return value ? cloneValue(value) : undefined;
	}

	set(name: string, value: Value): boolean {
		if (this.values.has(name)) {
			this.values.set(name, cloneValue(value));
			return true;
		}
		return this.parent?.set(name, value) ?? false;
	}

	entries(): IterableIterator<[string, Value]> {
		return this.values.entries();
	}
}

class ReturnSignal {
	constructor(readonly value?: Value) {}
}

class StateSignal {
	constructor(readonly state: string) {}
}

class JumpSignal {
	constructor(readonly label: string) {}
}

type LValue =
	| { kind: 'variable'; name: string; value: Value }
	| { kind: 'member'; name: string; property: string; value: Value };

type RuntimeFunction = (...args: Value[]) => Value;

export class ScriptExecutor {
	private globals = new Scope();
	private instructions = 0;
	private readonly maxInstructions: number;
	private readonly constants: ReadonlyMap<string, Value>;

	constructor(
		readonly script: Script,
		private readonly host: ExecutionHost,
		options: ExecuteOptions = {},
	) {
		this.maxInstructions = options.maxInstructions ?? DEFAULT_MAX_INSTRUCTIONS;
		this.constants = options.constants ?? CONSTANTS;
		this.initializeGlobals();
	}

	reset(): void {
		this.globals = new Scope();
		this.initializeGlobals();
	}

	getGlobal(name: string): Value | undefined {
		return this.globals.get(name);
	}

	setGlobal(name: string, value: Value): void {
		if (!this.globals.set(name, value)) throw new Error(`unknown global ${name}`);
	}

	*beginEvent(event: Event, args: Value[]): Execution<ExecutionResult> {
		this.instructions = 0;
		const scope = new Scope(this.globals);
		let index = 0;
		for (const [name, type] of event.parameters) {
			scope.define(name, coerceValue(args[index] ?? defaultValue(type), type));
			index += 1;
		}
		try {
			yield* this.executeStatement(event.body, scope);
			return { kind: 'complete' };
		} catch (signal) {
			if (signal instanceof ReturnSignal) return { kind: 'complete', value: signal.value };
			if (signal instanceof StateSignal) {
				if (event.name === 'state_exit') {
					throw new Error('state changes inside state_exit are not simulated', { cause: signal });
				}
				return { kind: 'state-change', state: signal.state };
			}
			if (signal instanceof ScriptResetSignal) return { kind: 'reset' };
			throw signal;
		}
	}

	/** Execute a delay-free event synchronously. Worlds should use beginEvent. */
	runEvent(event: Event, args: Value[]): ExecutionResult {
		const execution = this.beginEvent(event, args);
		const result = execution.next();
		if (!result.done) throw new Error('event suspended; use beginEvent with a virtual-time scheduler');
		return result.value;
	}

	private initializeGlobals(): void {
		for (const global of this.script.globals.values()) {
			const initial = global.initializer
				? coerceValue(this.evaluateGlobal(global.initializer), global.varType)
				: defaultValue(global.varType);
			this.globals.define(global.name, initial);
		}
	}

	private evaluateGlobal(expression: Expr): Value {
		const result = this.evaluate(expression, this.globals).next();
		if (!result.done) throw new Error('global initializers cannot suspend');
		return result.value;
	}

	private tick(): void {
		this.instructions += 1;
		if (this.instructions > this.maxInstructions) {
			throw new Error(`script exceeded ${this.maxInstructions} simulated instructions`);
		}
	}

	private *executeStatement(statement: Stmt, scope: Scope): Execution<void> {
		this.tick();
		switch (statement.kind) {
			case 'EmptyStmt':
			case 'LabelStmt':
				return;
			case 'ErrorStmt':
				throw new Error('cannot execute a parser error statement');
			case 'ExprStmt':
				yield* this.evaluate(statement.expression, scope);
				return;
			case 'VarDecl':
				scope.define(
					statement.name,
					statement.initializer
						? coerceValue(yield* this.evaluate(statement.initializer, scope), statement.varType)
						: defaultValue(statement.varType),
				);
				return;
			case 'ReturnStmt':
				throw new ReturnSignal(statement.expression ? yield* this.evaluate(statement.expression, scope) : undefined);
			case 'IfStmt':
				if (isTruthy(yield* this.evaluate(statement.condition, scope))) {
					yield* this.executeStatement(statement.then, scope);
				} else if (statement.else) {
					yield* this.executeStatement(statement.else, scope);
				}
				return;
			case 'WhileStmt':
				while (isTruthy(yield* this.evaluate(statement.condition, scope))) {
					yield* this.executeStatement(statement.body, scope);
				}
				return;
			case 'DoWhileStmt':
				do {
					yield* this.executeStatement(statement.body, scope);
				} while (isTruthy(yield* this.evaluate(statement.condition, scope)));
				return;
			case 'ForStmt':
				if (statement.init) yield* this.evaluate(statement.init, scope);
				while (!statement.condition || isTruthy(yield* this.evaluate(statement.condition, scope))) {
					yield* this.executeStatement(statement.body, scope);
					if (statement.update) yield* this.evaluate(statement.update, scope);
				}
				return;
			case 'BlockStmt':
				yield* this.executeBlock(statement.statements, new Scope(scope));
				return;
			case 'JumpStmt': {
				if (statement.target.kind !== 'Identifier') {
					throw new Error('dynamic jump targets are not supported');
				}
				throw new JumpSignal(statement.target.name);
			}
			case 'StateChangeStmt':
				throw new StateSignal(statement.state);
		}
	}

	private *executeBlock(statements: Stmt[], scope: Scope): Execution<void> {
		let start = 0;
		for (;;) {
			try {
				for (let index = start; index < statements.length; index += 1) {
					yield* this.executeStatement(statements[index]!, scope);
				}
				return;
			} catch (signal) {
				if (!(signal instanceof JumpSignal)) throw signal;
				const label = statements.findIndex(statement =>
					statement.kind === 'LabelStmt' && statement.name === signal.label);
				if (label < 0) throw signal;
				start = label + 1;
			}
		}
	}

	private *evaluate(expression: Expr, scope: Scope): Execution<Value> {
		this.tick();
		switch (expression.kind) {
			case 'ErrorExpr':
				throw new Error('cannot execute a parser error expression');
			case 'StringLiteral':
				return stringValue(expression.value);
			case 'NumberLiteral': {
				const parsed = parseNumberLiteral(expression.raw);
				if (!parsed) throw new Error(`invalid number literal ${expression.raw}`);
				return parsed.type === 'integer' ? intValue(parsed.value) : floatValue(parsed.value);
			}
			case 'Identifier': {
				const value = scope.get(expression.name) ?? this.constants.get(expression.name);
				if (!value) throw new Error(`unknown identifier ${expression.name}`);
				return cloneValue(value);
			}
			case 'Paren':
				return yield* this.evaluate(expression.expression, scope);
			case 'ListLiteral':
				return listValue(yield* this.evaluateArguments(expression.elements, scope));
			case 'VectorLiteral': {
				const values = (yield* this.evaluateArguments(expression.elements, scope))
					.map(value => asNumber(value, 'vector literal'));
				if (values.length === 3) return vectorValue([values[0]!, values[1]!, values[2]!]);
				return rotationValue([values[0]!, values[1]!, values[2]!, values[3]!]);
			}
			case 'Cast':
				return this.cast(yield* this.evaluate(expression.argument, scope), expression.type);
			case 'Member':
				return this.readMember(yield* this.evaluate(expression.object, scope), expression.property);
			case 'Unary':
				return yield* this.evaluateUnary(expression, scope);
			case 'Binary':
				return yield* this.evaluateBinary(expression, scope);
			case 'Call':
				return yield* this.evaluateCall(expression.callee, expression.args, scope);
		}
	}

	private *evaluateUnary(expression: Extract<Expr, { kind: 'Unary' }>, scope: Scope): Execution<Value> {
		if (expression.op === '++' || expression.op === '--') {
			const target = this.resolveLValue(expression.argument, scope);
			const previous = target.value;
			const delta = expression.op === '++' ? 1 : -1;
			const next = previous.type === 'float'
				? floatValue(asNumber(previous, expression.op) + delta)
				: intValue(asInteger(previous, expression.op) + delta);
			this.assign(target, next, scope);
			return expression.postfix ? previous : next;
		}
		const value = yield* this.evaluate(expression.argument, scope);
		switch (expression.op) {
			case '!': return intValue(isTruthy(value) ? 0 : 1);
			case '~': return intValue(~asInteger(value, '~'));
			case '+':
				return cloneValue(value);
			case '-':
				return value.type === 'float'
					? floatValue(-asNumber(value, '-'))
					: intValue(-asInteger(value, '-'));
		}
	}

	private *evaluateBinary(expression: Extract<Expr, { kind: 'Binary' }>, scope: Scope): Execution<Value> {
		if (expression.op === '&&') {
			const right = yield* this.evaluate(expression.right, scope);
			const left = yield* this.evaluate(expression.left, scope);
			return intValue(isTruthy(left) && isTruthy(right) ? 1 : 0);
		}
		if (expression.op === '||') {
			const right = yield* this.evaluate(expression.right, scope);
			const left = yield* this.evaluate(expression.left, scope);
			return intValue(isTruthy(left) || isTruthy(right) ? 1 : 0);
		}
		if (['=', '+=', '-=', '*=', '/=', '%='].includes(expression.op)) {
			const right = yield* this.evaluate(expression.right, scope);
			const target = this.resolveLValue(expression.left, scope);
			const next = expression.op === '='
				? right
				: this.applyBinary(expression.op.slice(0, 1), target.value, right);
			this.assign(target, next, scope);
			return coerceValue(next, target.value.type);
		}
		const right = yield* this.evaluate(expression.right, scope);
		const left = yield* this.evaluate(expression.left, scope);
		return this.applyBinary(expression.op, left, right);
	}

	private applyBinary(operator: string, left: Value, right: Value): Value {
		switch (operator) {
			case '==': return intValue(valueEquals(left, right) ? 1 : 0);
			case '!=':
				if (left.kind === 'value' && right.kind === 'value'
					&& left.type === 'list' && right.type === 'list') {
					return intValue(left.value.length - right.value.length);
				}
				return intValue(valueEquals(left, right) ? 0 : 1);
			case '<':
			case '<=':
			case '>':
			case '>=': {
				const l = left.type === 'string' || left.type === 'key'
					? asString(left, operator)
					: asNumber(left, operator);
				const r = right.type === 'string' || right.type === 'key'
					? asString(right, operator)
					: asNumber(right, operator);
				if (typeof l !== typeof r) throw new Error(`${operator} requires comparable operands`);
				if (operator === '<') return intValue(l < r ? 1 : 0);
				if (operator === '<=') return intValue(l <= r ? 1 : 0);
				if (operator === '>') return intValue(l > r ? 1 : 0);
				return intValue(l >= r ? 1 : 0);
			}
			case '+':
				if (left.type === 'list' || right.type === 'list') {
					const leftValues = left.type === 'list' && left.kind === 'value' ? left.value : [left];
					const rightValues = right.type === 'list' && right.kind === 'value' ? right.value : [right];
					return listValue([...leftValues, ...rightValues].map(cloneValue));
				}
				if (left.type === 'string' || left.type === 'key') {
					return stringValue(lslString(left) + lslString(right));
				}
				if (left.type === 'vector' && right.type === 'vector'
					&& left.kind === 'value' && right.kind === 'value') {
					return vectorValue([
						left.value[0] + right.value[0],
						left.value[1] + right.value[1],
						left.value[2] + right.value[2],
					]);
				}
				return this.numeric(operator, left, right, (a, b) => a + b);
			case '-':
				return this.numeric(operator, left, right, (a, b) => a - b);
			case '*':
				if (left.type === 'integer' && right.type === 'integer') {
					return intValue(Math.imul(asInteger(left, operator), asInteger(right, operator)));
				}
				return this.numeric(operator, left, right, (a, b) => a * b);
			case '/':
				if (asNumber(right, operator) === 0) throw new Error('division by zero');
				return this.numeric(operator, left, right, (a, b) => a / b);
			case '%':
				if (asInteger(right, operator) === 0) throw new Error('division by zero');
				return intValue(asInteger(left, operator) % asInteger(right, operator));
			case '&': return intValue(asInteger(left, operator) & asInteger(right, operator));
			case '|': return intValue(asInteger(left, operator) | asInteger(right, operator));
			case '^': return intValue(asInteger(left, operator) ^ asInteger(right, operator));
			case '<<': return intValue(asInteger(left, operator) << asInteger(right, operator));
			case '>>': return intValue(asInteger(left, operator) >> asInteger(right, operator));
			default:
				throw new Error(`unsupported binary operator ${operator}`);
		}
	}

	private numeric(operator: string, left: Value, right: Value, operation: (a: number, b: number) => number): Value {
		const result = operation(asNumber(left, operator), asNumber(right, operator));
		return left.type === 'float' || right.type === 'float' ? floatValue(result) : intValue(result);
	}

	private *evaluateArguments(expressions: Expr[], scope: Scope): Execution<Value[]> {
		const values: Value[] = new Array<Value>(expressions.length);
		for (let index = 0; index < expressions.length; index += 1) {
			values[index] = yield* this.evaluate(expressions[index]!, scope);
		}
		return values;
	}

	private *evaluateCall(callee: Expr, argExpressions: Expr[], scope: Scope): Execution<Value> {
		if (callee.kind !== 'Identifier') throw new Error('only named function calls are supported');
		const args = yield* this.evaluateArguments(argExpressions, scope);
		const fn = this.script.functions.get(callee.name);
		if (fn) return yield* this.runFunction(fn, args);

		const hostResult = this.host.callBuiltin(callee.name, args.map(cloneValue));
		if (hostResult.handled) {
			if (hostResult.stopped) yield { kind: 'stopped' };
			if (hostResult.delay !== undefined && hostResult.delay > 0) {
				yield { kind: 'delay', seconds: hostResult.delay };
			}
			return cloneValue(hostResult.value ?? intValue(0));
		}

		const runtimeFunction = (Runtime as unknown as Record<string, unknown>)[callee.name];
		if (typeof runtimeFunction === 'function') {
			return requireConcrete((runtimeFunction as RuntimeFunction)(...args), callee.name);
		}
		throw new Error(`simulator has no implementation for ${callee.name}`);
	}

	private *runFunction(fn: LslFunction, args: Value[]): Execution<Value> {
		const scope = new Scope(this.globals);
		let index = 0;
		for (const [name, type] of fn.parameters) {
			scope.define(name, coerceValue(args[index] ?? defaultValue(type), type));
			index += 1;
		}
		try {
			yield* this.executeStatement(fn.body, scope);
		} catch (signal) {
			if (signal instanceof ReturnSignal) {
				if (!fn.returnType || fn.returnType === 'void') return intValue(0);
				return coerceValue(signal.value ?? defaultValue(fn.returnType), fn.returnType);
			}
			throw signal;
		}
		return fn.returnType && fn.returnType !== 'void' ? defaultValue(fn.returnType) : intValue(0);
	}

	private resolveLValue(expression: Expr, scope: Scope): LValue {
		if (expression.kind === 'Identifier') {
			const value = scope.get(expression.name);
			if (!value) throw new Error(`unknown assignment target ${expression.name}`);
			return { kind: 'variable', name: expression.name, value };
		}
		if (expression.kind === 'Member' && expression.object.kind === 'Identifier') {
			const value = scope.get(expression.object.name);
			if (!value) throw new Error(`unknown assignment target ${expression.object.name}`);
			return {
				kind: 'member',
				name: expression.object.name,
				property: expression.property,
				value: this.readMember(value, expression.property),
			};
		}
		throw new Error('assignment requires a variable or vector component');
	}

	private assign(target: LValue, value: Value, scope: Scope): void {
		if (target.kind === 'variable') {
			if (!scope.set(target.name, coerceValue(value, target.value.type))) {
				throw new Error(`unknown assignment target ${target.name}`);
			}
			return;
		}
		const container = scope.get(target.name);
		if (!container || container.kind !== 'value'
			|| (container.type !== 'vector' && container.type !== 'rotation')) {
			throw new Error(`${target.name}.${target.property} is not assignable`);
		}
		const index = this.componentIndex(target.property, container.type);
		const components = [...container.value];
		components[index] = asNumber(value, `assignment to ${target.property}`);
		const updated = container.type === 'vector'
			? vectorValue([components[0]!, components[1]!, components[2]!])
			: rotationValue([components[0]!, components[1]!, components[2]!, components[3]!]);
		scope.set(target.name, updated);
	}

	private readMember(value: Value, property: string): Value {
		if (value.kind !== 'value' || (value.type !== 'vector' && value.type !== 'rotation')) {
			throw new Error(`.${property} requires a vector or rotation`);
		}
		return floatValue(value.value[this.componentIndex(property, value.type)]!);
	}

	private componentIndex(property: string, type: 'vector' | 'rotation'): number {
		const index = property === 'x' ? 0 : property === 'y' ? 1 : property === 'z' ? 2 : 3;
		if (!['x', 'y', 'z', 's'].includes(property) || (type === 'vector' && property === 's')) {
			throw new Error(`.${property} is not a component of ${type}`);
		}
		return index;
	}

	private cast(value: Value, type: Type): Value {
		if (value.kind === 'unknown') throw new Error(`cannot cast unknown ${value.type}`);
		if (value.type === type) return cloneValue(value);
		if (type === 'string') return stringValue(lslString(value));
		if (type === 'key') return keyValue(lslString(value));
		if (type === 'list') return listValue(value.type === 'list' ? value.value.map(cloneValue) : [cloneValue(value)]);
		if (type === 'integer') {
			if (value.type === 'float') return intValue(value.value);
			if (value.type === 'string' || value.type === 'key') {
				const parsed = /^[\t ]*([+-]?(?:0x[0-9a-f]+|\d+))/i.exec(value.value);
				return intValue(parsed ? Number.parseInt(parsed[1]!, parsed[1]!.toLowerCase().includes('0x') ? 16 : 10) : 0);
			}
		}
		if (type === 'float') {
			if (value.type === 'integer') return floatValue(value.value);
			if (value.type === 'string' || value.type === 'key') {
				const parsed = /^[\t ]*([+-]?(?:\d*\.\d+|\d+\.?\d*)(?:e[+-]?\d+)?)/i.exec(value.value);
				return floatValue(parsed ? Number.parseFloat(parsed[1]!) : 0);
			}
		}
		throw new Error(`unsupported cast from ${value.type} to ${type}`);
	}
}

export function constantValue(name: string): Value | undefined {
	const value = CONSTANTS.get(name);
	return value ? cloneValue(value) : undefined;
}
