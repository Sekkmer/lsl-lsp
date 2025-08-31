import type { Expr, Stmt, Type } from './index';
import { AssertNever } from '../utils';
import * as runtime from './runtime';

// Value model for evaluation
export type Unknown<T extends runtime.LSLType = runtime.LSLType> = runtime.Unknown<T>;
export type Value = runtime.Value;

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

	child(): Env {
		return new Env(new Map(), this._functionReturnTypes, this);
	}
}

const isNumberValue = (v: Value): v is Extract<Value, { kind: 'value', type: 'integer' | 'float', value: number }> =>
	v.kind === 'value' && (v.type === 'integer' || v.type === 'float');

const isStringValue = (v: Value): v is Extract<Value, { kind: 'value', type: 'string', value: string }> =>
	v.kind === 'value' && v.type === 'string';

const num = (v: Value): number | null => (isNumberValue(v) ? v.value : null);

const asTypeUnknown = (t: Type): Unknown => runtime.unknown(t);

const int = (x: number) => Math.trunc(x);

const numberToLSLString = (t: 'integer' | 'float', n: number): string =>
	t === 'integer' ? String(int(n)) : Number(n).toFixed(6);

// parse numeric literal with LSL-friendly rules
function parseNumberLiteral(rawIn: string): { type: 'integer' | 'float'; value: number } | null {
	let raw = rawIn.trim();

	// C99-style hex float?  e.g. 0x1.fp3  or  0x1.f  (p exponent optional)  (LSL accepts this via (float)"...") :contentReference[oaicite:8]{index=8}
	const hexFloatMatch = /^[+-]?0x[0-9a-f]+(?:\.[0-9a-f]*)?(?:p[+-]?\d+)?$/i.test(raw);
	if (hexFloatMatch) {
		const v = parseHexFloat(raw);
		return Number.isFinite(v) ? { type: 'float', value: v! } : null;
	}

	// Hex integer?
	if (/^[+-]?0x[0-9a-f]+$/i.test(raw)) {
		const sign = raw.startsWith('-') ? -1 : 1;
		raw = raw.replace(/^[+-]/, '');
		const v = sign * parseInt(raw, 16);
		return Number.isFinite(v) ? { type: 'integer', value: v } : null;
	}

	// Float if it looks like one (decimal point or exponent)
	if (/[.eE]/.test(raw)) {
		const v = Number.parseFloat(raw);
		return Number.isFinite(v) ? { type: 'float', value: v } : null;
	}

	// Decimal integer
	const v = Number.parseInt(raw, 10);
	return Number.isFinite(v) ? { type: 'integer', value: v } : null;
}

// Minimal C99 hex-float parser for strings already validated by regex above
function parseHexFloat(s: string): number | null {
	const m = /^\s*([+-])?0x([0-9a-f]+)(?:\.([0-9a-f]*))?(?:p([+-]?\d+))?\s*$/i.exec(s);
	if (!m) return null;
	const sign = m[1] === '-' ? -1 : 1;
	const intPart = m[2] || '0';
	const fracPart = m[3] || '';
	const exp = m[4] ? parseInt(m[4], 10) : 0;
	let mantissa = parseInt(intPart, 16);
	if (fracPart.length) {
		let frac = 0;
		for (let i = 0; i < fracPart.length; i++) {
			frac += parseInt(fracPart[i]!, 16) / Math.pow(16, i + 1);
		}
		mantissa += frac;
	}
	return sign * mantissa * Math.pow(2, exp);
}

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
	if (isNumberValue(v)) return numberToLSLString(v.type, v.value);
	return null;
}

// Try to extract a numeric vector from a VectorLiteral/Rotation-literal Expr
function extractNumericVectorOrRotation(env: Env, e: Expr | null): { comps: number[]; isRotation: boolean } | null {
	if (!e || e.kind !== 'VectorLiteral') return null;
	const want4 = e.elements.length === 4;
	const nums: number[] = [];
	for (const comp of e.elements) {
		const cv = evalExpr(comp, env); // evaluate subexprs purely
		const n = num(cv);
		if (n === null) return null;
		nums.push(n);
	}
	return { comps: nums, isRotation: want4 };
}

