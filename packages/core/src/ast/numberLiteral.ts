export type NumberLiteralType = 'integer' | 'float';

const DECIMAL_INTEGER = /^[+-]?\d+$/;
// SL accepts f/F only when a decimal point is present: 1.e3F is valid,
// but 1e3f and 1f are not (native compiler probes in .local).
const DECIMAL_FLOAT = /^[+-]?(?:(?:\d+\.\d*|\.\d+)(?:[eE][+-]?\d+)?[fF]?|\d+[eE][+-]?\d+)$/;
const HEX_INTEGER = /^[+-]?0x[0-9a-f]+$/i;

// Literal parsing must consume the entire token. String casts intentionally
// accept numeric prefixes, but source literals such as 1e+ must not become 1.
export function isNumberLiteral(raw: string): boolean {
	const text = raw.trim();
	return DECIMAL_INTEGER.test(text) || DECIMAL_FLOAT.test(text) || HEX_INTEGER.test(text);
}

export function numberLiteralType(rawIn: string): NumberLiteralType {
	const raw = rawIn.trim().replace(/^[+-]/, '');
	if (/^0x/i.test(raw)) return /[.pP]/.test(raw) ? 'float' : 'integer';
	return /[.eEfF]/.test(raw) ? 'float' : 'integer';
}

export function parseNumberLiteral(rawIn: string): { type: NumberLiteralType; value: number } | null {
	let raw = rawIn.trim();
	if (!isNumberLiteral(raw)) return null;

	if (/^[+-]?0x[0-9a-f]+$/i.test(raw)) {
		const sign = raw.startsWith('-') ? -1 : 1;
		raw = raw.replace(/^[+-]/, '');
		const value = sign * parseInt(raw, 16);
		return Number.isFinite(value) ? { type: 'integer', value } : null;
	}

	const value = Number(raw.replace(/[fF]$/, ''));
	return Number.isFinite(value) ? { type: numberLiteralType(raw), value } : null;
}

export function parseHexFloat(s: string): number | null {
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
