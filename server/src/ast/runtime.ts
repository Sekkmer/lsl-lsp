// Minimal LSL runtime helpers callable by the AST evaluator.
// Each function returns a typed value wrapper or Unknown for non-deterministic results.
import * as nodeCrypto from 'crypto';

export type LSLType = 'key' | 'list' | 'integer' | 'float' | 'rotation' | 'string' | 'vector';

type Quat = [number, number, number, number];  // [x,y,z,s]
type Vec3 = [number, number, number];

export type Unknown<T extends LSLType = LSLType> = { kind: 'unknown'; type: T };
export type IntVal = { kind: 'value'; type: 'integer'; value: number };
export type FloatVal = { kind: 'value'; type: 'float'; value: number };
export type StringVal = { kind: 'value'; type: 'string'; value: string };
export type VectorVal = { kind: 'value'; type: 'vector'; value: Vec3 };
export type RotationVal = { kind: 'value'; type: 'rotation'; value: Quat };
export type KeyVal = { kind: 'value'; type: 'key'; value: string };
export type ListVal = { kind: 'value'; type: 'list'; value: any[] };
export type Value = IntVal | FloatVal | StringVal | VectorVal | RotationVal | KeyVal | ListVal | Unknown;

// ===== Helpers & types =====
const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
const isNum = (v: Value): v is IntVal | FloatVal => v.kind === 'value' && (v.type === 'integer' || v.type === 'float');
const isStr = (v: Value): v is StringVal => v.kind === 'value' && v.type === 'string';
const isVec = (v: Value): v is VectorVal => v.kind === 'value' && v.type === 'vector';
const isRot = (v: Value): v is RotationVal => v.kind === 'value' && v.type === 'rotation';
const asFloat = (n: number): FloatVal => ({ kind: 'value', type: 'float', value: n });
const asIntVal = (n: number): IntVal => ({ kind: 'value', type: 'integer', value: n | 0 });
const asStrVal = (s: string): StringVal => ({ kind: 'value', type: 'string', value: s });
const asVecVal = (v: Vec3): VectorVal => ({ kind: 'value', type: 'vector', value: v });
const asRotVal = (q: Quat): RotationVal => ({ kind: 'value', type: 'rotation', value: q });

const i32 = (n: number) => (n | 0);
const toU8 = (n: number) => (n & 0xff);

// Quaternion helpers (LSL uses x,y,z,s where s is scalar)
const qNormalize = (q: Quat): Quat => {
	const [x, y, z, s] = q; const m = Math.hypot(x, y, z, s) || 1;
	return [x / m, y / m, z / m, s / m];
};
const qMul = (a: Quat, b: Quat): Quat => {
	const [ax, ay, az, as] = a, [bx, by, bz, bs] = b;
	return [
		as * bx + ax * bs + ay * bz - az * by,
		as * by - ax * bz + ay * bs + az * bx,
		as * bz + ax * by - ay * bx + az * bs,
		as * bs - ax * bx - ay * by - az * bz
	];
};
const qFromAxisAngle = (axis: Vec3, angle: number): Quat => {
	const [x, y, z] = axis;
	const len = Math.hypot(x, y, z);
	if (!Number.isFinite(len) || len === 0) return [0, 0, 0, 1];
	const h = angle * 0.5, s = Math.sin(h), c = Math.cos(h);
	return qNormalize([(x / len) * s, (y / len) * s, (z / len) * s, c]);
};
const qRotateVec = (q: Quat, v: Vec3): Vec3 => {
	// v' = v + 2*s*(u x v) + 2*(u x (u x v))  with q=[u,s]
	const u: Vec3 = [q[0], q[1], q[2]];
	const s = q[3];
	const cross = (a: Vec3, b: Vec3): Vec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
	const t = cross(u, v).map(c => 2 * c) as Vec3;
	const v1: Vec3 = [v[0] + s * t[0], v[1] + s * t[1], v[2] + s * t[2]];
	const t2 = cross(u, t);
	return [v1[0] + t2[0], v1[1] + t2[1], v1[2] + t2[2]];
};

