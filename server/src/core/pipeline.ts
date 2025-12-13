import path from 'node:path';
// fs will be provided via opts.fs or required dynamically to allow testing
import type { Token } from './tokens';
import { Tokenizer } from './tokenizer';
import { type MacroDefines, type IncludeResolver, preprocessAndExpandNew, MacroConditionalProcessor } from './macro';
import type { ConditionalGroup } from './preproc';
import { normalizeDiagCode } from '../analysisTypes';

// Maintain previous macro snapshot for delta detection between successive preprocessForAst calls
const _prevMacroSnapshot: { macros: Record<string, unknown> } = { macros: {} };

export type IncludeResolverOptions = {
	includePaths: string[];
	fromPath?: string; // absolute path of the current file for relative includes
	fs?: typeof import('node:fs');
};

// Simple include resolver with minimal caching; legacy tests expect ability to clear cache.
type CachedEntry = { id: string; tokens: Token[]; mtimeMs: number };
const includeCache = new Map<string, CachedEntry>();
export function clearIncludeResolverCache() { includeCache.clear(); }

export function buildIncludeResolver(opts: IncludeResolverOptions & { fs?: typeof import('node:fs') }): IncludeResolver {
	return (target, fromId) => {
		const fs = opts.fs || require('node:fs');
		// resolve relative to including file first, then search includePaths
		const candidates: string[] = [];
		if (fromId) {
			const baseDir = path.dirname(fromId);
			candidates.push(path.join(baseDir, target));
		}
		for (const p of opts.includePaths) candidates.push(path.join(p, target));
		for (const filePath of candidates) {
			try {
				const stat = fs.statSync(filePath);
				const prev = includeCache.get(filePath);
				if (prev && prev.mtimeMs === stat.mtimeMs) return { id: prev.id, tokens: prev.tokens };
				const src = fs.readFileSync(filePath, 'utf8');
				const tz = new Tokenizer(src);
				const toks: Token[] = [];
				for (;;) { const t = tz.next(); if (!t.file || t.file === '<unknown>') (t as Token).file = filePath; toks.push(t); if (t.kind === 'eof') break; }
				includeCache.set(filePath, { id: filePath, tokens: toks, mtimeMs: stat.mtimeMs });
				return { id: filePath, tokens: toks };
			} catch { /* try next */ }
		}
		return null;
	};
}

