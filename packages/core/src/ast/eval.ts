import type { Expr, Stmt, Type } from './types';
import { AssertNever } from '../utils';
import * as runtime from './runtime';
import { keyValueFromString, NULL_KEY_VALUE } from './key';
import { parseHexFloat, parseNumberLiteral } from './numberLiteral';

// Value model for evaluation
export type Unknown<T extends runtime.LSLType = runtime.LSLType> = runtime.Unknown<T>;
export type Value = runtime.Value;

export interface EvalOptions {
	maxNodes?: number;
	maxDepth?: number;
	maxLoopIters?: number;
	allowRuntimeCalls?: boolean;
}

const DEFAULT_EVAL_OPTIONS: Required<EvalOptions> = {
	maxNodes: 500,
	maxDepth: 64,
	maxLoopIters: 128,
	allowRuntimeCalls: false,
};

class EvalContext {
	private nodes = 0;
	private depth = 0;
	readonly opts: Required<EvalOptions>;

	constructor(options: EvalOptions = {}) {
		this.opts = { ...DEFAULT_EVAL_OPTIONS, ...options };
	}

	enter(): boolean {
		this.nodes += 1;
		this.depth += 1;
		return this.nodes <= this.opts.maxNodes && this.depth <= this.opts.maxDepth;
	}

	leave(): void {
		this.depth = Math.max(0, this.depth - 1);
	}
}

export class Env {
	constructor(
		private _vars: Map<string, Value> = new Map(),
		private _functionReturnTypes: Map<string, Type | 'void'> = new Map(),
		private _parent?: Env,
	) { }

	get functionReturnTypes(): ReadonlyMap<string, Type | 'void'> {
		return this._functionReturnTypes;
	}

	getVar(name: string): Value | undefined {
		return this._vars.get(name) ?? this._parent?.getVar(name);
	}

	setVar(name: string, value: Value): void {
		this._vars.set(name, value);
	}

	setExistingOrLocal(name: string, value: Value): void {
		if (this._vars.has(name)) {
			this._vars.set(name, value);
			return;
		}
		if (this._parent?.hasVar(name)) {
			this._parent.setExistingOrLocal(name, value);
			return;
		}
		this._vars.set(name, value);
	}

	private hasVar(name: string): boolean {
		return this._vars.has(name) || !!this._parent?.hasVar(name);
	}

	clone(): Env {
		return new Env(new Map(this._vars), this._functionReturnTypes, this._parent?.clone());
	}

	child(): Env {
		return new Env(new Map(), this._functionReturnTypes, this);
	}
}

const isNumberValue = (v: Value): v is Extract<Value, { kind: 'value', type: 'integer' | 'float', value: number }> =>
	v.kind === 'value' && (v.type === 'integer' || v.type === 'float');

const isStringValue = (v: Value): v is Extract<Value, { kind: 'value', type: 'string', value: string }> =>
	v.kind === 'value' && v.type === 'string';

const isKeyValue = (v: Value): v is Extract<Value, { kind: 'value', type: 'key', value: string }> =>
	v.kind === 'value' && v.type === 'key';

const num = (v: Value): number | null => (isNumberValue(v) ? v.value : null);
const integerValue = (v: Value): number | null => (v.kind === 'value' && v.type === 'integer' ? v.value : null);
const isNumericType = (t: runtime.LSLType) => t === 'integer' || t === 'float';
const isStringLikeValue = (v: Value): v is Extract<Value, { kind: 'value', type: 'string' | 'key', value: string }> =>
	v.kind === 'value' && (v.type === 'string' || v.type === 'key');

const asTypeUnknown = (t: Type): Unknown => runtime.unknown(t);

const int = (x: number) => Math.trunc(x);

const numberToLSLString = (t: 'integer' | 'float', n: number): string =>
	t === 'integer' ? String(int(n)) : Number(n).toFixed(6);

// LSL-like string→integer cast: trim, recognize hex, accept leading sign, stop at first non-digit, default 0. :contentReference[oaicite:9]{index=9}
function castStringToInteger(s: string): number {
	const t = s.trimStart();
	const mHex = /^([+-]?0x[0-9a-f]+)/i.exec(t);
	if (mHex) return int(parseInt(mHex[1]!, 16));
	const mDec = /^([+-]?\d+)/.exec(t);
	if (mDec) return int(parseInt(mDec[1]!, 10));
	return 0;
}