// Rotation matrix <-> quaternion for Axes2Rot
const quatFromMatrix = (m: number[][]): Quat => {
	const t = m[0][0] + m[1][1] + m[2][2];
	if (t > 0) {
		const S = Math.sqrt(t + 1.0) * 2; // 4*s
		const s = 0.25 * S;
		const x = (m[2][1] - m[1][2]) / S;
		const y = (m[0][2] - m[2][0]) / S;
		const z = (m[1][0] - m[0][1]) / S;
		return qNormalize([x, y, z, s]);
	} else if (m[0][0] > m[1][1] && m[0][0] > m[2][2]) {
		const S = Math.sqrt(1.0 + m[0][0] - m[1][1] - m[2][2]) * 2;
		const x = 0.25 * S;
		const y = (m[0][1] + m[1][0]) / S;
		const z = (m[0][2] + m[2][0]) / S;
		const s = (m[2][1] - m[1][2]) / S;
		return qNormalize([x, y, z, s]);
	} else if (m[1][1] > m[2][2]) {
		const S = Math.sqrt(1.0 + m[1][1] - m[0][0] - m[2][2]) * 2;
		const x = (m[0][1] + m[1][0]) / S;
		const y = 0.25 * S;
		const z = (m[1][2] + m[2][1]) / S;
		const s = (m[0][2] - m[2][0]) / S;
		return qNormalize([x, y, z, s]);
	} else {
		const S = Math.sqrt(1.0 + m[2][2] - m[0][0] - m[1][1]) * 2;
		const x = (m[0][2] + m[2][0]) / S;
		const y = (m[1][2] + m[2][1]) / S;
		const z = 0.25 * S;
		const s = (m[1][0] - m[0][1]) / S;
		return qNormalize([x, y, z, s]);
	}
};

export const unknown = <T extends LSLType>(type: T): Unknown<T> => ({ kind: 'unknown', type });

// ===== Math functions =====

export function llAbs(arg: Value): Value {
	if (!isNum(arg)) return unknown('integer');
	return asIntVal(Math.abs(i32(arg.value)));
}

export function llFabs(arg: Value): Value {
	if (!isNum(arg)) return unknown('float');
	return asFloat(Math.abs(arg.value));
}

export function llAcos(a: Value): Value {
	if (!isNum(a)) return unknown('float');
	const n = a.value; if (n < -1 || n > 1) return unknown('float');
	return asFloat(Math.acos(n));
}

export function llAsin(a: Value): Value {
	if (!isNum(a)) return unknown('float');
	const n = a.value; if (n < -1 || n > 1) return unknown('float');
	return asFloat(Math.asin(n));
}

export function llAtan2(y: Value, x: Value): Value {
	if (!isNum(y) || !isNum(x)) return unknown('float');
	return asFloat(Math.atan2(y.value, x.value));
}

export function llCeil(a: Value): Value { if (!isNum(a)) return unknown('integer'); return asIntVal(Math.ceil(a.value)); }
export function llCos(a: Value): Value { if (!isNum(a)) return unknown('float'); return asFloat(Math.cos(a.value)); }
export function llFloor(a: Value): Value { if (!isNum(a)) return unknown('integer'); return asIntVal(Math.floor(a.value)); }
export function llLog(a: Value): Value { if (!isNum(a) || a.value <= 0) return unknown('float'); return asFloat(Math.log(a.value)); }
export function llLog10(a: Value): Value { if (!isNum(a) || a.value <= 0) return unknown('float'); return asFloat(Math.log10(a.value)); }
export function llPow(a: Value, b: Value): Value { if (!isNum(a) || !isNum(b)) return unknown('float'); return asFloat(Math.pow(a.value, b.value)); }
export function llSin(a: Value): Value { if (!isNum(a)) return unknown('float'); return asFloat(Math.sin(a.value)); }
export function llSqrt(a: Value): Value { if (!isNum(a) || a.value < 0) return unknown('float'); return asFloat(Math.sqrt(a.value)); }
export function llTan(a: Value): Value { if (!isNum(a)) return unknown('float'); return asFloat(Math.tan(a.value)); }
export function llRound(a: Value): Value {
	if (!isNum(a)) return unknown('integer');
	const n = a.value;
	const r = n > 0 ? Math.floor(n + 0.5) : Math.ceil(n - 0.5);
	return asIntVal(r);
}

// ===== String helpers =====
const toStringVal = (v: Value): string | null => v.kind === 'value' && v.type === 'string' ? v.value : null;
const toInt = (v: Value): number | null => v.kind === 'value' && v.type === 'integer' ? v.value : (v.kind === 'value' && v.type === 'float' ? Math.trunc(v.value) : null);

export function llStringLength(s: Value): Value {
	const str = toStringVal(s);
	return str === null ? unknown('integer') : { kind: 'value', type: 'integer', value: str.length };
}

export function llToLower(s: Value): Value {
	const str = toStringVal(s);
	return str === null ? unknown('string') : { kind: 'value', type: 'string', value: str.toLowerCase() };
}

export function llToUpper(s: Value): Value {
	const str = toStringVal(s);
	return str === null ? unknown('string') : { kind: 'value', type: 'string', value: str.toUpperCase() };
}

export function llSubStringIndex(haystack: Value, needle: Value): Value {
	const h = toStringVal(haystack);
	const n = toStringVal(needle);
	if (h === null || n === null) return unknown('integer');
	return { kind: 'value', type: 'integer', value: h.indexOf(n) };
}

