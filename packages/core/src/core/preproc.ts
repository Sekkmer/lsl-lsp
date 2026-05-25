import type { MacroDefines } from './macro';
import type { Token } from './tokens';
import type { Type } from '../ast/types';

export type DisabledRange = { start: number; end: number; file?: string };
export type DynamicMacros = Record<string, Type>;

export type DiagDirectives = {
	disableLine: Map<number, Set<string> | null>;
	disableNextLine: Map<number, Set<string> | null>;
	blocks: { start: number; end: number; codes: Set<string> | null }[];
};

export type ConditionalBranch = { span: { start: number; end: number }; active: boolean };
export type ConditionalGroup = { head: { start: number; end: number }; branches: ConditionalBranch[]; end: number };

export type PreprocDiagnostic = { start: number; end: number; message: string; code?: string; file?: string };

export interface PreprocResult {
	disabledRanges: DisabledRange[];
	inactiveRanges?: DisabledRange[];
	macros: MacroDefines;
	dynamicMacros?: DynamicMacros;
	funcMacros: Record<string, string>;
	macroDefs?: Record<string, { start: number; end: number; file: string }>;
	includes: string[];
	includeTargets?: { start: number; end: number; file: string; resolved: string | null }[];
	missingIncludes?: { start: number; end: number; file: string }[];
	preprocDiagnostics?: PreprocDiagnostic[];
	diagDirectives?: DiagDirectives;
	conditionalGroups?: ConditionalGroup[];
	expandedTokens?: Token[];
}