// LSL-like string→float cast: trim, accept decimal/exp or C99 hex-float; tolerate trailing text; NaN/Inf produce unknowns. :contentReference[oaicite:10]{index=10}
function castStringToFloat(s: string): number | null {
	const t = s.trimStart();
	// NaN / Inf handling (Mono: produces NaN/Inf; LSO: math error; we treat as unknown here). :contentReference[oaicite:11]{index=11}
	if (/^(nan)/i.test(t) || /^(inf)/i.test(t)) return null;

	// C99 hex float
	if (/^[+-]?0x[0-9a-f]+(?:\.[0-9a-f]*)?(?:p[+-]?\d+)?/i.test(t)) {
		const m = /^[+-]?0x[0-9a-f]+(?:\.[0-9a-f]*)?(?:p[+-]?\d+)?/i.exec(t)!;
		const v = parseHexFloat(m[0]!);
		return Number.isFinite(v!) ? v! : null;
	}

	// Decimal / scientific
	const m = /^[+-]?(?:\d*\.\d+|\d+\.?\d*)(?:[eE][+-]?\d+)?/.exec(t);
	if (m) {
		const v = Number.parseFloat(m[0]!);
		return Number.isFinite(v) ? v : null;
	}
	return null;
}

function stringValue(v: Value): string | null {
	if (isStringValue(v)) return v.value;
	if (isKeyValue(v)) return v.value;
	if (isNumberValue(v)) return numberToLSLString(v.type, v.value);
	return null;
}

// Try to extract a numeric vector from a VectorLiteral/Rotation-literal Expr
function extractNumericVectorOrRotation(env: Env, e: Expr | null, ctx: EvalContext): { comps: number[]; isRotation: boolean } | null {
	if (!e || e.kind !== 'VectorLiteral') return null;
	const want4 = e.elements.length === 4;
	const nums: number[] = [];
	for (const comp of e.elements) {
		const cv = evalExprInner(comp, env, ctx);
		const n = num(cv);
		if (n === null) return null;
		nums.push(n);
	}
	return { comps: nums, isRotation: want4 };
}

function componentAtValue(v: Value, prop: 'x' | 'y' | 'z' | 's'): number | null {
	if (v.kind !== 'value' || (v.type !== 'vector' && v.type !== 'rotation')) return null;
	const want4 = v.type === 'rotation';
	const idx = prop === 'x' ? 0 : prop === 'y' ? 1 : prop === 'z' ? 2 : 3;
	if (!want4 && prop === 's') return null;
	if (!want4 && idx > 2) return null;
	return v.value[idx] ?? null;
}

function vectorishValuesEqual(l: Value, r: Value): boolean | null {
	if (l.kind !== 'value' || r.kind !== 'value') return null;
	if ((l.type !== 'vector' && l.type !== 'rotation') || l.type !== r.type) return null;
	return l.value.length === r.value.length && l.value.every((component, i) => component === r.value[i]);
}

function finiteVector(value: number[]): value is [number, number, number] {
	return value.length === 3 && value.every(Number.isFinite);
}

function finiteRotation(value: number[]): value is [number, number, number, number] {
	return value.length === 4 && value.every(Number.isFinite);
}

function vectorValue(v: Value): [number, number, number] | null {
	return v.kind === 'value' && v.type === 'vector' && finiteVector(v.value) ? v.value : null;
}

function rotationValue(v: Value): [number, number, number, number] | null {
	return v.kind === 'value' && v.type === 'rotation' && finiteRotation(v.value) ? v.value : null;
}

function qMul(a: [number, number, number, number], b: [number, number, number, number]): [number, number, number, number] {
	const [ax, ay, az, as] = a;
	const [bx, by, bz, bs] = b;
	return [
		as * bx + ax * bs + ay * bz - az * by,
		as * by - ax * bz + ay * bs + az * bx,
		as * bz + ax * by - ay * bx + az * bs,
		as * bs - ax * bx - ay * by - az * bz,
	];
}

function qInv(q: [number, number, number, number]): [number, number, number, number] | null {
	const normSq = q[0] * q[0] + q[1] * q[1] + q[2] * q[2] + q[3] * q[3];
	if (!Number.isFinite(normSq) || normSq === 0) return null;
	return [-q[0] / normSq, -q[1] / normSq, -q[2] / normSq, q[3] / normSq];
}

