import type { DiagnosticSeverity, Range } from 'vscode-languageserver/node';

export const LSL_DIAGCODES = {
	SYNTAX: 'LSL000',
	UNKNOWN_IDENTIFIER: 'LSL001',
	UNKNOWN_CONST: 'LSL002',
	INVALID_ASSIGN_LHS: 'LSL050',
	WRONG_ARITY: 'LSL010',
	WRONG_TYPE: 'LSL011',
	LIST_COMPARISON_LENGTH_ONLY: 'LSL012',
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
	SUSPICIOUS_ASSIGNMENT: 'LSL051',
	RESERVED_IDENTIFIER: 'LSL060',
	DUPLICATE_DECL: 'LSL070',
} as const;
export type DiagCode = typeof LSL_DIAGCODES[keyof typeof LSL_DIAGCODES];

export interface Diag { range: Range; message: string; severity?: DiagnosticSeverity; code: DiagCode; }
export interface SymbolRef { name: string; range: Range; }
export interface Decl { name: string; range: Range; kind: 'var' | 'func' | 'state' | 'event' | 'param'; type?: string; params?: { name: string; type?: string }[]; }
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