// LSL semantics: start/end inclusive; negative indexes count from end ( -1 => last char )
function normIndex(len: number, i: number): number {
	if (!Number.isFinite(i)) return 0;
	let idx = i;
	if (idx < 0) idx = len + idx; // e.g., -1 => len-1
	if (idx < 0) idx = 0;
	if (idx >= len) idx = len - 1;
	return idx;
}

export function llGetSubString(src: Value, start: Value, end: Value): Value {
	const s = toStringVal(src);
	const a = toInt(start);
	const b = toInt(end);
	if (s === null || a === null || b === null) return unknown('string');
	if (s.length === 0) return { kind: 'value', type: 'string', value: '' };
	const i = normIndex(s.length, a);
	const j = normIndex(s.length, b);
	if (i > j) return { kind: 'value', type: 'string', value: '' };
	// end inclusive
	return { kind: 'value', type: 'string', value: s.substring(i, j + 1) };
}

export function llInsertString(dst: Value, pos: Value, src: Value): Value {
	const d = toStringVal(dst);
	const p = toInt(pos);
	const s = toStringVal(src);
	if (d === null || p === null || s === null) return unknown('string');
	let idx = p;
	if (idx < 0) idx = d.length + idx;
	if (idx < 0) idx = 0;
	if (idx > d.length) idx = d.length;
	return { kind: 'value', type: 'string', value: d.slice(0, idx) + s + d.slice(idx) };
}

export function llDeleteSubString(src: Value, start: Value, end: Value): Value {
	const s = toStringVal(src);
	const a = toInt(start);
	const b = toInt(end);
	if (s === null || a === null || b === null) return unknown('string');
	if (s.length === 0) return { kind: 'value', type: 'string', value: '' };
	const i = normIndex(s.length, a);
	const j = normIndex(s.length, b);
	if (i > j) return { kind: 'value', type: 'string', value: s };
	return { kind: 'value', type: 'string', value: s.slice(0, i) + s.slice(j + 1) };
}

export function llEscapeURL(src: Value): Value {
	const s = toStringVal(src);
	if (s === null) return unknown('string');
	try { return { kind: 'value', type: 'string', value: encodeURIComponent(s) }; } catch { return unknown('string'); }
}

export function llUnescapeURL(src: Value): Value {
	const s = toStringVal(src);
	if (s === null) return unknown('string');
	try { return { kind: 'value', type: 'string', value: decodeURIComponent(s) }; } catch { return unknown('string'); }
}

// Base64 for strings only (string<->string). Integer variants are omitted due to LSL-specific binary format.
export function llStringToBase64(src: Value): Value {
	const s = toStringVal(src);
	if (s === null) return unknown('string');
	return { kind: 'value', type: 'string', value: Buffer.from(s, 'utf8').toString('base64') };
}

export function llBase64ToString(src: Value): Value {
	const s = toStringVal(src);
	if (s === null) return unknown('string');
	try { return { kind: 'value', type: 'string', value: Buffer.from(s, 'base64').toString('utf8') }; } catch { return unknown('string'); }
}

// ===== List helpers =====
const toList = (v: Value): any[] | null => v.kind === 'value' && v.type === 'list' ? v.value : null;

export function llGetListLength(list: Value): Value {
	const arr = toList(list);
	return arr === null ? unknown('integer') : { kind: 'value', type: 'integer', value: arr.length };
}

// Inclusive slice with negative indexes
export function llList2List(list: Value, start: Value, end: Value): Value {
	const arr = toList(list);
	const a = toInt(start);
	const b = toInt(end);
	if (arr === null || a === null || b === null) return unknown('list');
	if (arr.length === 0) return { kind: 'value', type: 'list', value: [] };
	const i = normIndex(arr.length, a);
	const j = normIndex(arr.length, b);
	if (i > j) return { kind: 'value', type: 'list', value: [] };
	return { kind: 'value', type: 'list', value: arr.slice(i, j + 1) };
}

export function llDeleteSubList(list: Value, start: Value, end: Value): Value {
	const arr = toList(list);
	const a = toInt(start);
	const b = toInt(end);
	if (arr === null || a === null || b === null) return unknown('list');
	if (arr.length === 0) return { kind: 'value', type: 'list', value: [] };
	const i = normIndex(arr.length, a);
	const j = normIndex(arr.length, b);
	if (i > j) return { kind: 'value', type: 'list', value: arr.slice() };
	return { kind: 'value', type: 'list', value: [...arr.slice(0, i), ...arr.slice(j + 1)] };
}