function qRotateVec(q: [number, number, number, number], v: [number, number, number]): [number, number, number] {
	const u: [number, number, number] = [q[0], q[1], q[2]];
	const s = q[3];
	const cross = (a: [number, number, number], b: [number, number, number]): [number, number, number] => [
		a[1] * b[2] - a[2] * b[1],
		a[2] * b[0] - a[0] * b[2],
		a[0] * b[1] - a[1] * b[0],
	];
	const t = cross(u, v).map(c => 2 * c) as [number, number, number];
	const v1: [number, number, number] = [v[0] + s * t[0], v[1] + s * t[1], v[2] + s * t[2]];
	const t2 = cross(u, t);
	return [v1[0] + t2[0], v1[1] + t2[1], v1[2] + t2[2]];
}

function vectorVal(value: [number, number, number]): Value {
	return { kind: 'value', type: 'vector', value };
}

function rotationVal(value: [number, number, number, number]): Value {
	return { kind: 'value', type: 'rotation', value };
}

function coerceAssignedValue(value: Value, current: Value | undefined): Value {
	if (!current) return value;
	if (value.kind === 'unknown') return runtime.unknown(current.type);
	if (value.type === current.type) return value;
	if (current.type === 'float' && value.type === 'integer') {
		return { kind: 'value', type: 'float', value: value.value };
	}
	if (current.type === 'string' && value.type === 'key') {
		return { kind: 'value', type: 'string', value: value.value };
	}
	if (current.type === 'key' && value.type === 'string') {
		const key = keyValueFromString(value.value);
		return key === null ? runtime.unknown('key') : { kind: 'value', type: 'key', value: key };
	}
	return runtime.unknown(current.type);
}

export function evalExpr(expr: Expr | null, env: Env = new Env(), options?: EvalOptions): Value {
	return evalExprInner(expr, env, new EvalContext(options));
}

