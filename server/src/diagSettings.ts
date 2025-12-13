import { Diag, type DiagCode, normalizeDiagCode } from './analysisTypes';

// Parse user-provided disabled diagnostics (codes or friendly names) into canonical codes.
export function parseDisabledDiagList(input: unknown): Set<DiagCode> {
	const out = new Set<DiagCode>();
	const push = (raw: unknown) => {
		if (typeof raw !== 'string') return;
		const norm = normalizeDiagCode(raw);
		if (norm) out.add(norm);
	};
	if (Array.isArray(input)) {
		for (const it of input) push(it);
		return out;
	}
	if (typeof input === 'string') {
		for (const token of input.split(/[,\s]+/)) {
			if (!token) continue;
			push(token);
		}
	}
	return out;
}

// Filter diagnostics using the disabled set; returns a new array.
export function filterDiagnostics(diags: ReadonlyArray<Diag>, disabled: ReadonlySet<DiagCode>): Diag[] {
	if (!disabled.size) return [...diags];
	return diags.filter(d => !disabled.has(d.code));
}