export function llListInsertList(dest: Value, src: Value, index: Value): Value {
	const d = toList(dest);
	const s = toList(src);
	const p = toInt(index);
	if (d === null || s === null || p === null) return unknown('list');
	let idx = p;
	if (idx < 0) idx = d.length + idx;
	if (idx < 0) idx = 0;
	if (idx > d.length) idx = d.length;
	return { kind: 'value', type: 'list', value: [...d.slice(0, idx), ...s, ...d.slice(idx)] };
}

export function llListReplaceList(dest: Value, src: Value, start: Value, end: Value): Value {
	const d = toList(dest);
	const s = toList(src);
	const a = toInt(start);
	const b = toInt(end);
	if (d === null || s === null || a === null || b === null) return unknown('list');
	if (d.length === 0) return { kind: 'value', type: 'list', value: s.slice() };
	const i = normIndex(d.length, a);
	const j = normIndex(d.length, b);
	if (i > j) return { kind: 'value', type: 'list', value: d.slice() };
	return { kind: 'value', type: 'list', value: [...d.slice(0, i), ...s, ...d.slice(j + 1)] };
}

export function llListFindList(list: Value, sub: Value): Value {
	const arr = toList(list);
	const subarr = toList(sub);
	if (arr === null || subarr === null) return unknown('integer');
	if (subarr.length === 0) return { kind: 'value', type: 'integer', value: 0 };
	// naive search
	for (let i = 0; i <= arr.length - subarr.length; i++) {
		let ok = true;
		for (let j = 0; j < subarr.length; j++) {
			if (arr[i + j] !== subarr[j]) { ok = false; break; }
		}
		if (ok) return { kind: 'value', type: 'integer', value: i };
	}
	return { kind: 'value', type: 'integer', value: -1 };
}

export function llDumpList2String(list: Value, sep: Value): Value {
	const arr = toList(list);
	const s = toStringVal(sep);
	if (arr === null || s === null) return unknown('string');
	return { kind: 'value', type: 'string', value: arr.map(x => String(x)).join(s) };
}

// ===== Vector math helpers (when actual values are present) =====
const toVector = (v: Value): [number, number, number] | null => v.kind === 'value' && v.type === 'vector' ? v.value : null;

export function llVecMag(v: Value): Value {
	const vec = toVector(v);
	if (!vec) return unknown('float');
	const [x, y, z] = vec; return { kind: 'value', type: 'float', value: Math.sqrt(x * x + y * y + z * z) };
}

export function llVecNorm(v: Value): Value {
	const vec = toVector(v);
	if (!vec) return unknown('vector');
	const [x, y, z] = vec; const m = Math.sqrt(x * x + y * y + z * z);
	if (m === 0) return unknown('vector');
	return { kind: 'value', type: 'vector', value: [x / m, y / m, z / m] };
}

export function llVecDist(a: Value, b: Value): Value {
	const va = toVector(a); const vb = toVector(b);
	if (!va || !vb) return unknown('float');
	const dx = va[0] - vb[0], dy = va[1] - vb[1], dz = va[2] - vb[2];
	return { kind: 'value', type: 'float', value: Math.sqrt(dx * dx + dy * dy + dz * dz) };
}

// ===== Hash / crypto =====
export function llMD5String(src: Value, nonce: Value): Value {
	if (!isStr(src) || !isNum(nonce)) return unknown('string');
	const input = `${src.value}:${i32(nonce.value)}`;
	try {
		const d = nodeCrypto.createHash('md5').update(input, 'utf8').digest('hex');
		return asStrVal(d);
	} catch { return unknown('string'); }
}

export function llSHA1String(src: Value): Value {
	if (!isStr(src)) return unknown('string');
	try { return asStrVal(nodeCrypto.createHash('sha1').update(src.value, 'utf8').digest('hex')); }
	catch { return unknown('string'); }
}

export function llComputeHash(message: Value, algorithm: Value): Value {
	if (!isStr(message) || !isStr(algorithm)) return unknown('string');
	const alg = algorithm.value.toLowerCase();
	const supported = new Set(['md5', 'md5_sha1', 'sha1', 'sha224', 'sha256', 'sha384', 'sha512']);
	if (!supported.has(alg)) return unknown('string');
	try {
		if (alg === 'md5_sha1') {
			const md5 = nodeCrypto.createHash('md5').update(message.value, 'utf8').digest();
			const sha1 = nodeCrypto.createHash('sha1').update(message.value, 'utf8').digest();
			return asStrVal(Buffer.concat([md5, sha1]).toString('hex'));
		}
		return asStrVal(nodeCrypto.createHash(alg).update(message.value, 'utf8').digest('hex'));
	} catch { return unknown('string'); }
}