function evalExprInner(expr: Expr | null, env: Env, ctx: EvalContext): Value {
	if (!expr) return runtime.unknown('integer');
	if (!ctx.enter()) {
		ctx.leave();
		return runtime.unknown('integer');
	}

	try {
		switch (expr.kind) {
			case 'ErrorExpr':
				return runtime.unknown('integer');

			case 'Paren':
				return evalExprInner(expr.expression, env, ctx);

			case 'StringLiteral':
				return { kind: 'value', type: 'string', value: expr.value };

			case 'NumberLiteral': {
				const parsed = parseNumberLiteral(expr.raw);
				return parsed
					? { kind: 'value', type: parsed.type, value: parsed.value }
					: runtime.unknown('integer');
			}

			case 'VectorLiteral': {
				const nums: number[] = [];
				for (const comp of expr.elements) {
					const cv = evalExprInner(comp, env, ctx);
					const n = num(cv);
					if (n === null) return runtime.unknown(expr.elements.length === 4 ? 'rotation' : 'vector');
					nums.push(n);
				}
				return expr.elements.length === 4
					? { kind: 'value', type: 'rotation', value: nums as [number, number, number, number] }
					: { kind: 'value', type: 'vector', value: nums as [number, number, number] };
			}

			case 'ListLiteral': {
				const values: Value[] = [];
				for (const element of expr.elements) {
					const value = evalExprInner(element, env, ctx);
					if (value.kind === 'unknown' && value.type === 'list') return runtime.unknown('list');
					if (value.kind === 'value' && value.type === 'list') return runtime.unknown('list');
					values.push(value);
				}
				return { kind: 'value', type: 'list', value: values };
			}

			case 'Identifier':
				return env.getVar(expr.name) ?? runtime.unknown('integer');

			case 'Cast': {
				const inner = evalExprInner(expr.argument, env, ctx);

				if (expr.type === 'integer') {
					if (isNumberValue(inner)) {
						return { kind: 'value', type: 'integer', value: int(inner.value) };
					}
					if (isStringValue(inner)) {
						return { kind: 'value', type: 'integer', value: castStringToInteger(inner.value) };
					}
					return runtime.unknown('integer');
				}

				if (expr.type === 'float') {
					if (isNumberValue(inner)) {
						return { kind: 'value', type: 'float', value: inner.value };
					}
					if (isStringValue(inner)) {
						const f = castStringToFloat(inner.value);
						return f === null ? runtime.unknown('float') : { kind: 'value', type: 'float', value: f };
					}
					return runtime.unknown('float');
				}

				if (expr.type === 'string') {
					const s = stringValue(inner);
					return s === null ? runtime.unknown('string') : { kind: 'value', type: 'string', value: s };
				}

				if (expr.type === 'key') {
					if (isKeyValue(inner)) return inner;
					if (isStringValue(inner)) {
						const key = keyValueFromString(inner.value);
						return key === null ? runtime.unknown('key') : { kind: 'value', type: 'key', value: key };
					}
					return runtime.unknown('key');
				}

				// list, vector, rotation, etc. -> unknown shaped accordingly
				return asTypeUnknown(expr.type);
			}

			case 'Unary': {
				const v = evalExprInner(expr.argument, env, ctx);
				const n = num(v);
				switch (expr.op) {
					case '!':
						return v.kind === 'value' && v.type === 'integer' ? { kind: 'value', type: 'integer', value: v.value ? 0 : 1 } : runtime.unknown('integer');
					case '~': {
						const i = integerValue(v);
						return i === null ? runtime.unknown('integer') : { kind: 'value', type: 'integer', value: ~int(i) };
					}
					case '+':
						return n === null ? runtime.unknown('integer') : { kind: 'value', type: v.type, value: n } as Value;
					case '-':
						if (n !== null) return { kind: 'value', type: v.type, value: -n } as Value;
						if (v.type === 'vector' || v.type === 'rotation') return runtime.unknown(v.type);
						return runtime.unknown('integer');
					case '++':
					case '--':
						// No side-effects here (pure fold); value unknown.
						return runtime.unknown('integer');
					default:
						return runtime.unknown('integer');
				}
			}

			case 'Member': {
			// Component access yields a float. Only materialize values from an evaluated variable-like object;
			// literal/call member bases are compile errors in LSL and are reported by operator validation.
				const p = expr.property as 'x' | 'y' | 'z' | 's';
				const c = (expr.object.kind === 'Identifier' || expr.object.kind === 'Member')
					? componentAtValue(evalExprInner(expr.object, env, ctx), p)
					: null;
				return c === null ? runtime.unknown('float') : { kind: 'value', type: 'float', value: c };
			}

			case 'Binary': {
				if (expr.op === '=') {
					const value = evalExprInner(expr.right, env, ctx);
					if (expr.left.kind !== 'Identifier') return runtime.unknown(value.type);
					const assigned = coerceAssignedValue(value, env.getVar(expr.left.name));
					env.setExistingOrLocal(expr.left.name, assigned);
					return assigned;
				}

				// Some operations are easier to fold directly from the AST (vectors).
				// Vector dot / cross when both sides are literal vectors.
				if (expr.op === '*' || expr.op === '%') {
					const L = extractNumericVectorOrRotation(env, expr.left, ctx);
					const R = extractNumericVectorOrRotation(env, expr.right, ctx);
					if (L && R && !L.isRotation && !R.isRotation) {
						if (expr.op === '*') {
						// dot product -> float
							const v = L.comps[0] * R.comps[0] + L.comps[1] * R.comps[1] + L.comps[2] * R.comps[2];
							return { kind: 'value', type: 'float', value: v };
						} else {
							const [lx, ly, lz] = L.comps;
							const [rx, ry, rz] = R.comps;
							if (lx !== undefined && ly !== undefined && lz !== undefined && rx !== undefined && ry !== undefined && rz !== undefined) {
								return vectorVal([ly * rz - lz * ry, lz * rx - lx * rz, lx * ry - ly * rx]);
							}
							return runtime.unknown('vector');
						}
					}
				}

				// Evaluate both sides (LSL logical operators always evaluate both operands).
				const l = evalExprInner(expr.left, env, ctx);
				const r = evalExprInner(expr.right, env, ctx);
				const ln = num(l);
				const rn = num(r);

				switch (expr.op) {
					case '==':
					case '!=': {
						if (l.type === 'list' || r.type === 'list') {
							if (l.kind === 'value' && l.type === 'list' && r.kind === 'value' && r.type === 'list') {
								const dl = l.value.length;
								const dr = r.value.length;
								if (expr.op === '==') return { kind: 'value', type: 'integer', value: dl === dr ? 1 : 0 };
								return { kind: 'value', type: 'integer', value: dl - dr };
							}
							return runtime.unknown('integer');
						}
						const vectorishEqual = vectorishValuesEqual(l, r);
						if (vectorishEqual !== null) {
							return { kind: 'value', type: 'integer', value: (expr.op === '==') === vectorishEqual ? 1 : 0 };
						}
					}
					// falls through for non-list equality
					case '<':
					case '<=':
					case '>':
					case '>=': {
					// numeric relational/equality
						if (ln !== null && rn !== null) {
							const res =
							expr.op === '==' ? (ln === rn) :
								expr.op === '!=' ? (ln !== rn) :
									expr.op === '<' ? (ln < rn) :
										expr.op === '<=' ? (ln <= rn) :
											expr.op === '>' ? (ln > rn) :
												(ln >= rn);
							return { kind: 'value', type: 'integer', value: res ? 1 : 0 };
						}
						// string/key equality/inequality; do not coerce numbers here because SL rejects it.
						if (isStringLikeValue(l) && isStringLikeValue(r) && (expr.op === '==' || expr.op === '!=')) {
							const ls = l.value;
							const rs = r.value;
							const res = (ls === rs);
							return { kind: 'value', type: 'integer', value: (expr.op === '==') === res ? 1 : 0 };
						}
						return runtime.unknown('integer');
					}

					case '&&': {
						const li = integerValue(l);
						const ri = integerValue(r);
						if (li === null || ri === null) return runtime.unknown('integer');
						return { kind: 'value', type: 'integer', value: (li !== 0 && ri !== 0) ? 1 : 0 };
					}
					case '||': {
						const li = integerValue(l);
						const ri = integerValue(r);
						if (li === null || ri === null) return runtime.unknown('integer');
						return { kind: 'value', type: 'integer', value: (li !== 0 || ri !== 0) ? 1 : 0 };
					}

					case '&': case '|': case '^': case '<<': case '>>': {
						const leftInt = integerValue(l);
						const rightInt = integerValue(r);
						if (leftInt === null || rightInt === null) return runtime.unknown('integer');
						const li = int(leftInt) | 0;
						const ri = int(rightInt) | 0;
						switch (expr.op) {
							case '&': return { kind: 'value', type: 'integer', value: (li & ri) | 0 };
							case '|': return { kind: 'value', type: 'integer', value: (li | ri) | 0 };
							case '^': return { kind: 'value', type: 'integer', value: (li ^ ri) | 0 };
							case '<<': return { kind: 'value', type: 'integer', value: (li << (ri & 31)) | 0 };
							case '>>': return { kind: 'value', type: 'integer', value: (li >> (ri & 31)) | 0 };
						}
						return runtime.unknown('integer');
					}

					case '+': {
					// String concatenation is string + string only; explicit casts are folded before this point.
						if (isStringValue(l) && isStringValue(r)) {
							return { kind: 'value', type: 'string', value: l.value + r.value };
						}
						const lv = vectorValue(l);
						const rv = vectorValue(r);
						if (lv && rv) return vectorVal([lv[0] + rv[0], lv[1] + rv[1], lv[2] + rv[2]]);
						const lr = rotationValue(l);
						const rr = rotationValue(r);
						if (lr && rr) return rotationVal([lr[0] + rr[0], lr[1] + rr[1], lr[2] + rr[2], lr[3] + rr[3]]);
						// numeric addition
						if (ln !== null && rn !== null) {
							const isFloat = (isNumberValue(l) && l.type === 'float') || (isNumberValue(r) && r.type === 'float');
							const t: 'integer' | 'float' = isFloat ? 'float' : 'integer';
							const a = isFloat ? ln : int(ln);
							const b = isFloat ? rn : int(rn);
							const v = a + b;
							return { kind: 'value', type: t, value: v };
						}
						if (l.type === 'list' || r.type === 'list') return runtime.unknown('list');
						if (l.type === 'vector' && r.type === 'vector') return runtime.unknown('vector');
						if (l.type === 'rotation' && r.type === 'rotation') return runtime.unknown('rotation');
						return runtime.unknown('integer');
					}

					case '-':
					case '*':
					case '/': {
						const lv = vectorValue(l);
						const rv = vectorValue(r);
						const lr = rotationValue(l);
						const rr = rotationValue(r);
						if (expr.op === '-' && lv && rv) return vectorVal([lv[0] - rv[0], lv[1] - rv[1], lv[2] - rv[2]]);
						if (expr.op === '-' && lr && rr) return rotationVal([lr[0] - rr[0], lr[1] - rr[1], lr[2] - rr[2], lr[3] - rr[3]]);
						if (expr.op === '*' && lv && rv) return { kind: 'value', type: 'float', value: lv[0] * rv[0] + lv[1] * rv[1] + lv[2] * rv[2] };
						if (expr.op === '*' && lv && rn !== null) return vectorVal([lv[0] * rn, lv[1] * rn, lv[2] * rn]);
						if (expr.op === '*' && ln !== null && rv) return vectorVal([ln * rv[0], ln * rv[1], ln * rv[2]]);
						if (expr.op === '*' && lv && rr) return vectorVal(qRotateVec(rr, lv));
						if (expr.op === '*' && lr && rr) return rotationVal(qMul(lr, rr));
						if (expr.op === '/' && lv && rn !== null) {
							if (rn === 0) return runtime.unknown('vector');
							return vectorVal([lv[0] / rn, lv[1] / rn, lv[2] / rn]);
						}
						if (expr.op === '/' && lv && rr) {
							const inv = qInv(rr);
							return inv ? vectorVal(qRotateVec(inv, lv)) : runtime.unknown('vector');
						}
						if (expr.op === '/' && lr && rr) {
							const inv = qInv(rr);
							return inv ? rotationVal(qMul(lr, inv)) : runtime.unknown('rotation');
						}
						if (ln === null || rn === null) {
							if (expr.op === '-' && l.type === 'vector' && r.type === 'vector') return runtime.unknown('vector');
							if (expr.op === '-' && l.type === 'rotation' && r.type === 'rotation') return runtime.unknown('rotation');
							if (expr.op === '*' && l.type === 'vector' && r.type === 'vector') return runtime.unknown('float');
							if (expr.op === '*' && ((l.type === 'vector' && isNumericType(r.type)) || (isNumericType(l.type) && r.type === 'vector'))) return runtime.unknown('vector');
							if (expr.op === '*' && l.type === 'vector' && r.type === 'rotation') return runtime.unknown('vector');
							if (expr.op === '*' && l.type === 'rotation' && r.type === 'rotation') return runtime.unknown('rotation');
							if (expr.op === '/' && l.type === 'vector' && (isNumericType(r.type) || r.type === 'rotation')) return runtime.unknown('vector');
							if (expr.op === '/' && l.type === 'rotation' && r.type === 'rotation') return runtime.unknown('rotation');
							return runtime.unknown('integer');
						}
						const isFloat = (isNumberValue(l) && l.type === 'float') || (isNumberValue(r) && r.type === 'float') || expr.op === '/'; // division may still be integer, but decide below
						const bothInt = isNumberValue(l) && l.type === 'integer' && isNumberValue(r) && r.type === 'integer';
						let t: 'integer' | 'float' = isFloat && !bothInt ? 'float' : (expr.op === '/' && bothInt ? 'integer' : (isFloat ? 'float' : 'integer'));

						// Prepare operands
						const ai = bothInt ? int(ln) : ln;
						const bi = bothInt ? int(rn) : rn;

						let v: number;
						switch (expr.op) {
							case '-': v = (t === 'integer') ? (int(ln) - int(rn)) : (ln - rn); break;
							case '*': v = (t === 'integer') ? (int(ln) * int(rn)) : (ln * rn); break;
							case '/': {
								if (rn === 0) return runtime.unknown(t); // Math Error at runtime.
								if (bothInt) { v = int(ai / bi); t = 'integer'; }
								else { v = ln / rn; t = 'float'; }
								break;
							}
						}
						if (!Number.isFinite(v)) return runtime.unknown(t);
						return { kind: 'value', type: t, value: v } as Value;
					}

					case '%': {
					// Only integer%integer is defined as modulus; vector%vector is cross product. No float % operator in LSL.
					// Try integer modulus
						if (ln !== null && rn !== null && isNumberValue(l) && isNumberValue(r) && l.type === 'integer' && r.type === 'integer') {
							if (rn === 0) return runtime.unknown('integer'); // Math Error at runtime.
							const a = int(ln), b = int(rn);
							return { kind: 'value', type: 'integer', value: a % b };
						}
						// vector%vector (cross) when both sides are literal vectors — return unknown vector
						const L = extractNumericVectorOrRotation(env, expr.left, ctx);
						const R = extractNumericVectorOrRotation(env, expr.right, ctx);
						if (L && R && !L.isRotation && !R.isRotation) {
							const [lx, ly, lz] = L.comps;
							const [rx, ry, rz] = R.comps;
							if (lx !== undefined && ly !== undefined && lz !== undefined && rx !== undefined && ry !== undefined && rz !== undefined) {
								return vectorVal([ly * rz - lz * ry, lz * rx - lx * rz, lx * ry - ly * rx]);
							}
						}
						const lv = vectorValue(l);
						const rv = vectorValue(r);
						if (lv && rv) return vectorVal([lv[1] * rv[2] - lv[2] * rv[1], lv[2] * rv[0] - lv[0] * rv[2], lv[0] * rv[1] - lv[1] * rv[0]]);
						if (l.type === 'vector' && r.type === 'vector') return runtime.unknown('vector');
						return runtime.unknown('integer');
					}

					default:
					// Compound assignments and unhandled operators -> unknown
						return runtime.unknown('integer');
				}
			}

			case 'Call': {
			// Only resolve simple identifier callee to a runtime function (if present)
				if (expr.callee.kind !== 'Identifier') return runtime.unknown('integer');
				const rt = env.functionReturnTypes?.get(expr.callee.name);
				if (!ctx.opts.allowRuntimeCalls) {
					return rt && rt !== 'void' ? asTypeUnknown(rt) : runtime.unknown('integer');
				}
				const name = expr.callee.name as keyof typeof runtime;
				const fn = runtime[name] as (...args: Value[]) => Value;
				if (typeof fn === 'function') {
					const args = expr.args.map(a => evalExprInner(a, env, ctx));
					try {
						return fn(...args);
					} catch {
						return runtime.unknown('integer');
					}
				}
				// Unknown function: shape unknown by declared return type if provided
				if (rt && rt !== 'void') return asTypeUnknown(rt);
				return runtime.unknown('integer');
			}
		}

		AssertNever(expr);
		return runtime.unknown('integer');
	} finally {
		ctx.leave();
	}
}

