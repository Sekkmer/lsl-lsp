export type DisabledRange = { start: number; end: number };

export type DiagDirectives = {
	disableLine: Map<number, Set<string> | null>;
	disableNextLine: Map<number, Set<string> | null>;
	blocks: { start: number; end: number; codes: Set<string> | null }[];
};

export type ConditionalBranch = { span: { start: number; end: number }; active: boolean };
export type ConditionalGroup = { head: { start: number; end: number }; branches: ConditionalBranch[]; end: number };

export interface PreprocResult {
	disabledRanges: DisabledRange[];
	macros: import('./macro').MacroDefines;
	funcMacros: Record<string, string>;
	includes: string[];
	// Optional compatibility fields for existing consumers
	includeSymbols?: Map<string, import('../includeSymbols').IncludeInfo>;
	includeTargets?: { start: number; end: number; file: string; resolved: string | null }[];
	missingIncludes?: { start: number; end: number; file: string }[];
	preprocDiagnostics?: { start: number; end: number; message: string; code?: string }[];
	diagDirectives?: DiagDirectives;
	conditionalGroups?: ConditionalGroup[];
}