export function preprocessForAst(text: string, opts: IncludeResolverOptions & { defines?: MacroDefines }): {
	macros: MacroDefines;
	funcMacros: Record<string, string>;
	includes: string[];
	disabledRanges: { start: number; end: number }[];
	includeTargets?: { start: number; end: number; file: string; resolved: string | null }[];
	missingIncludes?: { start: number; end: number; file: string }[];
	preprocDiagnostics?: { start: number; end: number; message: string; code?: string }[];
	diagDirectives?: import('./preproc').DiagDirectives;
	conditionalGroups?: ConditionalGroup[];
	expandedTokens: Token[]; // active-only tokens (inactive conditional branches removed)
	expandedAllTokens?: Token[]; // full token stream including inactive branches for semtok/introspection
	macrosChanged: boolean;
	changedKeys: string[];
} {
	// Tokenize root file
	const tz = new Tokenizer(text);
	const rootTokens: Token[] = [];
	for (;;) { const t = tz.next(); if (!t.file || t.file === '<unknown>') (t as Token).file = opts.fromPath ? opts.fromPath : '<unknown>'; rootTokens.push(t); if (t.kind === 'eof') break; }
	// Run new unified preprocessor (includes + macro expansion)
	const resolver = buildIncludeResolver(opts);
	const initialDefines: MacroDefines = opts.defines ? { ...opts.defines } : {};
	// Inject __FILE__ early so conditional branches can test it (#if defined(__FILE__) or comparisons)
	if (opts.fromPath) {
		const base = path.basename(opts.fromPath);
		if (!Object.prototype.hasOwnProperty.call(initialDefines, '__FILE__')) initialDefines['__FILE__'] = JSON.stringify(base);
	}
	// Provide a stable content-based version to invalidate segmentation cache when text changes.
	let version = 0;
	{
		let h = 2166136261 >>> 0; // FNV-1a 32-bit
		for (let i = 0; i < text.length; i++) { h ^= text.charCodeAt(i); h = Math.imul(h, 16777619); }
		version = h >>> 0;
	}
	// Provide __FILE__ lazily: allow builtin expansion later; no need to predefine for branch forcing because new preprocessor already records undefined identifiers.
	const pre = preprocessAndExpandNew(opts.fromPath || '<memory>', version, rootTokens, initialDefines, resolver);
	// Build diagnostic suppression directives & disabled ranges by scanning comments.
	// Supported forms (see tests/diag_suppress.test.ts):
	//  // lsl-disable-line CODE1, CODE2
	//  // lsl-disable-next-line CODE1, CODE2
	//  // lsl-disable [CODE1, CODE2]
	//  // lsl-enable
	// If codes list omitted, treat as disable all.
	// We materialize disabledRanges as merged spans where ALL diagnostics are suppressed (only when codes list omitted),
	// preserving code-specific maps in diagDirectives for analyzer filtering.
	const disabledRanges: { start: number; end: number }[] = [];
	const disableLine = new Map<number, Set<string> | null>();
	const disableNextLine = new Map<number, Set<string> | null>();
	const blockStack: { startOffset: number; codes: Set<string> | null }[] = [];
	const blocks: { start: number; end: number; codes: Set<string> | null }[] = [];
	// Helper to parse codes list after directive keyword tokens inside a comment string.
	function parseCodes(seg: string): Set<string> | null {
		// seg like "LSL001, return-in-void" or "" => null (meaning all)
		if (!seg.trim()) return null;
		const codes = new Set<string>();
		for (const part of seg.split(/[\s,]+/)) {
			const normalized = normalizeDiagCode(part);
			if (!normalized) continue;
			codes.add(normalized);
		}
		return codes.size ? codes : null;
	}
	// Build line index mapping offset-> line number to store directives quickly.
	const lineOffsets: number[] = [0];
	for (let i = 0; i < text.length; i++) if (text[i] === '\n') lineOffsets.push(i + 1);
	function lineOf(offset: number): number {
		// binary search
		let lo = 0, hi = lineOffsets.length - 1;
		while (lo <= hi) { const mid = (lo + hi) >> 1; const v = lineOffsets[mid]; if (v <= offset) { lo = mid + 1; } else hi = mid - 1; }
		return lo - 1; // 0-based line
	}
	function offsetOfLine(line: number): number { return line < lineOffsets.length ? lineOffsets[line] : text.length; }
	// Scan root file tokens only (suppression currently only recognized in primary file; can extend to includes later if needed)
	for (const t of rootTokens) {
		if (t.kind !== 'comment-line') continue;
		const raw = t.value || '';
		const body = raw.replace(/^\/\//, '').trim();
		const m = body.match(/^lsl-(disable(?:-line|-next-line)?|enable)(.*)$/i);
		if (!m) continue;
		const kind = m[1].toLowerCase();
		const rest = m[2] ? m[2].trim() : '';
		const codes = kind === 'enable' ? null : parseCodes(rest.replace(/^\s+/, ''));
		const line = lineOf(t.span.start);
		if (kind === 'disable-line') {
			disableLine.set(line, codes);
			if (codes == null) disabledRanges.push({ start: offsetOfLine(line), end: offsetOfLine(line + 1) - 1 });
		} else if (kind === 'disable-next-line') {
			disableNextLine.set(line, codes);
			if (codes == null) disabledRanges.push({ start: offsetOfLine(line + 1), end: offsetOfLine(line + 2) - 1 });
		} else if (kind === 'disable') {
			blockStack.push({ startOffset: t.span.start, codes });
		} else if (kind === 'enable') {
			const last = blockStack.pop();
			if (last) {
				blocks.push({ start: last.startOffset, end: t.span.end, codes: last.codes });
				if (last.codes == null) disabledRanges.push({ start: last.startOffset, end: t.span.end });
			}
		}
	}
	// Any unterminated blocks extend to EOF.
	for (const b of blockStack) {
		blocks.push({ start: b.startOffset, end: text.length, codes: b.codes });
		if (b.codes == null) disabledRanges.push({ start: b.startOffset, end: text.length });
	}
	// Merge overlapping/adjacent all-code disabled ranges.
	disabledRanges.sort((a, b) => a.start - b.start);
	const merged: { start: number; end: number }[] = [];
	for (const r of disabledRanges) {
		if (!merged.length || r.start > merged[merged.length - 1].end + 1) merged.push({ ...r });
		else if (r.end > merged[merged.length - 1].end) merged[merged.length - 1].end = r.end;
	}
	// Replace with merged list
	disabledRanges.length = 0; for (const r of merged) disabledRanges.push(r);
	// Merge inactive conditional branch spans into disabledRanges (all-codes suppression)
	if (pre.inactiveSpans && pre.inactiveSpans.length) {
		for (const r of pre.inactiveSpans) disabledRanges.push({ start: r.start, end: r.end });
	}
	// Collect includeTargets & missingIncludes from preprocessor
	const includeTargets = pre.includeTargets ?? [];
	const missingIncludes = pre.missingIncludes ?? [];
	// Collect built-in preprocessor diagnostics and pass-through macro diagnostics
	const mcp = new MacroConditionalProcessor(rootTokens);
	const structuralDiags = mcp.collectDiagnostics(initialDefines);
	const preprocDiagnostics = (pre.diagnostics || []).concat(structuralDiags);
	const diagDirectives: import('./preproc').DiagDirectives = { disableLine, disableNextLine, blocks };
	// Build funcMacros map: function-like macro definitions body string as stored in macros table ("(params) body")
	const funcMacros: Record<string,string> = {};
	for (const [name, val] of Object.entries(pre.macros)) {
		if (typeof val === 'string' && /^\([^)]*\)\s+/.test(val)) funcMacros[name] = val;
	}
	// Build legacy-style macro delta info (for core_pipeline_cache tests)
	// Semantics required by tests:
	//  1. On first run we report only keys whose final value differs from the provided baseline defines (if any).
	//     If no baseline provided, we treat the previous snapshot (initially empty) as baseline but we DO NOT
	//     include keys that were defined and then undefined in the same pass (net effect is absence).
	//  2. Running the same source again while passing the resulting macro table as defines must yield macrosChanged=false.
	// Implementation: derive "effectivePrev" = opts.defines ?? previous snapshot. Compare final table to effectivePrev.
	const prevSnapshot = _prevMacroSnapshot.macros;
	const effectivePrev = opts.defines ? { ...opts.defines } : prevSnapshot;
	// Keys present in final but value changed vs baseline
	const changedKeysSet = new Set<string>();
	for (const k of Object.keys(pre.macros)) {
		if (effectivePrev[k] !== pre.macros[k]) changedKeysSet.add(k);
	}
	// Keys removed relative to baseline (only if they existed in baseline)
	for (const k of Object.keys(effectivePrev)) {
		if (!Object.prototype.hasOwnProperty.call(pre.macros, k)) changedKeysSet.add(k);
	}
	// Filter out keys that were both added and removed inside this single run with no net presence.
	// (Those won't appear in pre.macros but might be in effectivePrev? Actually we only want removals if baseline had them.)
	const changedKeys = Array.from(changedKeysSet).filter(k => {
		// If baseline lacked and final lacks -> skip
		if (!(k in effectivePrev) && !(k in pre.macros)) return false;
		return true;
	});
	const macrosChanged = changedKeys.length > 0;
	// Update snapshot to final table for subsequent call when no explicit defines provided
	_prevMacroSnapshot.macros = { ...pre.macros };
	// Build inactive span index for fast filtering
	const inactive: { start: number; end: number }[] = pre.inactiveSpans ? [...pre.inactiveSpans] : [];
	if (inactive.length) inactive.sort((a,b)=> a.start-b.start);
	function isInactive(t: Token): boolean {
		if (!inactive.length) return false;
		const pos = t.span.start;
		// binary search last span with start<=pos
		let lo=0, hi=inactive.length-1, cand=-1;
		while(lo<=hi){const mid=(lo+hi)>>1; const s=inactive[mid]!.start; if(s<=pos){cand=mid; lo=mid+1;} else hi=mid-1; }
		if (cand<0) return false; const span=inactive[cand]!; return pos>=span.start && pos<=span.end;
	}
	const allCodeTokens = pre.tokens.filter(t=> t.kind !== 'directive' && t.kind !== 'comment-line' && t.kind !== 'comment-block');
	const activeTokens = allCodeTokens.filter(t=> !isInactive(t));
	return {
		macros: pre.macros,
		funcMacros,
		includes: pre.includes,
		disabledRanges,
		includeTargets,
		missingIncludes,
		preprocDiagnostics,
		diagDirectives,
		conditionalGroups: undefined,
		expandedTokens: activeTokens,
		expandedAllTokens: allCodeTokens,
		macrosChanged,
		changedKeys
	};
}

// Legacy wrapper used by core_pipeline*.tests to get preprocessed tokens & macro tables without full AST.
export function preprocessTokens(text: string, opts: IncludeResolverOptions & { defines?: MacroDefines } = { includePaths: [] }) {
	const r = preprocessForAst(text, opts);
	return {
		macros: r.macros,
		includes: r.includes,
		tokens: r.expandedTokens,
		macrosChanged: r.macrosChanged,
		changedKeys: r.changedKeys,
	};
}