export function llHMAC(message: Value, key: Value, algorithm: Value): Value {
	if (!isStr(message) || !isStr(key) || !isStr(algorithm)) return unknown('string');
	const alg = algorithm.value.toLowerCase();
	try {
		const h = nodeCrypto.createHmac(alg, key.value).update(message.value, 'utf8').digest('base64');
		return asStrVal(h);
	} catch { return unknown('string'); }
}

// ===== Base64 <-> integer (big-endian) =====
export function llIntegerToBase64(number: Value): Value {
	if (!isNum(number)) return unknown('string');
	const n = i32(number.value);
	const buf = Buffer.allocUnsafe(4);
	// big-endian
	buf[0] = toU8(n >>> 24);
	buf[1] = toU8(n >>> 16);
	buf[2] = toU8(n >>> 8);
	buf[3] = toU8(n);
	return asStrVal(buf.toString('base64')); // padding "==" present; callers may trim
}

export function llBase64ToInteger(str: Value): Value {
	if (!isStr(str)) return unknown('integer');
	try {
		const raw = Buffer.from(str.value, 'base64');
		if (raw.length > 4) return asIntVal(0);
		// big-endian assemble; missing low bytes are 0 per spec
		let v = 0;
		for (let i = 0; i < raw.length; i++) v = (v << 8) | (raw[i] & 0xff);
		// sign-extend if full 4 bytes
		if (raw.length === 4) v = (v << 0) >> 0;
		return asIntVal(v);
	} catch { return asIntVal(0); }
}

// ===== String utilities =====
export function llStringTrim(src: Value, type: Value): Value {
	if (!isStr(src) || !isNum(type)) return unknown('string');
	const t = i32(type.value);
	const head = (t & 0x01) !== 0, tail = (t & 0x02) !== 0;
	let s = src.value;
	if (head) s = s.replace(/^[ \t\n\r]+/, '');
	if (tail) s = s.replace(/[ \t\n\r]+$/, '');
	return asStrVal(s);
}

export function llReplaceSubString(src: Value, pattern: Value, repl: Value, count: Value): Value {
	if (!isStr(src) || !isStr(pattern) || !isStr(repl) || !isNum(count)) return unknown('string');
	const pat = pattern.value; const rep = repl.value; let c = i32(count.value);
	if (pat.length === 0 || c === 0) {
		// replace all when count==0
		if (c === 0 && pat.length > 0) return asStrVal(src.value.split(pat).join(rep));
		return asStrVal(src.value);
	}
	let s = src.value;
	if (c > 0) {
		while (c-- > 0) {
			const i = s.indexOf(pat); if (i < 0) break;
			s = s.slice(0, i) + rep + s.slice(i + pat.length);
		}
	} else { // negative => from right
		c = -c;
		while (c-- > 0) {
			const i = s.lastIndexOf(pat); if (i < 0) break;
			s = s.slice(0, i) + rep + s.slice(i + pat.length);
		}
	}
	return asStrVal(s);
}

export function llChar(code: Value): Value {
	if (!isNum(code)) return unknown('string');
	const cp = i32(code.value);
	if (cp <= 0) return asStrVal('');
	try { return asStrVal(String.fromCodePoint(cp)); }
	catch { return asStrVal(''); }
}

export function llOrd(s: Value, index: Value): Value {
	if (!isStr(s) || !isNum(index)) return unknown('integer');
	const arr = Array.from(s.value);
	let i = i32(index.value);
	if (i < 0) i = arr.length + i;
	if (i < 0 || i >= arr.length) return asIntVal(0);
	return asIntVal(arr[i]!.codePointAt(0)!);
}

// ===== CSV (LSL flavor) =====
export function llCSV2List(src: Value): Value {
	if (!isStr(src)) return unknown('list');
	const s = src.value;
	const out: string[] = [];
	let i = 0, cur = '';
	let inAngle = 0;
	while (i < s.length) {
		const ch = s[i]!;
		if (ch === '<') { inAngle++; cur += ch; i++; continue; }
		if (ch === '>') { if (inAngle > 0) inAngle--; cur += ch; i++; continue; }
		if (ch === ',' && inAngle === 0) {
			out.push(cur); cur = ''; i++;
			// consume one leading space from next token per LSL behavior
			if (s[i] === ' ') i++;
			continue;
		}
		cur += ch; i++;
	}
	out.push(cur);
	return { kind: 'value', type: 'list', value: out };
}

// ===== List conversions / slices / sort / stats =====
const toIndex = (len: number, idx: number) => {
	let i = i32(idx); if (i < 0) i = len + i;
	return clamp(i, 0, Math.max(0, len - 1));
};
const fromList = (v: Value) => v.kind === 'value' && v.type === 'list' ? v.value : null;

