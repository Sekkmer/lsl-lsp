export const NULL_KEY_VALUE = '00000000-0000-0000-0000-000000000000';

const UUID_RE = /^[0-9a-fA-F]{8}-(?:[0-9a-fA-F]{4}-){3}[0-9a-fA-F]{12}$/;

export function isKnownKeyString(value: string): boolean {
	if (value === '') return true;
	return UUID_RE.test(value.trim());
}

export function keyValueFromString(value: string): string | null {
	if (value === '') return '';
	const trimmed = value.trim();
	return UUID_RE.test(trimmed) ? trimmed.toLowerCase() : null;
}
