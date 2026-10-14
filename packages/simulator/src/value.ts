import type { Type, Value } from '@lsl-lsp/core';

export const NULL_KEY = '00000000-0000-0000-0000-000000000000';

export const intValue = (value: number): Value => ({
	kind: 'value',
	type: 'integer',
	value: value | 0,
});

export const floatValue = (value: number): Value => ({
	kind: 'value',
	type: 'float',
	value,
});

export const stringValue = (value: string): Value => ({
	kind: 'value',
	type: 'string',
	value,
});

export const keyValue = (value: string): Value => ({
	kind: 'value',
	type: 'key',
	value,
});

export const listValue = (value: Value[]): Value => ({
	kind: 'value',
	type: 'list',
	value,
});

export const vectorValue = (value: [number, number, number]): Value => ({
	kind: 'value',
	type: 'vector',
	value,
});

export const rotationValue = (value: [number, number, number, number]): Value => ({
	kind: 'value',
	type: 'rotation',
	value,
});

export function defaultValue(type: Type): Value {
	switch (type) {
		case 'integer': return intValue(0);
		case 'float': return floatValue(0);
		case 'string': return stringValue('');
		case 'key': return keyValue('');
		case 'list': return listValue([]);
		case 'vector': return vectorValue([0, 0, 0]);
		case 'rotation': return rotationValue([0, 0, 0, 1]);
	}
}

export function cloneValue(value: Value): Value {
	if (value.kind === 'unknown') return { ...value };
	if (value.type === 'list') return listValue(value.value.map(cloneValue));
	if (value.type === 'vector') return vectorValue([value.value[0], value.value[1], value.value[2]]);
	if (value.type === 'rotation') {
		return rotationValue([value.value[0], value.value[1], value.value[2], value.value[3]]);
	}
	return { ...value };
}

export function requireConcrete(value: Value, context: string): Value {
	if (value.kind === 'unknown') {
		throw new Error(`${context} produced an unknown ${value.type} value`);
	}
	return value;
}

export function asNumber(value: Value, context: string): number {
	if (value.kind === 'value' && (value.type === 'integer' || value.type === 'float')) {
		return value.value;
	}
	throw new Error(`${context} requires a number, got ${value.type}`);
}

export function asInteger(value: Value, context: string): number {
	if (value.kind === 'value' && value.type === 'integer') return value.value | 0;
	throw new Error(`${context} requires an integer, got ${value.type}`);
}

export function asString(value: Value, context: string): string {
	if (value.kind === 'value' && (value.type === 'string' || value.type === 'key')) {
		return value.value;
	}
	throw new Error(`${context} requires a string/key, got ${value.type}`);
}

export function asVector(
	value: Value,
	context: string,
): [number, number, number] {
	if (value.kind === 'value' && value.type === 'vector') {
		return [value.value[0], value.value[1], value.value[2]];
	}
	throw new Error(`${context} requires a vector, got ${value.type}`);
}

export function asRotation(
	value: Value,
	context: string,
): [number, number, number, number] {
	if (value.kind === 'value' && value.type === 'rotation') {
		return [
			value.value[0],
			value.value[1],
			value.value[2],
			value.value[3],
		];
	}
	throw new Error(`${context} requires a rotation, got ${value.type}`);
}

export function lslString(value: Value): string {
	if (value.kind === 'unknown') throw new Error(`cannot stringify unknown ${value.type}`);
	switch (value.type) {
		case 'integer': return String(value.value | 0);
		case 'float': return value.value.toFixed(6);
		case 'string':
		case 'key': return value.value;
		case 'vector':
		case 'rotation': return `<${value.value.map(component => component.toFixed(5)).join(', ')}>`;
		case 'list': return value.value.map(lslString).join('');
	}
}

export function isTruthy(value: Value): boolean {
	if (value.kind === 'unknown') throw new Error(`cannot branch on unknown ${value.type}`);
	switch (value.type) {
		case 'integer':
		case 'float': return value.value !== 0;
		case 'string': return value.value.length > 0;
		case 'key': return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value.value)
			&& value.value !== NULL_KEY;
		case 'list': return value.value.length > 0;
		case 'vector': return value.value.some(component => component !== 0);
		case 'rotation': return value.value[0] !== 0 || value.value[1] !== 0
			|| value.value[2] !== 0 || value.value[3] !== 1;
	}
}

export function coerceValue(value: Value, type: Type): Value {
	if (value.kind === 'unknown') throw new Error(`cannot coerce unknown ${value.type} to ${type}`);
	if (value.type === type) return cloneValue(value);
	if (type === 'float' && value.type === 'integer') return floatValue(value.value);
	if (type === 'string') return stringValue(lslString(value));
	if (type === 'key' && value.type === 'string') return keyValue(value.value);
	if (type === 'list' && value.type !== 'list') return listValue([cloneValue(value)]);
	throw new Error(`cannot coerce ${value.type} to ${type}`);
}

export function valueEquals(left: Value, right: Value): boolean {
	if (left.kind === 'unknown' || right.kind === 'unknown') return false;
	if (left.type !== right.type) {
		if ((left.type === 'integer' || left.type === 'float')
			&& (right.type === 'integer' || right.type === 'float')) {
			return left.value === right.value;
		}
		if ((left.type === 'string' || left.type === 'key')
			&& (right.type === 'string' || right.type === 'key')) {
			return left.value === right.value;
		}
		return false;
	}
	if (left.type === 'list' && right.type === 'list') {
		return left.value.length === right.value.length;
	}
	if (left.type === 'vector' && right.type === 'vector') {
		return left.value.every((value, index) => value === right.value[index]);
	}
	if (left.type === 'rotation' && right.type === 'rotation') {
		return left.value.every((value, index) => value === right.value[index]);
	}
	return left.value === right.value;
}
