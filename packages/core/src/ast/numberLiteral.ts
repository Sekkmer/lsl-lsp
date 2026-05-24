export type NumberLiteralType = 'integer' | 'float';

export function numberLiteralType(rawIn: string): NumberLiteralType {
	const raw = rawIn.trim().replace(/^[+-]/, '');
	if (/^0x/i.test(raw)) return /[.pP]/.test(raw) ? 'float' : 'integer';
	return /[.eE]/.test(raw) ? 'float' : 'integer';
}

export function parseNumberLiteral(rawIn: string): { type: NumberLiteralType; value: number } | null {
	let raw = rawIn.trim();

	if (/^[+-]?0x[0-9a-f]+$/i.test(raw)) {
		const sign = raw.startsWith('-') ? -1 : 1;
		raw = raw.replace(/^[+-]/, '');
		const value = sign * parseInt(raw, 16);
		return Number.isFinite(value) ? { type: 'integer', value } : null;
	}

	if (/^[+-]?0x[0-9a-f]+(?:\.[0-9a-f]*)?(?:p[+-]?\d+)?$/i.test(raw)) {
		const value = parseHexFloat(raw);
		return Number.isFinite(value) ? { type: 'float', value: value! } : null;
	}

	if (/[pP]/.test(raw)) return null;
	if (/[.eE]/.test(raw)) {
		const value = Number.parseFloat(raw);
		return Number.isFinite(value) ? { type: 'float', value } : null;
	}

	const value = Number.parseInt(raw, 10);
	return Number.isFinite(value) ? { type: 'integer', value } : null;
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