// Get Nth component 0-based for .x/.y/.z/.s if literal and numeric
function literalComponentAt(env: Env, obj: Expr, prop: 'x' | 'y' | 'z' | 's'): number | null {
	if (obj.kind !== 'VectorLiteral') return null;
	const want4 = obj.elements.length === 4;
	const idx = prop === 'x' ? 0 : prop === 'y' ? 1 : prop === 'z' ? 2 : 3;
	if (!want4 && prop === 's') return null;
	if (!want4 && idx > 2) return null;
	const cv = evalExpr(obj.elements[idx]!, env);
	const n = num(cv);
	return n;
}

export function evalExpr(expr: Expr | null, env: Env = new Env()): Value {
	if (!expr) return runtime.unknown('integer');

	switch (expr.kind) {
		case 'ErrorExpr':
			return runtime.unknown('integer');

		case 'Paren':
			return evalExpr(expr.expression, env);

		case 'StringLiteral':
			return { kind: 'value', type: 'string', value: expr.value };

		case 'NumberLiteral': {
			const parsed = parseNumberLiteral(expr.raw);
			return parsed
				? { kind: 'value', type: parsed.type, value: parsed.value }
				: runtime.unknown('integer');
		}

		case 'VectorLiteral': {
			// 3 comps => vector, 4 comps => rotation. We don’t materialize the value shape here.
			return { kind: 'unknown', type: expr.elements.length === 4 ? 'rotation' : 'vector' };
		}

		case 'ListLiteral':
			return { kind: 'unknown', type: 'list' };

		case 'Identifier':
			return env.getVar(expr.name) ?? runtime.unknown('integer');

		case 'Cast': {
			const inner = evalExpr(expr.argument, env);

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

			// key, list, vector, rotation, etc. -> unknown shaped accordingly
			return asTypeUnknown(expr.type);
		}

		case 'Unary': {
			const v = evalExpr(expr.argument, env);
			const n = num(v);
			switch (expr.op) {
				case '!':
					return n === null ? runtime.unknown('integer') : { kind: 'value', type: 'integer', value: n ? 0 : 1 };
				case '~':
					return n === null ? runtime.unknown('integer') : { kind: 'value', type: 'integer', value: ~int(n) };
				case '+':
					return n === null ? runtime.unknown('integer') : { kind: 'value', type: v.type, value: n } as Value;
				case '-':
					return n === null ? runtime.unknown('integer') : { kind: 'value', type: v.type, value: -n } as Value;
				case '++':
				case '--':
					// No side-effects here (pure fold); value unknown.
					return runtime.unknown('integer');
				default:
					return runtime.unknown('integer');
			}
		}

		case 'Member': {
			// component access yields a float; fold if literal vector/rotation with literal numeric component.
			const p = expr.property as 'x' | 'y' | 'z' | 's';
			const c = literalComponentAt(env, expr.object, p);
			return c === null ? runtime.unknown('float') : { kind: 'value', type: 'float', value: c };
		}

		case 'Binary': {
			// Some operations are easier to fold directly from the AST (lists, vectors).
			// List equality/inequality: == compares lengths equal; != returns length difference.
			if ((expr.op === '==' || expr.op === '!=') && expr.left.kind === 'ListLiteral' && expr.right.kind === 'ListLiteral') {
				const dl = expr.left.elements.length;
				const dr = expr.right.elements.length;
				if (expr.op === '==') {
					return { kind: 'value', type: 'integer', value: dl === dr ? 1 : 0 };
				} else {
					return { kind: 'value', type: 'integer', value: dl - dr };
				}
			}

			// Vector dot / cross when both sides are literal vectors.
			if (expr.op === '*' || expr.op === '%') {
				const L = extractNumericVectorOrRotation(env, expr.left);
				const R = extractNumericVectorOrRotation(env, expr.right);
				if (L && R && !L.isRotation && !R.isRotation) {
					if (expr.op === '*') {
						// dot product -> float
						const v = L.comps[0] * R.comps[0] + L.comps[1] * R.comps[1] + L.comps[2] * R.comps[2];
						return { kind: 'value', type: 'float', value: v };
					} else {
						// cross product -> vector (we return unknown('vector') as we don't materialize vector values)
						return runtime.unknown('vector');
					}
				}
			}

			// Evaluate both sides (LSL logical operators always evaluate both operands).
			const l = evalExpr(expr.left, env);
			const r = evalExpr(expr.right, env);
			const ln = num(l);
			const rn = num(r);

			switch (expr.op) {
				case '==':
				case '!=':
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
					// string equality/inequality
					const ls = stringValue(l);
					const rs = stringValue(r);
					if (ls !== null && rs !== null && (expr.op === '==' || expr.op === '!=')) {
						const res = (ls === rs);
						return { kind: 'value', type: 'integer', value: (expr.op === '==') === res ? 1 : 0 };
					}
					return runtime.unknown('integer');
				}

				case '&&': {
					if (ln === null || rn === null) return runtime.unknown('integer');
					return { kind: 'value', type: 'integer', value: (ln !== 0 && rn !== 0) ? 1 : 0 };
				}
				case '||': {
					if (ln === null || rn === null) return runtime.unknown('integer');
					return { kind: 'value', type: 'integer', value: (ln !== 0 || rn !== 0) ? 1 : 0 };
				}

				case '&': case '|': case '^': case '<<': case '>>': {
					if (ln === null || rn === null) return runtime.unknown('integer');
					const li = int(ln) | 0;
					const ri = int(rn) | 0;
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
					// string concatenation if either side is stringy.
					const ls = stringValue(l);
					const rs = stringValue(r);
					if (ls !== null && rs !== null) {
						return { kind: 'value', type: 'string', value: ls + rs };
					}
					// numeric addition
					if (ln !== null && rn !== null) {
						const isFloat = (isNumberValue(l) && l.type === 'float') || (isNumberValue(r) && r.type === 'float');
						const t: 'integer' | 'float' = isFloat ? 'float' : 'integer';
						const a = isFloat ? ln : int(ln);
						const b = isFloat ? rn : int(rn);
						const v = a + b;
						return { kind: 'value', type: t, value: v };
					}
					// list or vector/rotation addition not materialized
					return runtime.unknown('integer');
				}

				case '-':
				case '*':
				case '/': {
					if (ln === null || rn === null) return runtime.unknown('integer');
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
					const L = extractNumericVectorOrRotation(env, expr.left);
					const R = extractNumericVectorOrRotation(env, expr.right);
					if (L && R && !L.isRotation && !R.isRotation) {
						return runtime.unknown('vector'); // could compute components if you model vectors in Value
					}
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
			const name = expr.callee.name as keyof typeof runtime;
			const fn = (runtime as any)[name];
			if (typeof fn === 'function') {
				const args = expr.args.map(a => evalExpr(a, env));
				try {
					return fn(...args) as Value;
				} catch {
					return runtime.unknown('integer');
				}
			}
			// Unknown function: shape unknown by declared return type if provided
			const rt = env.functionReturnTypes?.get(expr.callee.name);
			if (rt && rt !== 'void') return asTypeUnknown(rt);
			return runtime.unknown('integer');
		}
	}

	AssertNever(expr);
	return runtime.unknown('integer');
}

const MAX_LOOP_ITERS = 1024;

class JumpSignal extends Error {
	constructor(public readonly label: string) { super(`jump ${label}`); }
}

class StateChangeSignal extends Error {
	constructor(public readonly state: string) { super(`state ${state}`); }
}

const toInt = (v: Value): number | null => {
	if (v.kind !== 'value') return null;
	if (v.type === 'integer') return (v.value | 0);
	if (v.type === 'float') return Math.trunc(v.value);
	return null;
};

const isTruthy = (v: Value): boolean | null => {
	const n = toInt(v);
	return n === null ? null : (n !== 0);
};

function resolveLabelFromExpr(target: Expr, env: Env): string | null {
	// LSL grammar uses an identifier; we allow identifier or string literal here.
	if (target.kind === 'Identifier') return target.name;
	if (target.kind === 'StringLiteral') return target.value;
	const v = evalExpr(target, env);
	return (v.kind === 'value' && v.type === 'string') ? v.value : null;
}

export function evalStmt(stmt: Stmt, env: Env = new Env()): Value | null {
	switch (stmt.kind) {
		case 'ErrorStmt':
		case 'EmptyStmt':
			return null;

		case 'ExprStmt': {
			// Evaluate for potential side effects in the future; ignore the value.
			// (Important: don't return the expression's value, or the block would terminate early.)
			evalExpr(stmt.expression, env);
			return null;
		}

		case 'VarDecl': {
			const name = stmt.name;
			const init = stmt.initializer ? evalExpr(stmt.initializer, env) : runtime.unknown(stmt.varType);
			env.setVar(name, init);
			return null;
		}

		case 'ReturnStmt':
			// Return the folded value (or null for "return;" in a void context).
			return stmt.expression ? evalExpr(stmt.expression, env) : null;

		case 'IfStmt': {
			const condVal = evalExpr(stmt.condition, env);
			const b = isTruthy(condVal);
			if (b === true) {
				return evalStmt(stmt.then, env.child());
			} else if (b === false) {
				return stmt.else ? evalStmt(stmt.else, env.child()) : null;
			} else {
				const a = evalStmt(stmt.then, env.child());
				if (a != null) return runtime.unknown(a.type);
				if (stmt.else) {
					const b = evalStmt(stmt.else, env.child());
					if (b != null) return runtime.unknown(b.type);
				}
			}
			return null;
		}

		case 'WhileStmt': {
			let iters = 0;
			for (;;) {
				const c = isTruthy(evalExpr(stmt.condition, env));
				if (c === false) break;            // known false => loop never/ends now
				if (c === null) return null;       // unknown condition => stop folding
				// c === true
				const r = evalStmt(stmt.body, env.child());
				if (r !== null) return r;          // propagate a definite return
				if (++iters > MAX_LOOP_ITERS) return null; // avoid infinite analysis
			}
			return null;
		}

		case 'DoWhileStmt': {
			let iters = 0;
			for (;;) {
				const r = evalStmt(stmt.body, env);
				if (r !== null) return r;
				const c = isTruthy(evalExpr(stmt.condition, env.child()));
				if (c === false) break;
				if (c === null) return null;
				if (++iters > MAX_LOOP_ITERS) return null;
			}
			return null;
		}

		case 'ForStmt': {
			// init
			if (stmt.init) evalExpr(stmt.init, env);
			let iters = 0;
			for (;;) {
				// condition: if absent, treat as true (infinite loop unless broken by body)
				let c: boolean | null = true;
				if (stmt.condition) {
					c = isTruthy(evalExpr(stmt.condition, env));
					if (c === false) break;
					if (c === null) return null;
				}
				// body
				const r = evalStmt(stmt.body, env.child());
				if (r !== null) return r;
				// update
				if (stmt.update) evalExpr(stmt.update, env);
				if (++iters > MAX_LOOP_ITERS) return null;
			}
			return null;
		}

		case 'JumpStmt': {
			const label = resolveLabelFromExpr(stmt.target, env);
			if (!label) {
				// Can't resolve target label statically
				return null;
			}
			// Use a signal; the nearest enclosing BlockStmt with that label will catch & reposition PC.
			throw new JumpSignal(label);
		}

		case 'LabelStmt':
			return null;

		case 'StateChangeStmt': {
			// Record the state change if the environment supports it
			const anyEnv = env as any;
			if (typeof anyEnv.setState === 'function') anyEnv.setState(stmt.state);
			else anyEnv.nextState = stmt.state;
			// In LSL, "state X;" ends the current event immediately. Signal outward to abort.
			throw new StateChangeSignal(stmt.state);
		}

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
					const out = evalStmt(s, innerEnv);
					if (out !== null) return out;
				} catch (sig: any) {
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

	AssertNever(stmt, "Unreachable statement");
	return null;
}

export const Runtime = runtime;
