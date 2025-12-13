import type { DiagnosticSeverity, Range } from 'vscode-languageserver/node';

export const LSL_DIAGCODES = {
	SYNTAX: 'LSL000',
	UNKNOWN_IDENTIFIER: 'LSL001',
	UNKNOWN_CONST: 'LSL002',
	INVALID_ASSIGN_LHS: 'LSL050',
	WRONG_ARITY: 'LSL010',
	WRONG_TYPE: 'LSL011',
	LIST_COMPARISON_LENGTH_ONLY: 'LSL012',
	IMPLICIT_STRING_TO_KEY: 'LSL013',
	EVENT_OUTSIDE_STATE: 'LSL020',
	UNKNOWN_EVENT: 'LSL021',
	UNKNOWN_STATE: 'LSL030',
	ILLEGAL_STATE_DECL: 'LSL022',
	ILLEGAL_STATE_CHANGE: 'LSL023',
	EMPTY_EVENT_BODY: 'LSL024',
	EMPTY_FUNCTION_BODY: 'LSL025',
	EMPTY_IF_BODY: 'LSL026',
	EMPTY_ELSE_BODY: 'LSL027',
	MISSING_RETURN: 'LSL040',
	RETURN_IN_VOID: 'LSL041',
	RETURN_WRONG_TYPE: 'LSL042',
	REDUNDANT_CAST: 'LSL080',
	DEAD_CODE: 'LSL052',
	UNUSED_VAR: 'LSL100',
	UNUSED_LOCAL: 'LSL101',
	UNUSED_PARAM: 'LSL102',
	UNDERSCORE_PARAM_USED: 'LSL103',
	MUST_USE_RESULT: 'LSL104',
	SUSPICIOUS_ASSIGNMENT: 'LSL051',
	RESERVED_IDENTIFIER: 'LSL060',
	DUPLICATE_DECL: 'LSL070',
} as const;
export type DiagCode = typeof LSL_DIAGCODES[keyof typeof LSL_DIAGCODES];

const DIAG_VALUE_SET = new Set<string>(Object.values(LSL_DIAGCODES));

// Build name->code mapping from the enum to avoid duplication. Hard-error codes (< LSL010) only keep numeric form.
const DIAG_NAME_MAP: Record<string, DiagCode> = (() => {
	const map: Record<string, DiagCode> = {};
	for (const [enumName, code] of Object.entries(LSL_DIAGCODES)) {
		const m = /^LSL(\d+)/i.exec(code);
		const num = m ? parseInt(m[1]!, 10) : 999;
		// Skip friendly-name aliases for very-low codes (treated as hard errors), but numeric still works
		if (Number.isFinite(num) && num < 10) continue;
		const canon = enumName.toLowerCase().replace(/_/g, '-');
		map[canon] = code as DiagCode;
	}
	return map;
})();

export function normalizeDiagCode(raw: string | null | undefined): DiagCode | null {
	if (!raw) return null;
	const trimmed = raw.trim();
	if (!trimmed) return null;
	const upper = trimmed.toUpperCase();
	if (DIAG_VALUE_SET.has(upper)) return upper as DiagCode;
	const canon = trimmed.toLowerCase().replace(/[-_]/g, '-');
	return DIAG_NAME_MAP[canon] ?? null;
}

export interface Diag { range: Range; message: string; severity?: DiagnosticSeverity; code: DiagCode; }
export interface SymbolRef { name: string; range: Range; }
export interface Decl {
	name: string;
	// range should point to the identifier name itself (tight range used for highlights/rename)
	range: Range;
	kind: 'var' | 'func' | 'state' | 'event' | 'param';
	type?: string;
	params?: { name: string; type?: string }[];
	// Optional extended ranges for richer context (when available from AST):
	// fullRange covers the entire declaration (header + body block)
	fullRange?: Range;
	// headerRange covers only the declaration header before the opening '{'
	headerRange?: Range;
	// bodyRange covers only the body block between '{' and the matching '}'
	bodyRange?: Range;
}
export interface Analysis {
	diagnostics: Diag[];
	decls: Decl[];
	refs: SymbolRef[];
	calls: { name: string; args: number; range: Range; argRanges: Range[] }[];
	states: Map<string, Decl>;
	functions: Map<string, Decl>;
	symbolAt(offset: number): Decl | null;
	refAt(offset: number): Decl | null;
}