export function llList2Integer(list: Value, index: Value): Value {
	const arr = fromList(list); if (!arr || !isNum(index)) return unknown('integer');
	const i = i32(index.value); if (i < -arr.length || i >= arr.length) return asIntVal(0);
	const j = i < 0 ? arr.length + i : i;
	const x = arr[j];
	if (typeof x === 'number') return asIntVal(x);
	if (typeof x === 'string') {
		// decimal or 0x... hex gets parsed per wiki caveat
		const m = x.trim().match(/^([+-]?0x[0-9a-f]+|[+-]?\d+)/i);
		return asIntVal(m ? parseInt(m[1], 0) : 0);
	}
	return asIntVal(0);
}

export function llList2Float(list: Value, index: Value): Value {
	const arr = fromList(list); if (!arr || !isNum(index)) return unknown('float');
	const i = i32(index.value); if (i < -arr.length || i >= arr.length) return asFloat(0);
	const j = i < 0 ? arr.length + i : i;
	const x = arr[j];
	if (typeof x === 'number') return asFloat(x);
	if (typeof x === 'string') {
		const n = Number(x); return Number.isFinite(n) ? asFloat(n) : asFloat(0);
	}
	return asFloat(0);
}

export function llList2String(list: Value, index: Value): Value {
	const arr = fromList(list); if (!arr || !isNum(index)) return unknown('string');
	const i = i32(index.value); if (i < -arr.length || i >= arr.length) return asStrVal('');
	const j = i < 0 ? arr.length + i : i;
	return asStrVal(String(arr[j] ?? ''));
}

export function llList2Key(list: Value, index: Value): Value {
	const arr = fromList(list); if (!arr || !isNum(index)) return unknown('string');
	const i = i32(index.value); if (i < -arr.length || i >= arr.length) return asStrVal('');
	const j = i < 0 ? arr.length + i : i;
	const x = arr[j];
	return asStrVal(typeof x === 'string' ? x : String(x));
}

export function llList2Vector(list: Value, index: Value): Value {
	const arr = fromList(list); if (!arr || !isNum(index)) return unknown('vector');
	const i = i32(index.value); if (i < -arr.length || i >= arr.length) return asVecVal([0, 0, 0]);
	const j = i < 0 ? arr.length + i : i;
	const x = arr[j];
	if (Array.isArray(x) && x.length === 3) return asVecVal([+x[0], +x[1], +x[2]]);
	if (typeof x === 'string') {
		const m = x.match(/<\s*([^,>]+)\s*,\s*([^,>]+)\s*,\s*([^,>]+)\s*>/);
		if (m) {
			const a = [Number(m[1]), Number(m[2]), Number(m[3])];
			if (a.every(Number.isFinite)) return asVecVal(a as Vec3);
		}
	}
	return asVecVal([0, 0, 0]);
}

export function llList2Rot(list: Value, index: Value): Value {
	const arr = fromList(list); if (!arr || !isNum(index)) return unknown('rotation');
	const i = i32(index.value); if (i < -arr.length || i >= arr.length) return asRotVal([0, 0, 0, 1]);
	const j = i < 0 ? arr.length + i : i;
	const x = arr[j];
	if (Array.isArray(x) && x.length === 4) return asRotVal([+x[0], +x[1], +x[2], +x[3]]);
	if (typeof x === 'string') {
		const m = x.match(/<\s*([^,>]+)\s*,\s*([^,>]+)\s*,\s*([^,>]+)\s*,\s*([^,>]+)\s*>/);
		if (m) {
			const a = [Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4])];
			if (a.every(Number.isFinite)) return asRotVal(a as Quat);
		}
	}
	return asRotVal([0, 0, 0, 1]);
}

export function llList2ListStrided(list: Value, start: Value, end: Value, stride: Value): Value {
	const arr = fromList(list); if (!arr || !isNum(start) || !isNum(end) || !isNum(stride)) return unknown('list');
	const st = Math.max(1, i32(stride.value));
	if (!arr.length) return { kind: 'value', type: 'list', value: [] };
	const i0 = toIndex(arr.length, start.value);
	const j0 = toIndex(arr.length, end.value);
	const range: any[] = [];
	if (i0 <= j0) {
		for (let i = i0; i <= j0; i += st) range.push(arr[i]);
	} else {
		for (let i = 0; i <= j0; i += st) range.push(arr[i]);
		for (let i = i0; i < arr.length; i += st) range.push(arr[i]);
	}
	return { kind: 'value', type: 'list', value: range };
}

