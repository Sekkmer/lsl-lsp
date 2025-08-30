// Deprecated: legacy token-based analyzer removed. AST pipeline is the only path.
// This file now only re-exports analysis types and diagnostic codes for any lingering imports.
export {
	LSL_DIAGCODES,
	type DiagCode,
	type Diag,
	type SymbolRef,
	type Decl,
	type Analysis,
} from './analysisTypes';