class JumpSignal extends Error {
	constructor(public readonly label: string) { super(`jump ${label}`); }
}

class StateChangeSignal extends Error {
	constructor(public readonly state: string) { super(`state ${state}`); }
}

const isTruthy = (v: Value): boolean | null => {
	if (v.kind !== 'value') return null;
	if (v.type === 'integer' || v.type === 'float') return Math.trunc(v.value) !== 0;
	if (v.type === 'string') return v.value.length !== 0;
	if (v.type === 'key') return v.value !== '' && v.value !== NULL_KEY_VALUE;
	if (v.type === 'list') return v.value.length !== 0;
	if (v.type === 'vector' || v.type === 'rotation') return v.value.some(component => component !== 0);
	return null;
};

function resolveLabelFromExprInner(target: Expr, env: Env, ctx: EvalContext): string | null {
	if (target.kind === 'Identifier') return target.name;
	if (target.kind === 'StringLiteral') return target.value;
	const v = evalExprInner(target, env, ctx);
	return (v.kind === 'value' && v.type === 'string') ? v.value : null;
}

export function evalStmt(stmt: Stmt, env: Env = new Env(), options?: EvalOptions): Value | null {
	return evalStmtInner(stmt, env, new EvalContext(options));
}

function evalStmtInner(stmt: Stmt, env: Env, ctx: EvalContext): Value | null {
	if (!ctx.enter()) {
		ctx.leave();
		return null;
	}
	try {
		switch (stmt.kind) {
			case 'ErrorStmt':
			case 'EmptyStmt':
				return null;

			case 'ExprStmt': {
			// Evaluate for potential side effects in the future; ignore the value.
			// (Important: don't return the expression's value, or the block would terminate early.)
				evalExprInner(stmt.expression, env, ctx);
				return null;
			}

			case 'VarDecl': {
				const name = stmt.name;
				const init = stmt.initializer ? evalExprInner(stmt.initializer, env, ctx) : runtime.unknown(stmt.varType);
				env.setVar(name, init);
				return null;
			}

			case 'ReturnStmt':
			// Return the folded value (or null for "return;" in a void context).
				return stmt.expression ? evalExprInner(stmt.expression, env, ctx) : null;

			case 'IfStmt': {
				const condVal = evalExprInner(stmt.condition, env, ctx);
				const b = isTruthy(condVal);
				if (b === true) {
					return evalStmtInner(stmt.then, env.child(), ctx);
				} else if (b === false) {
					return stmt.else ? evalStmtInner(stmt.else, env.child(), ctx) : null;
				} else {
					const a = evalStmtInner(stmt.then, env.child(), ctx);
					if (a != null) return runtime.unknown(a.type);
					if (stmt.else) {
						const b = evalStmtInner(stmt.else, env.child(), ctx);
						if (b != null) return runtime.unknown(b.type);
					}
				}
				return null;
			}

			case 'WhileStmt': {
				let iters = 0;
				for (;;) {
					const c = isTruthy(evalExprInner(stmt.condition, env, ctx));
					if (c === false) break;            // known false => loop never/ends now
					if (c === null) return null;       // unknown condition => stop folding
					// c === true
					const r = evalStmtInner(stmt.body, env.child(), ctx);
					if (r !== null) return r;          // propagate a definite return
					if (++iters > ctx.opts.maxLoopIters) return null; // avoid infinite analysis
				}
				return null;
			}

			case 'DoWhileStmt': {
				let iters = 0;
				for (;;) {
					const r = evalStmtInner(stmt.body, env, ctx);
					if (r !== null) return r;
					const c = isTruthy(evalExprInner(stmt.condition, env.child(), ctx));
					if (c === false) break;
					if (c === null) return null;
					if (++iters > ctx.opts.maxLoopIters) return null;
				}
				return null;
			}

			case 'ForStmt': {
			// init
				if (stmt.init) evalExprInner(stmt.init, env, ctx);
				let iters = 0;
				for (;;) {
				// condition: if absent, treat as true (infinite loop unless broken by body)
					let c: boolean | null = true;
					if (stmt.condition) {
						c = isTruthy(evalExprInner(stmt.condition, env, ctx));
						if (c === false) break;
						if (c === null) return null;
					}
					// body
					const r = evalStmtInner(stmt.body, env.child(), ctx);
					if (r !== null) return r;
					// update
					if (stmt.update) evalExprInner(stmt.update, env, ctx);
					if (++iters > ctx.opts.maxLoopIters) return null;
				}
				return null;
			}

			case 'JumpStmt': {
				const label = resolveLabelFromExprInner(stmt.target, env, ctx);
				if (!label) {
				// Can't resolve target label statically
					return null;
				}
				// Use a signal; the nearest enclosing BlockStmt with that label will catch & reposition PC.
				throw new JumpSignal(label);
			}

			case 'LabelStmt':
				return null;

			case 'StateChangeStmt': throw new StateChangeSignal(stmt.state);

			case 'BlockStmt': {
				const innerEnv = env.child();

				// Pre-scan for labels in this block (name -> statement index)
				const labels = new Map<string, number>();
				for (let i = 0; i < stmt.statements.length; i++) {
					const s = stmt.statements[i]!;
					if (s.kind === 'LabelStmt') labels.set(s.name, i);
				}

				// Execute with a program counter so we can reposition on "jump"
				for (let pc = 0; pc < stmt.statements.length; pc++) {
					const s = stmt.statements[pc]!;
					try {
						const out = evalStmtInner(s, innerEnv, ctx);
						if (out !== null) return out;
					} catch (sig: unknown) {
						if (sig instanceof JumpSignal) {
						// If this block owns the label, reposition; otherwise bubble out
							const idx = labels.get(sig.label);
							if (idx !== undefined) {
								pc = idx;       // jump to the label statement
								continue;       // next loop iteration will process it (which is a no-op)
							}
							throw sig;         // not ours -> propagate
						}
						if (sig instanceof StateChangeSignal) {
						// bubble state change outward (outermost caller should catch and stop evaluation)
							throw sig;
						}
						throw sig; // unknown error/signal -> propagate
					}
				}
				return null;
			}
		}

		AssertNever(stmt, 'Unreachable statement');
		return null;
	} finally {
		ctx.leave();
	}
}

export const Runtime = runtime;