export function llList2ListSlice(list: Value, start: Value, end: Value, stride: Value, sliceIdx: Value): Value {
	const arr = fromList(list); if (!arr || !isNum(start) || !isNum(end) || !isNum(stride) || !isNum(sliceIdx)) return unknown('list');
	const st = Math.max(1, i32(stride.value)); let si = i32(sliceIdx.value);
	if (si < 0) si = st + si;
	const i0 = toIndex(arr.length, start.value);
	const j0 = toIndex(arr.length, end.value);
	const out: any[] = [];
	const collect = (from: number, to: number) => {
		for (let i = from; i <= to; i += st) {
			const base = i - (i % st);
			const k = base + si;
			if (k >= 0 && k < arr.length) out.push(arr[k]);
		}
	};
	if (i0 <= j0) collect(i0, j0); else { collect(0, j0); collect(i0, arr.length - 1); }
	return { kind: 'value', type: 'list', value: out };
}

export function llListSort(list: Value, stride: Value, ascending: Value): Value {
	const arr = fromList(list); if (!arr || !isNum(stride) || !isNum(ascending)) return unknown('list');
	const st = Math.max(1, i32(stride.value));
	const asc = i32(ascending.value) !== 0;
	if (arr.length === 0) return { kind: 'value', type: 'list', value: [] };
	const chunks: any[][] = [];
	for (let i = 0; i < arr.length; i += st) chunks.push(arr.slice(i, Math.min(arr.length, i + st)));
	const key = (x: any) => (typeof x === 'number') ? x : String(x);
	chunks.sort((a, b) => {
		const ka = key(a[0]), kb = key(b[0]);
		if (ka < kb) return asc ? -1 : 1;
		if (ka > kb) return asc ? 1 : -1;
		return 0;
	});
	return { kind: 'value', type: 'list', value: chunks.flat() };
}

export const LIST_STAT = {
	RANGE: 0, MIN: 1, MAX: 2, MEAN: 3, MEDIAN: 4, STD_DEV: 5,
	SUM: 6, SUM_SQUARES: 7, NUM_COUNT: 8, GEOMETRIC_MEAN: 9,
} as const;

export function llListStatistics(operation: Value, list: Value): Value {
	if (!isNum(operation)) return unknown('float');
	const arr = fromList(list); if (!arr) return unknown('float');
	const nums = arr.filter(x => typeof x === 'number').map(x => Number(x));
	if (nums.length === 0) return asFloat(0);
	const op = i32(operation.value);
	const sum = nums.reduce((a, b) => a + b, 0);
	const mean = sum / nums.length;
	switch (op) {
		case LIST_STAT.RANGE: return asFloat(Math.max(...nums) - Math.min(...nums));
		case LIST_STAT.MIN: return asFloat(Math.min(...nums));
		case LIST_STAT.MAX: return asFloat(Math.max(...nums));
		case LIST_STAT.MEAN: return asFloat(mean);
		case LIST_STAT.MEDIAN: {
			const s = nums.slice().sort((a, b) => a - b); const mid = s.length >> 1;
			return asFloat(s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2);
		}
		case LIST_STAT.STD_DEV: {
			const v = nums.reduce((a, b) => a + (b - mean) * (b - mean), 0) / nums.length;
			return asFloat(Math.sqrt(v));
		}
		case LIST_STAT.SUM: return asFloat(sum);
		case LIST_STAT.SUM_SQUARES: return asFloat(nums.reduce((a, b) => a + b * b, 0));
		case LIST_STAT.NUM_COUNT: return asFloat(nums.length);
		case LIST_STAT.GEOMETRIC_MEAN: {
			// Only defined for same-sign numbers; otherwise return 0 (common practice in examples)
			if (nums.some(n => n === 0) || nums.some(n => Math.sign(n) !== Math.sign(nums[0]!))) return asFloat(0);
			const g = Math.exp(nums.reduce((a, b) => a + Math.log(Math.abs(b)), 0) / nums.length);
			return asFloat(Math.sign(nums[0]!) * g);
		}
	}
	return unknown('float');
}

// ===== XOR Base64 =====
export function llXorBase64(s1: Value, s2: Value): Value {
	if (!isStr(s1) || !isStr(s2)) return unknown('string');
	try {
		const a = Buffer.from(s1.value, 'base64');
		const b = Buffer.from(s2.value, 'base64');
		if (a.length === 0 || b.length === 0) return unknown('string');
		const out = Buffer.allocUnsafe(a.length);
		for (let i = 0; i < a.length; i++) out[i] = a[i] ^ b[i % b.length];
		return asStrVal(out.toString('base64'));
	} catch { return unknown('string'); }
}

// ===== Vectors & rotations =====

// llEuler2Rot: Euler angles (x=roll, y=pitch, z=yaw), order Z*Y*X
export function llEuler2Rot(e: Value): Value {
	if (!isVec(e)) return unknown('rotation');
	const [ex, ey, ez] = e.value;
	const qx = qFromAxisAngle([1, 0, 0], ex);
	const qy = qFromAxisAngle([0, 1, 0], ey);
	const qz = qFromAxisAngle([0, 0, 1], ez);
	const q = qMul(qMul(qz, qy), qx);
	return asRotVal(qNormalize(q));
}

export function llRot2Euler(r: Value): Value {
	if (!isRot(r)) return unknown('vector');
	const [x, y, z, s] = qNormalize(r.value);
	// Build matrix then extract ZYX
	const m00 = 1 - 2 * (y * y + z * z);
	const m10 = 2 * (x * y + z * s);
	const m20 = 2 * (x * z - y * s);
	const m21 = 2 * (y * z + x * s);
	const m22 = 1 - 2 * (x * x + y * y);
	const pitch = Math.asin(clamp(-m20, -1, 1));   // y
	const roll = Math.atan2(m21, m22);            // x
	const yaw = Math.atan2(m10, m00);            // z
	return asVecVal([roll, pitch, yaw]);
}

export function llAxisAngle2Rot(axis: Value, angle: Value): Value {
	if (!isVec(axis) || !isNum(angle)) return unknown('rotation');
	return asRotVal(qFromAxisAngle(axis.value, angle.value));
}

export function llAxes2Rot(fwd: Value, left: Value, up: Value): Value {
	if (!isVec(fwd) || !isVec(left) || !isVec(up)) return unknown('rotation');
	const F = fwd.value, L = left.value, U = up.value;
	const M = [
		[F[0], L[0], U[0]],
		[F[1], L[1], U[1]],
		[F[2], L[2], U[2]],
	];
	return asRotVal(quatFromMatrix(M));
}

export function llRot2Fwd(r: Value): Value {
	if (!isRot(r)) return unknown('vector');
	return asVecVal(qRotateVec(r.value, [1, 0, 0]));
}
export function llRot2Left(r: Value): Value {
	if (!isRot(r)) return unknown('vector');
	return asVecVal(qRotateVec(r.value, [0, 1, 0]));
}
export function llRot2Up(r: Value): Value {
	if (!isRot(r)) return unknown('vector');
	return asVecVal(qRotateVec(r.value, [0, 0, 1]));
}

export function llRot2Angle(r: Value): Value {
	if (!isRot(r)) return unknown('float');
	const s = clamp(Math.abs(qNormalize(r.value)[3]), -1, 1);
	return asFloat(2 * Math.acos(s));
}

export function llRot2Axis(r: Value): Value {
	if (!isRot(r)) return unknown('vector');
	const q = qNormalize(r.value);
	const sinHalf = Math.sqrt(1 - q[3] * q[3]);
	if (sinHalf < 1e-6) return asVecVal([1, 0, 0]); // arbitrary when angle ~ 0
	return asVecVal([q[0] / sinHalf, q[1] / sinHalf, q[2] / sinHalf]);
}

export function llAngleBetween(a: Value, b: Value): Value {
	if (!isRot(a) || !isRot(b)) return unknown('float');
	const qa = qNormalize(a.value), qb = qNormalize(b.value);
	const dot = clamp(qa[0] * qb[0] + qa[1] * qb[1] + qa[2] * qb[2] + qa[3] * qb[3], -1, 1);
	// minimal angle between orientations
	return asFloat(2 * Math.acos(Math.abs(dot)));
}

export function llRotBetween(a: Value, b: Value): Value {
	if (!isVec(a) || !isVec(b)) return unknown('rotation');
	// Vector-to-vector rotation: rotate unit A to unit B
	let va = a.value, vb = b.value;
	const la = Math.hypot(...va), lb = Math.hypot(...vb);
	if (la === 0 || lb === 0) return unknown('rotation');
	va = [va[0] / la, va[1] / la, va[2] / la];
	vb = [vb[0] / lb, vb[1] / lb, vb[2] / lb];
	const cross: Vec3 = [va[1] * vb[2] - va[2] * vb[1], va[2] * vb[0] - va[0] * vb[2], va[0] * vb[1] - va[1] * vb[0]];
	const dot = clamp(va[0] * vb[0] + va[1] * vb[1] + va[2] * vb[2], -1, 1);
	if (dot > 0.999999) return asRotVal([0, 0, 0, 1]); // same
	if (dot < -0.999999) {
		// 180°: pick an orthogonal axis
		const axis = Math.abs(va[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0];
		const ortho: Vec3 = [
			va[1] * axis[2] - va[2] * axis[1],
			va[2] * axis[0] - va[0] * axis[2],
			va[0] * axis[1] - va[1] * axis[0]
		];
		return asRotVal(qFromAxisAngle(ortho, Math.PI));
	}
	const s = Math.sqrt((1 + dot) * 2);
	const invs = 1 / s;
	return asRotVal([cross[0] * invs, cross[1] * invs, cross[2] * invs, s * 0.5]);
}
