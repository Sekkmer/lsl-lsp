import { type Token } from './tokens';
import { tokenize } from './tokenizer';
import type { DisabledRange, DynamicMacros, MissingInclude } from './preproc';

export type MacroDefines = Record<string, string | number | boolean>;

// Object replacements can themselves start with `(identifier) ...`; retain
// definition kind separately rather than guessing from that replacement text.
const functionMacroKinds = new WeakMap<MacroDefines, Set<string>>();

export function functionMacroNames(macros: MacroDefines): Set<string> {
	return new Set(functionMacroKinds.get(macros) ?? Object.entries(macros).filter(([, value]) =>
		typeof value === 'string' && /^\((?:\s*[A-Za-z_]\w*\s*,)*\s*(?:[A-Za-z_]\w*|\.\.\.)?\s*\)\s+/.test(value)).map(([name]) => name));
}

export function copyMacroDefines(macros: MacroDefines): MacroDefines {
	const copy = { ...macros };
	functionMacroKinds.set(copy, functionMacroNames(macros));
	return copy;
}

type DirKind =
	| { kind: 'if'; expr: string }
	| { kind: 'elif'; expr: string }
	| { kind: 'else' }
	| { kind: 'endif' }
	| { kind: 'ifdef'; name: string }
	| { kind: 'ifndef'; name: string }
	| { kind: 'define_obj'; name: string; body?: string }
	| { kind: 'define_fn'; name: string; params: string; body: string }
	| { kind: 'undef'; name: string }
	| { kind: 'include'; target: string; system?: boolean };

// --- New segmentation data structures (work-in-progress experimental API) ---
export interface DirectiveSeg {
	type: 'directive';
	dir: DirKindWithSpan;
}
export interface RawSeg {
	type: 'raw';
	// Tokens between two directives (exclusive) or file start/end. Never contains directive tokens.
	tokens: Token[];
	start: number; // span start of first token (or preceding directive end)
	end: number;   // span end of last token (or following directive start)
}
export type Seg = DirectiveSeg | RawSeg;

export type DirKindWithSpan = (DirKind & { span: { start: number; end: number } });

interface FileSegCacheEntry {
	segs: Seg[];
	version: number; // simple bump / mtime placeholder (caller supplies)
	tokenHash: number;
}

const NOISE_CHARS = new Set(['#', '$', '?', '\\', '"', '\'']);
const isNoiseChar = (ch: string | undefined) => !!ch && NOISE_CHARS.has(ch);
const lstripNoise = (text: string): string => {
	let idx = 0;
	while (idx < text.length && isNoiseChar(text[idx]!)) idx++;
	return text.slice(idx);
};
const stripNoise = (text: string): string => {
	let start = 0;
	let end = text.length;
	while (start < end && isNoiseChar(text[start]!)) start++;
	while (end > start && isNoiseChar(text[end - 1]!)) end--;
	return text.slice(start, end);
};

// Simple in-memory cache: fileId -> cache entry. The caller (pipeline) can clear or bump version.
const fileSegCache = new Map<string, FileSegCacheEntry>();

/**
 * Segment a token list produced directly from lexing (still containing directive tokens) into
 * alternating raw spans and directive nodes. Raw spans intentionally skip directive tokens so
 * later passes can decide whether to materialize them depending on conditional evaluation.
 * Results are cached per fileId+version.
 */
export function segmentFileDirectives(fileId: string, version: number, tokens: Token[]): Seg[] {
	let tokenHash = 2166136261 >>> 0;
	for (const t of tokens) {
		const text = `${t.kind}\0${t.value}\0${t.span.start}\0${t.span.end}`;
		for (let i = 0; i < text.length; i++) { tokenHash ^= text.charCodeAt(i); tokenHash = Math.imul(tokenHash, 16777619); }
	}
	tokenHash >>>= 0;
	const cached = fileSegCache.get(fileId);
	if (cached && cached.version === version && cached.tokenHash === tokenHash) return cached.segs;
	const segs: Seg[] = [];
	let buf: Token[] = [];
	const flushBuf = () => {
		if (!buf.length) return;
		const start = buf[0]!.span.start;
		const end = buf[buf.length - 1]!.span.end;
		segs.push({ type: 'raw', tokens: buf.slice(), start, end });
		buf = [];
	};
	for (const t of tokens) {
		if (t.kind === 'directive') {
			// finalize pending raw span
			flushBuf();
			const dk = parseDirectiveKind(t.value);
			if (dk) {
				segs.push({ type: 'directive', dir: { ...dk, span: { ...t.span } } });
			} else {
				// Treat as inert raw token if parse failed (should be rare)
				buf.push(t);
			}
		} else {
			buf.push(t);
		}
	}
	flushBuf();
	fileSegCache.set(fileId, { segs, version, tokenHash });
	return segs;
}

// Helper to invalidate a file's segmentation (e.g., on edit). Not yet wired.
export function invalidateFileSegmentation(fileId: string) {
	fileSegCache.delete(fileId);
}

// --- Experimental unified preprocessing (conditionals + includes, pre macro-expansion) ---
export interface PreprocessResultNew {
	tokens: Token[];            // concatenated active tokens from this file (includes eagerly inlined)
	macros: MacroDefines;       // resulting macro table after processing this file & its includes
	diagnostics: { message: string; code?: string; start: number; end: number; file?: string }[]; // preprocessor diagnostics
	includes: string[];         // file ids included (unique order of first encounter)
	macroDefs?: Record<string, { start: number; end: number; file: string }>; // definition span for each macro
	includeTargets?: { start: number; end: number; file: string; resolved: string | null }[]; // each include directive
	missingIncludes?: MissingInclude[]; // unresolved include directives
	inactiveSpans?: DisabledRange[]; // spans of inactive conditional branches (for disabledRanges)
}

interface ProcessCtx {
	includeResolver?: IncludeResolver;
	dynamicMacros?: DynamicMacros;
	seen: Set<string>; // unique include ids encountered for reporting
	collecting: string[]; // active include stack for cycle detection
	includeOrder: string[];
	diagnostics: { message: string; code?: string; start: number; end: number; file?: string }[];
}

function hasMacro(macros: MacroDefines, dynamicMacros: DynamicMacros | undefined, name: string): boolean {
	return Object.prototype.hasOwnProperty.call(macros, name) || Object.prototype.hasOwnProperty.call(dynamicMacros ?? {}, name);
}

export function preprocessFileNew(fileId: string, version: number, tokens: Token[], macrosIn: MacroDefines, ctx: ProcessCtx): PreprocessResultNew {
	const segs = segmentFileDirectives(fileId, version, tokens);
	const macros: MacroDefines = copyMacroDefines(macrosIn);
	const functionNames = functionMacroNames(macrosIn);
	functionMacroKinds.set(macros, functionNames);
	const out: Token[] = [];
	const includesLocal: string[] = [];
	const macroDefs: Record<string,{start:number; end:number; file:string}> = {};
	const includeTargets: { start: number; end: number; file: string; resolved: string | null }[] = [];
	const missingIncludes: MissingInclude[] = [];
	const inactiveSpans: DisabledRange[] = [];
	const pushInclude = (id: string) => { if (!includesLocal.includes(id)) includesLocal.push(id); if (!ctx.includeOrder.includes(id)) ctx.includeOrder.push(id); };
	const noteDup = (name: string, span: {start:number; end:number}, previous: unknown, next: unknown) => {
		if (JSON.stringify(previous) !== JSON.stringify(next)) ctx.diagnostics.push({ message: `Duplicate macro ${name}`, code: 'LSL-macro-dup', start: span.start, end: span.end, file: fileId });
	};
	const collectIfUndef = (expr: string, span: {start:number; end:number}) => {
		const ids = tokenize(expr).filter(t => t.kind === 'id').map(t => t.value);
		for (let i=0;i<ids.length;i++) {
			const id = ids[i]!;
			if (id === 'defined') { i++; continue; }
			if (!hasMacro(macros, ctx.dynamicMacros, id)) {
				ctx.diagnostics.push({ message: `Identifier '${id}' not defined in preprocessor expression`, code: 'LSL-preproc-undef', start: span.start, end: span.end, file: fileId });
			}
		}
	};
	const stack: Array<{ parentActive: boolean; active: boolean; taken: boolean; sawElse: boolean; branchStart: number }> = [];
	const isActive = () => stack.length === 0 || stack[stack.length - 1]!.active;
	const finishBranch = (end: number) => {
		const frame = stack[stack.length - 1];
		if (frame && !frame.active) inactiveSpans.push({ start: frame.branchStart, end, file: fileId });
	};
	for (let i=0;i<segs.length;i++) {
		const s = segs[i]!;
		if (s.type === 'raw') {
			if (isActive()) out.push(...expandActiveTokens(s.tokens, macros, ctx.dynamicMacros));
			continue;
		}
		const d = s.dir;
		if (d.kind === 'if' || d.kind === 'ifdef' || d.kind === 'ifndef') {
			const parentActive = isActive();
			if (parentActive && d.kind === 'if') collectIfUndef(d.expr, d.span);
			const enabled = parentActive && (d.kind === 'if' ? evalExprQuick(d.expr, macros, ctx.dynamicMacros) :
				d.kind === 'ifdef' ? hasMacro(macros, ctx.dynamicMacros, d.name) : !hasMacro(macros, ctx.dynamicMacros, d.name));
			stack.push({ parentActive, active: enabled, taken: enabled, sawElse: false, branchStart: d.span.end });
			continue;
		}
		if (d.kind === 'elif' || d.kind === 'else') {
			const frame = stack[stack.length - 1];
			if (!frame) continue;
			finishBranch(d.span.start);
			if (d.kind === 'elif' && frame.parentActive && !frame.taken && !frame.sawElse) collectIfUndef(d.expr, d.span);
			frame.active = frame.parentActive && !frame.taken && !frame.sawElse && (d.kind === 'else' || evalExprQuick(d.expr, macros, ctx.dynamicMacros));
			frame.taken ||= frame.active;
			frame.sawElse ||= d.kind === 'else';
			frame.branchStart = d.span.end;
			continue;
		}
		if (d.kind === 'endif') { finishBranch(d.span.start); stack.pop(); continue; }
		if (!isActive()) {
			if (d.kind === 'include') includeTargets.push({ start: d.span.start, end: d.span.end, file: d.target, resolved: null });
			continue;
		}
		if (d.kind === 'define_obj') { const prev = macros[d.name]; const next = d.body !== undefined ? parseMacroValue(d.body) : 1; if (prev !== undefined) noteDup(d.name, d.span, prev, next); macros[d.name] = next; functionNames.delete(d.name); macroDefs[d.name] = { start: d.span.start, end: d.span.end, file: fileId }; continue; }
		if (d.kind === 'define_fn') { const prev = macros[d.name]; const next = `(${d.params}) ${d.body}`; if (prev !== undefined) noteDup(d.name, d.span, prev, next); macros[d.name] = next; functionNames.add(d.name); macroDefs[d.name] = { start: d.span.start, end: d.span.end, file: fileId }; continue; }
		if (d.kind === 'undef') { delete macros[d.name]; functionNames.delete(d.name); delete macroDefs[d.name]; continue; }
		if (d.kind === 'include') {
			if (!ctx.includeResolver) { includeTargets.push({ start: d.span.start, end: d.span.end, file: d.target, resolved: null }); continue; }
			const inc = ctx.includeResolver(d.target, fileId, { system: d.system });
			if (!inc) { includeTargets.push({ start: d.span.start, end: d.span.end, file: d.target, resolved: null }); missingIncludes.push({ start: d.span.start, end: d.span.end, file: d.target, originFile: fileId }); continue; }
			includeTargets.push({ start: d.span.start, end: d.span.end, file: d.target, resolved: inc.id });
			if (ctx.collecting.includes(inc.id)) continue;
			ctx.seen.add(inc.id); ctx.collecting.push(inc.id); pushInclude(inc.id);
			const nested = preprocessFileNew(inc.id, version, inc.tokens, macros, ctx);
			for (const name of Object.keys(macros)) if (!Object.prototype.hasOwnProperty.call(nested.macros, name)) { delete macros[name]; delete macroDefs[name]; }
			Object.assign(macros, nested.macros);
			functionNames.clear();
			for (const name of functionMacroNames(nested.macros)) functionNames.add(name);
			Object.assign(macroDefs, nested.macroDefs);
			includeTargets.push(...nested.includeTargets ?? []);
			missingIncludes.push(...nested.missingIncludes ?? []);
			inactiveSpans.push(...nested.inactiveSpans ?? []);
			for (const tk of nested.tokens) out.push(tk);
			ctx.collecting.pop();
			continue;
		}
	}
	for (const frame of stack) if (!frame.active) inactiveSpans.push({ start: frame.branchStart, end: tokens[tokens.length - 1]?.span.end ?? frame.branchStart, file: fileId });
	return { tokens: out, macros, diagnostics: ctx.diagnostics, includes: includesLocal, macroDefs, includeTargets, missingIncludes, inactiveSpans };
}

export function preprocessAndExpandNew(fileId: string, version: number, tokens: Token[], initialMacros: MacroDefines, includeResolver?: IncludeResolver, dynamicMacros?: DynamicMacros): { tokens: Token[]; macros: MacroDefines; diagnostics: { message: string; code?: string; start: number; end: number; file?: string }[]; includes: string[]; macroDefs?: Record<string,{start:number; end:number; file:string}>; includeTargets?: { start: number; end: number; file: string; resolved: string | null }[]; missingIncludes?: MissingInclude[]; inactiveSpans?: DisabledRange[] } {
	const ctx: ProcessCtx = { includeResolver, dynamicMacros, seen: new Set<string>([fileId]), collecting: [fileId], includeOrder: [], diagnostics: [] };
	const pre = preprocessFileNew(fileId, version, tokens, initialMacros, ctx);
	return { tokens: pre.tokens, macros: pre.macros, diagnostics: pre.diagnostics, includes: ctx.includeOrder, macroDefs: pre.macroDefs, includeTargets: pre.includeTargets, missingIncludes: pre.missingIncludes, inactiveSpans: pre.inactiveSpans };
}

function parseDirectiveKind(raw: string): DirKind | null {
	const m = /^#\s*(\w+)([\s\S]*)$/.exec(raw);
	if (!m) return null;
	const head = m[1]!.toLowerCase();
	// Tokenizer already inserted literal newlines where a backslash-newline splice occurred.
	// Keep those newlines in the body for multi-line macros; only strip trailing line comments.
	const rest = stripDirectiveLineComments(m[2] || '').trim();
	if (head === 'if') return { kind: 'if', expr: rest };
	if (head === 'elif') return { kind: 'elif', expr: rest };
	if (head === 'else') return { kind: 'else' };
	if (head === 'endif') return { kind: 'endif' };
	if (head === 'ifdef') { const raw = rest.split(/\s+/)[0] || ''; const name = stripNoise(raw); return { kind: 'ifdef', name }; }
	if (head === 'ifndef') { const raw = rest.split(/\s+/)[0] || ''; const name = stripNoise(raw); return { kind: 'ifndef', name }; }
	if (head === 'undef') { const raw = rest.split(/\s+/)[0] || ''; const name = stripNoise(raw); return { kind: 'undef', name }; }
	if (head === 'include') {
		const include = parseIncludeTarget(rest);
		return { kind: 'include', target: include?.target || '', system: include?.system };
	}
	if (head === 'define') {
		const leadingStripped = lstripNoise(rest);
		if (!leadingStripped) return null;
		const mm = /^([A-Za-z_]\w*)(\(([^)]*)\))?(?:\s+([\s\S]*))?$/.exec(leadingStripped);
		if (mm) {
			const name = stripNoise(mm[1]!);
			if (!name) return null;
			if (mm[2]) {
				const params = (mm[3] || '').trim();
				// Preserve embedded newlines across continuations; trim right only
				const body = (mm[4] ? String(mm[4]).replace(/[ \t]+$/gm, '') : '').trim();
				return { kind: 'define_fn', name, params, body };
			} else {
				const body = (mm[4] ? String(mm[4]).replace(/[ \t]+$/gm, '') : '').trim();
				return { kind: 'define_obj', name, body: body.length ? body : undefined };
			}
		}
	}
	return null;
}

function parseIncludeTarget(rest: string): { target: string; system: boolean } | null {
	const s = stripDirectiveLineComments(rest).trim();
	const q1 = s.indexOf('"');
	if (q1 >= 0) { const q2 = s.indexOf('"', q1 + 1); if (q2 > q1 + 1) return { target: s.slice(q1 + 1, q2), system: false }; }
	const a1 = s.indexOf('<');
	if (a1 >= 0) { const a2 = s.indexOf('>', a1 + 1); if (a2 > a1 + 1) return { target: s.slice(a1 + 1, a2), system: true }; }
	return null;
}

function stripDirectiveLineComments(text: string): string {
	let out = '';
	let quote: '"' | '\'' | null = null;
	let escaped = false;
	for (let i = 0; i < text.length; i++) {
		const ch = text[i]!;
		const next = text[i + 1];
		if (quote) {
			out += ch;
			if (escaped) escaped = false;
			else if (ch === '\\') escaped = true;
			else if (ch === quote) quote = null;
			continue;
		}
		if (ch === '"' || ch === '\'') {
			quote = ch;
			out += ch;
			continue;
		}
		if (ch === '/' && next === '/') {
			while (i < text.length && text[i] !== '\n' && text[i] !== '\r') i++;
			i--;
			continue;
		}
		out += ch;
	}
	return out;
}

function parseMacroValue(v: string): string | number | boolean {
	const num = Number(v);
	if (!Number.isNaN(num)) return num;
	if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith('\'') && v.endsWith('\''))) return v;
	return v;
}

type Frame = { enabled: boolean; sawElse: boolean; taken: boolean };

export type IncludeResolver = (target: string, fromId?: string, opts?: { system?: boolean }) => { tokens: Token[]; id: string } | null;

export class MacroConditionalProcessor {
	private readonly tokens: Token[];
	private readonly resolveInclude?: IncludeResolver;
	private readonly includeIds: string[] = [];
	private readonly fromId?: string;
	// Track include stack to detect cycles and prevent infinite recursion
	private readonly includeStack: string[];
	private readonly emitIncludeTokens: boolean;

	constructor(tokens: Token[], opts?: { resolveInclude?: IncludeResolver; fromId?: string; includeStack?: string[]; emitIncludeTokens?: boolean }) {
		this.tokens = tokens;
		this.resolveInclude = opts?.resolveInclude;
		this.fromId = opts?.fromId;
		// Initialize include stack with provided stack or fromId
		const initial: string[] = [];
		if (opts?.includeStack && opts.includeStack.length > 0) initial.push(...opts.includeStack);
		else if (this.fromId) initial.push(this.fromId);
		this.includeStack = initial;
		this.emitIncludeTokens = opts?.emitIncludeTokens !== false; // default true
	}

	// Process and return active tokens; also return the final macro table and includes encountered
	processToTokens(defines: MacroDefines): { tokens: Token[]; macros: MacroDefines; includes: string[]; macrosChanged: boolean; changedKeys: string[] } {
		const macros: MacroDefines = { ...defines };
		const out: Token[] = [];
		this.walk(macros, (t, active) => {
			if (active && t.kind !== 'directive') out.push(t);
		}, /*macrosOnly*/ false);
		const delta = computeMacrosDelta(defines, macros);
		return { tokens: out, macros, includes: [...this.includeIds], macrosChanged: delta.changed, changedKeys: delta.changedKeys };
	}

	// Process only macro table changes (defines/undefs) including inside included files when active
	processToMacros(defines: MacroDefines): { macros: MacroDefines; includes: string[]; macrosChanged: boolean; changedKeys: string[] } {
		const macros: MacroDefines = { ...defines };
		this.walk(macros, () => { /* ignore non-directive tokens */ }, /*macrosOnly*/ true);
		const delta = computeMacrosDelta(defines, macros);
		return { macros, includes: [...this.includeIds], macrosChanged: delta.changed, changedKeys: delta.changedKeys };
	}

	private walk(macros: MacroDefines, sink: (t: Token, active: boolean) => void, macrosOnly: boolean) {
		const stack: Frame[] = [];
		const isActive = () => stack.every(f => f.enabled);
		for (let i = 0; i < this.tokens.length; i++) {
			const t = this.tokens[i]!;
			if (t.kind !== 'directive') { sink(t, isActive()); continue; }
			const d = parseDirectiveKind(t.value);
			if (!d) { sink(t, isActive()); continue; }
			// conditionals
			if (d.kind === 'if') {
				const enabled = isActive() && evalExprQuick(d.expr, macros);
				stack.push({ enabled, sawElse: false, taken: enabled });
				continue;
			}
			if (d.kind === 'ifdef') { const enabled = isActive() && Object.prototype.hasOwnProperty.call(macros, d.name); stack.push({ enabled, sawElse: false, taken: enabled }); continue; }
			if (d.kind === 'ifndef') { const enabled = isActive() && !Object.prototype.hasOwnProperty.call(macros, d.name); stack.push({ enabled, sawElse: false, taken: enabled }); continue; }
			if (d.kind === 'elif') {
				const top = stack[stack.length - 1]; if (!top) continue;
				if (top.sawElse) { top.enabled = false; continue; }
				const ancestors = stack.slice(0, -1).every(f => f.enabled);
				let newEnabled = false;
				if (!top.taken && ancestors) { newEnabled = evalExprQuick(d.expr, macros); if (newEnabled) top.taken = true; }
				top.enabled = newEnabled; continue;
			}
			if (d.kind === 'else') {
				const top = stack[stack.length - 1]; if (!top) continue; top.sawElse = true; const ancestors = stack.slice(0, -1).every(f => f.enabled); top.enabled = ancestors && !top.taken; continue;
			}
			if (d.kind === 'endif') { stack.pop(); continue; }
			// non-conditional directives: only act when active
			if (!isActive()) continue;
			if (d.kind === 'define_obj') { macros[d.name] = d.body !== undefined ? parseMacroValue(d.body) : 1; continue; }
			if (d.kind === 'define_fn') { // store body text for caching presence; value equality will reflect changes
				macros[d.name] = `(${d.params}) ${d.body}`.trim(); continue;
			}
			if (d.kind === 'undef') { delete macros[d.name]; continue; }
			if (d.kind === 'include') {
				if (!this.resolveInclude) continue;
				const inc = this.resolveInclude(d.target, this.fromId, { system: d.system });
				if (!inc) continue;
				this.includeIds.push(inc.id);
				// Detect include cycles: if the target is already on the include stack, skip recursion to avoid infinite loop
				if (this.includeStack.includes(inc.id)) {
					// Cycle detected (e.g., self-include). Do not recurse further.
					continue;
				}
				// Recurse into included tokens with the same processing mode; propagate include stack
				const nestedStack = [...this.includeStack, inc.id];
				const nested = new MacroConditionalProcessor(inc.tokens, { resolveInclude: this.resolveInclude, fromId: inc.id, includeStack: nestedStack, emitIncludeTokens: this.emitIncludeTokens });
				if (macrosOnly) {
					const r = nested.processToMacros(macros);
					// use returned macros as updated reference (object already mutated via copy)
					Object.assign(macros, r.macros);
				} else {
					const r = nested.processToTokens(macros);
					// Update macros table and optionally emit included tokens
					if (this.emitIncludeTokens) {
						for (const it of r.tokens) sink(it, true);
					}
					Object.assign(macros, r.macros);
				}
				continue;
			}
			// Unknown directive when active: ignore for now
		}
	}

	// New: collect conditional groups with spans and which branch was active under given defines
	collectConditionalGroups(defines: MacroDefines): { groups: { head: { start: number; end: number }; branches: { span: { start: number; end: number }; active: boolean }[]; end: number }[] } {
		const macros: MacroDefines = { ...defines };
		type Frame = { head: { start: number; end: number }; branches: { span: { start: number; end: number }; active: boolean }[]; current: { start: number; end: number } | null; enabled: boolean; sawElse: boolean; taken: boolean };
		const groups: Frame[] = [];
		const out: { head: { start: number; end: number }; branches: { span: { start: number; end: number }; active: boolean }[]; end: number }[] = [];
		const stack: Array<{ enabled: boolean; sawElse: boolean; taken: boolean; idx: number | null }> = [];
		const isActive = () => stack.every(f => f.enabled);
		for (let i = 0; i < this.tokens.length; i++) {
			const t = this.tokens[i]!;
			if (t.kind !== 'directive') continue;
			const d = parseDirectiveKind(t.value);
			if (!d) continue;
			if (d.kind === 'if') {
				const enabled = isActive() && evalExprQuick(d.expr, macros);
				const f: Frame = { head: { start: t.span.start, end: t.span.end }, branches: [], current: null, enabled, sawElse: false, taken: enabled };
				groups.push(f); stack.push({ enabled, sawElse: false, taken: enabled, idx: groups.length - 1 });
				// Start first branch immediately after directive
				f.current = { start: t.span.end, end: t.span.end };
				continue;
			}
			if (d.kind === 'ifdef' || d.kind === 'ifndef') {
				const present = Object.prototype.hasOwnProperty.call(macros, d.name);
				const enabled = isActive() && (d.kind === 'ifdef' ? present : !present);
				const f: Frame = { head: { start: t.span.start, end: t.span.end }, branches: [], current: null, enabled, sawElse: false, taken: enabled };
				groups.push(f); stack.push({ enabled, sawElse: false, taken: enabled, idx: groups.length - 1 });
				f.current = { start: t.span.end, end: t.span.end };
				continue;
			}
			if (d.kind === 'elif') {
				const top = stack[stack.length - 1]; if (!top || top.idx == null) continue;
				const f = groups[top.idx]!;
				// close previous branch at start of this directive
				if (f.current) { f.current.end = t.span.start; f.branches.push({ span: { ...f.current }, active: f.enabled && f.taken }); f.current = null; }
				if (!top.sawElse) {
					const ancestors = stack.slice(0, -1).every(ff => ff.enabled);
					let newEnabled = false;
					if (!top.taken && ancestors) { newEnabled = evalExprQuick(d.expr, macros); if (newEnabled) top.taken = true; }
					top.enabled = newEnabled;
					f.enabled = newEnabled;
				}
				f.current = { start: t.span.end, end: t.span.end };
				continue;
			}
			if (d.kind === 'else') {
				const top = stack[stack.length - 1]; if (!top || top.idx == null) continue;
				const f = groups[top.idx]!;
				if (f.current) { f.current.end = t.span.start; f.branches.push({ span: { ...f.current }, active: f.enabled && f.taken }); f.current = null; }
				top.sawElse = true;
				const ancestors = stack.slice(0, -1).every(ff => ff.enabled);
				const shouldEnable = ancestors && !top.taken;
				top.enabled = shouldEnable; f.enabled = shouldEnable;
				f.current = { start: t.span.end, end: t.span.end };
				continue;
			}
			if (d.kind === 'endif') {
				const top = stack.pop();
				const idx = top ? top.idx : null;
				if (idx != null) {
					const f = groups[idx]!;
					if (f.current) { f.current.end = t.span.start; f.branches.push({ span: { ...f.current }, active: f.enabled && f.taken }); f.current = null; }
					// finalize group end after directive
					out.push({ head: f.head, branches: f.branches, end: t.span.end });
				}
				continue;
			}
		}
		return { groups: out };
	}

	// Collect preprocessor diagnostics: malformed #if/#elif, stray #elif/#else/#endif, unmatched #if at EOF
	collectDiagnostics(_defines: MacroDefines): { start: number; end: number; message: string; code?: string }[] {
		const diagnostics: { start: number; end: number; message: string; code?: string }[] = [];
		const stack: Array<{ kind: 'if' | 'ifdef' | 'ifndef'; sawElse: boolean }> = [];
		for (let i = 0; i < this.tokens.length; i++) {
			const t = this.tokens[i]!;
			if (t.kind !== 'directive') continue;
			const d = parseDirectiveKind(t.value);
			if (!d) continue;
			const add = (msg: string) => diagnostics.push({ start: t.span.start, end: t.span.end, message: msg, code: 'LSL-preproc' });
			if (d.kind === 'if') {
				if (!validateIfExpr(d.expr)) add('Malformed #if expression');
				stack.push({ kind: 'if', sawElse: false });
				continue;
			}
			if (d.kind === 'ifdef') { stack.push({ kind: 'ifdef', sawElse: false }); continue; }
			if (d.kind === 'ifndef') { stack.push({ kind: 'ifndef', sawElse: false }); continue; }
			if (d.kind === 'elif') {
				if (stack.length === 0) add('Stray #elif');
				else if (stack[stack.length - 1]!.sawElse) add('#elif after #else');
				if (!validateIfExpr(d.expr)) add('Malformed #elif expression');
				continue;
			}
			if (d.kind === 'else') {
				if (stack.length === 0) add('Stray #else');
				else {
					const top = stack[stack.length - 1]!;
					if (top.sawElse) add('Duplicate #else');
					top.sawElse = true;
				}
				continue;
			}
			if (d.kind === 'endif') { if (stack.length === 0) add('Stray #endif'); else stack.pop(); continue; }
		}
		if (stack.length > 0) diagnostics.push({ start: this.tokens.length ? this.tokens[this.tokens.length - 1]!.span.end : 0, end: this.tokens.length ? this.tokens[this.tokens.length - 1]!.span.end : 0, message: 'Unmatched conditional block', code: 'LSL-preproc' });
		return diagnostics;
	}
}

// Evaluate #if expressions with simple arithmetic and logical operators.
// Supported: defined(NAME), identifiers, integer literals, unary ! + -,
// binary * / %, + -, < <= > >=, == !=, && ||, and parentheses.
function evalExprQuick(expr: string, defs: MacroDefines, dynamicMacros?: DynamicMacros): boolean {
	type Tok = { kind: 'num'; value: number } | { kind: 'ident'; value: string } | { kind: 'op'; value: string } | { kind: 'lparen' } | { kind: 'rparen' };
	// Resolve defined before ordinary expansion: its operand names a macro,
	// rather than referring to the macro's replacement tokens.
	const expressionTokens = tokenize(expr).filter(t => t.kind !== 'eof');
	const definedTokens: Token[] = [];
	for (let j = 0; j < expressionTokens.length; j++) {
		const token = expressionTokens[j]!;
		if (token.kind === 'id' && token.value === 'defined') {
			const paren = expressionTokens[j + 1]?.value === '(';
			const operand = expressionTokens[j + (paren ? 2 : 1)];
			if (operand?.kind === 'id') {
				definedTokens.push({ ...token, kind: 'number', value: hasMacro(defs, dynamicMacros, operand.value) ? '1' : '0' });
				j += paren && expressionTokens[j + 3]?.value === ')' ? 3 : 1;
				continue;
			}
		}
		definedTokens.push(token);
	}
	const conditionDefines = copyMacroDefines(defs);
	for (const [name, value] of Object.entries(conditionDefines)) if (typeof value === 'boolean') conditionDefines[name] = value ? 1 : 0;
	const s = expandActiveTokens(definedTokens, conditionDefines, dynamicMacros).map(t => t.value).join(' ').trim();
	if (!s) return false;

	// Tokenizer
	const toks: Tok[] = [];
	let i = 0;
	const twoOps = new Set(['&&', '||', '==', '!=', '<=', '>=', '<<', '>>']);
	while (i < s.length) {
		const ch = s[i]!;
		if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r') { i++; continue; }
		const two = s.slice(i, i + 2);
		if (twoOps.has(two)) { toks.push({ kind: 'op', value: two }); i += 2; continue; }
		if ('+-*/%<>!&|^~'.includes(ch)) { toks.push({ kind: 'op', value: ch }); i++; continue; }
		if (ch === '(') { toks.push({ kind: 'lparen' }); i++; continue; }
		if (ch === ')') { toks.push({ kind: 'rparen' }); i++; continue; }
		if (/[0-9]/.test(ch)) {
			let j = i + 1;
			if (ch === '0' && /[xX]/.test(s[j] ?? '')) { j++; while (j < s.length && /[0-9a-fA-F]/.test(s[j]!)) j++; }
			else while (j < s.length && /[0-9]/.test(s[j]!)) j++;
			const num = Number(s.slice(i, j));
			toks.push({ kind: 'num', value: num });
			i = j; continue;
		}
		if (/[A-Za-z_]/.test(ch)) {
			let j = i + 1;
			while (j < s.length && /[A-Za-z0-9_]/.test(s[j]!)) j++;
			const ident = s.slice(i, j);
			toks.push({ kind: 'ident', value: ident });
			i = j; continue;
		}
		// Unknown char: skip to avoid infinite loop
		i++;
	}

	// Parser (recursive descent)
	let p = 0;
	const peek = () => toks[p];
	const take = () => toks[p++];
	const peekOp = () => (peek() && peek()!.kind === 'op') ? (peek() as Extract<Tok, { kind: 'op' }>).value : undefined;
	const takeOp = () => { const t = take(); return t && t.kind === 'op' ? t.value : undefined; };

	const truthy = (v: number) => v !== 0;
	const valOfIdent = (name: string): number => {
		// defined(NAME) handled in parsePrimary/parseUnary
		const v = defs[name];
		if (v === undefined) return Object.prototype.hasOwnProperty.call(dynamicMacros ?? {}, name) ? 1 : 0;
		if (typeof v === 'number') return v;
		if (typeof v === 'boolean') return v ? 1 : 0;
		if (typeof v === 'string') {
			const vs = v.trim();
			if (/^[-+]?\d+$/.test(vs)) return Number(vs);
			const low = vs.toLowerCase();
			if (low === 'true') return 1;
			if (low === 'false') return 0;
			return vs.length > 0 ? 1 : 0;
		}
		return 1;
	};

	function parsePrimary(): number {
		const t = peek();
		if (!t) return 0;
		if (t.kind === 'num') { take(); return t.value; }
		if (t.kind === 'ident') {
			if (t.value === 'defined') {
				take();
				// defined NAME | defined(NAME)
				let name = '';
				if (peek() && peek()!.kind === 'lparen') {
					take(); // (
					const id = take();
					if (id && id.kind === 'ident') name = id.value;
					if (peek() && peek()!.kind === 'rparen') take();
				} else {
					const id = take();
					if (id && id.kind === 'ident') name = id.value; else name = '';
				}
				return hasMacro(defs, dynamicMacros, name) ? 1 : 0;
			}
			take();
			return valOfIdent(t.value);
		}
		if (t.kind === 'lparen') {
			take();
			const v = parseLogOr();
			if (peek() && peek()!.kind === 'rparen') take();
			return v;
		}
		return 0;
	}

	function parseUnary(): number {
		const t = peek();
		if (t && t.kind === 'op' && (t.value === '!' || t.value === '+' || t.value === '-' || t.value === '~')) {
			take();
			const v = parseUnary();
			if (t.value === '!') return truthy(v) ? 0 : 1;
			if (t.value === '+') return +v;
			if (t.value === '-') return -v;
			return ~v;
		}
		return parsePrimary();
	}

	function parseMul(): number {
		let v = parseUnary();
		while (peekOp() && ['*', '/', '%'].includes(peekOp()!)) {
			const op = takeOp()!;
			const r = parseUnary();
			if (op === '*') v = v * r;
			else if (op === '/') v = Math.trunc(v / r);
			else v = v % r;
		}
		return v;
	}

	function parseAdd(): number {
		let v = parseMul();
		while (peekOp() && ['+', '-'].includes(peekOp()!)) {
			const op = takeOp()!;
			const r = parseMul();
			if (op === '+') v = v + r; else v = v - r;
		}
		return v;
	}

	function parseShift(): number {
		let v = parseAdd();
		while (peekOp() && (peekOp() === '<<' || peekOp() === '>>')) {
			const op = takeOp()!;
			const r = parseAdd();
			if (op === '<<') v = v << r;
			else v = v >> r;
		}
		return v;
	}

	function parseRel(): number {
		let v = parseShift();
		while (peekOp() && ['<', '>', '<=', '>='].includes(peekOp()!)) {
			const op = takeOp()!;
			const r = parseShift();
			if (op === '<') v = v < r ? 1 : 0;
			else if (op === '>') v = v > r ? 1 : 0;
			else if (op === '<=') v = v <= r ? 1 : 0;
			else v = v >= r ? 1 : 0;
		}
		return v;
	}

	function parseEq(): number {
		let v = parseRel();
		while (peekOp() && ['==', '!='].includes(peekOp()!)) {
			const op = takeOp()!;
			const r = parseRel();
			if (op === '==') v = v === r ? 1 : 0; else v = v !== r ? 1 : 0;
		}
		return v;
	}

	function parseBitAnd(): number {
		let v = parseEq();
		while (peekOp() === '&') {
			takeOp();
			const r = parseEq();
			v = (v & r);
		}
		return v;
	}

	function parseBitXor(): number {
		let v = parseBitAnd();
		while (peekOp() === '^') {
			takeOp();
			const r = parseBitAnd();
			v = v ^ r;
		}
		return v;
	}

	function parseBitOr(): number {
		let v = parseBitXor();
		while (peekOp() === '|') {
			takeOp();
			const r = parseBitXor();
			v = v | r;
		}
		return v;
	}

	function parseLogAnd(): number {
		let v = parseBitOr();
		while (peekOp() === '&&') {
			takeOp();
			const r = parseBitOr();
			v = truthy(v) && truthy(r) ? 1 : 0;
		}
		return v;
	}

	function parseLogOr(): number {
		let v = parseLogAnd();
		while (peekOp() === '||') {
			takeOp();
			const r = parseLogAnd();
			v = truthy(v) || truthy(r) ? 1 : 0;
		}
		return v;
	}

	const result = parseLogOr();
	if (p < toks.length) return false;
	return truthy(result);
}

function computeMacrosDelta(prev: MacroDefines, next: MacroDefines): { changed: boolean; changedKeys: string[] } {
	const keys = new Set<string>([...Object.keys(prev), ...Object.keys(next)]);
	const changedKeys: string[] = [];
	for (const k of keys) {
		const a = prev[k];
		const b = next[k];
		if (a === b) continue;
		// Compare by stringified value to normalize numeric vs string representations
		if (JSON.stringify(a) !== JSON.stringify(b)) changedKeys.push(k);
	}
	return { changed: changedKeys.length > 0, changedKeys };
}

// Minimal validator for #if/#elif expressions used only for diagnostics; shares the same operator set as evalExprQuick
function validateIfExpr(expr: string): boolean {
	type Tok = { kind: 'num'; value: number } | { kind: 'ident'; value: string } | { kind: 'op'; value: string } | { kind: 'lparen' } | { kind: 'rparen' };
	const s = expr.trim();
	if (!s) return false;
	const toks: Tok[] = [];
	let i = 0;
	const twoOps = new Set(['&&', '||', '==', '!=', '<=', '>=', '<<', '>>']);
	while (i < s.length) {
		const ch = s[i]!;
		if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r') { i++; continue; }
		const two = s.slice(i, i + 2);
		if (twoOps.has(two)) { toks.push({ kind: 'op', value: two }); i += 2; continue; }
		if ('+-*/%<>!&|^~'.includes(ch)) { toks.push({ kind: 'op', value: ch }); i++; continue; }
		if (ch === '(') { toks.push({ kind: 'lparen' }); i++; continue; }
		if (ch === ')') { toks.push({ kind: 'rparen' }); i++; continue; }
		if (/[0-9]/.test(ch)) {
			let j = i + 1;
			if (ch === '0' && /[xX]/.test(s[j] ?? '')) { j++; const digitsStart = j; while (j < s.length && /[0-9a-fA-F]/.test(s[j]!)) j++; if (j === digitsStart) return false; }
			else while (j < s.length && /[0-9]/.test(s[j]!)) j++;
			toks.push({ kind: 'num', value: 0 }); i = j; continue;
		}
		if (/[A-Za-z_]/.test(ch)) { let j = i + 1; while (j < s.length && /[A-Za-z0-9_]/.test(s[j]!)) j++; toks.push({ kind: 'ident', value: s.slice(i, j) }); i = j; continue; }
		return false;
	}
	let p = 0; let ok = true;
	const peek = () => toks[p];
	const take = () => toks[p++];
	function parsePrimary(): number {
		const t = peek(); if (!t) { ok = false; return 0; }
		if (t.kind === 'num') { take(); return 0; }
		if (t.kind === 'ident') {
			if (t.value === 'defined') {
				take();
				if (peek() && peek()!.kind === 'lparen') { take(); const id = take(); if (!id || id.kind !== 'ident') { ok = false; return 0; } if (!peek() || peek()!.kind !== 'rparen') { ok = false; return 0; } take(); }
				else { const id = take(); if (!id || id.kind !== 'ident') { ok = false; return 0; } }
				return 0;
			}
			take(); return 0;
		}
		if (t.kind === 'lparen') { take(); const v = parseOr(); if (!peek() || peek()!.kind !== 'rparen') { ok = false; return v; } take(); return v; }
		ok = false; return 0;
	}
	function parseUnary(): number {
		const t = peek();
		if (t && t.kind === 'op' && (t.value === '!' || t.value === '+' || t.value === '-' || t.value === '~')) { take(); return parseUnary(); }
		return parsePrimary();
	}
	function parseMul(): number { let v = parseUnary(); while (peek() && peek()!.kind === 'op' && ['*', '/', '%'].includes((peek() as { kind: 'op'; value: string }).value)) { take(); v = parseUnary(); } return v; }
	function parseAdd(): number { let v = parseMul(); while (peek() && peek()!.kind === 'op' && ['+', '-'].includes((peek() as { kind: 'op'; value: string }).value)) { take(); v = parseMul(); } return v; }
	function parseShift(): number { let v = parseAdd(); while (peek() && peek()!.kind === 'op' && ['<<', '>>'].includes((peek() as { kind: 'op'; value: string }).value)) { take(); v = parseAdd(); } return v; }
	function parseRel(): number { let v = parseShift(); while (peek() && peek()!.kind === 'op' && ['<', '>', '<=', '>='].includes((peek() as { kind: 'op'; value: string }).value)) { take(); v = parseShift(); } return v; }
	function parseEq(): number { let v = parseRel(); while (peek() && peek()!.kind === 'op' && ['==', '!='].includes((peek() as { kind: 'op'; value: string }).value)) { take(); v = parseRel(); } return v; }
	function parseBitAnd(): number { let v = parseEq(); while (peek() && peek()!.kind === 'op' && (peek() as { kind: 'op'; value: string }).value === '&') { take(); v = parseEq(); } return v; }
	function parseBitXor(): number { let v = parseBitAnd(); while (peek() && peek()!.kind === 'op' && (peek() as { kind: 'op'; value: string }).value === '^') { take(); v = parseBitAnd(); } return v; }
	function parseBitOr(): number { let v = parseBitXor(); while (peek() && peek()!.kind === 'op' && (peek() as { kind: 'op'; value: string }).value === '|') { take(); v = parseBitXor(); } return v; }
	function parseAnd(): number { let v = parseBitOr(); while (peek() && peek()!.kind === 'op' && (peek() as { kind: 'op'; value: string }).value === '&&') { take(); v = parseBitOr(); } return v; }
	function parseOr(): number { let v = parseAnd(); while (peek() && peek()!.kind === 'op' && (peek() as { kind: 'op'; value: string }).value === '||') { take(); v = parseAnd(); } return v; }
	parseOr();
	if (!ok) return false;
	if (p < toks.length) return false;
	const last = toks[toks.length - 1];
	if (last && last.kind === 'op') return false;
	return true;
}

export type ExpandedToken = Token & { origin?: Token[] };

// Representation split: object-like vs function-like bodies preserved as raw body string currently stored.
// We'll build a normalized map when expanding.
interface FuncMacroDef { params: string[]; hasVarArgs: boolean; body: string; }

function splitMacroTables(macros: MacroDefines): { obj: Record<string, string | number | boolean>; fn: Record<string, FuncMacroDef> } {
	const obj: Record<string, string | number | boolean> = {};
	const fn: Record<string, FuncMacroDef> = {};
	const functionNames = functionMacroNames(macros);
	for (const [k, v] of Object.entries(macros)) {
		if (typeof v === 'string' && functionNames.has(k)) {
			// function-like markers are: starts with '(' paramlist ')' space/body
			const m = /^\(([^)]*)\)\s+([\s\S]*)$/.exec(v);
			if (m) {
				const rawParams = m[1].trim();
				const body = m[2];
				const params = rawParams ? rawParams.split(',').map(s=>s.trim()).filter(Boolean) : [];
				const hasVarArgs = params[params.length-1] === '...';
				const fixed = hasVarArgs ? params.slice(0,-1) : params;
				fn[k] = { params: fixed, hasVarArgs, body };
				continue;
			}
		}
		obj[k] = v;
	}
	return { obj, fn };
}

// Public expansion entry: takes already preprocessed (conditionals/includes applied) tokens with directives removed.
export function expandActiveTokens(tokens: Token[], macroTable: MacroDefines, dynamicMacros?: DynamicMacros): Token[] {
	const { obj, fn } = splitMacroTables(macroTable);
	// We perform multiple passes until no further expansion occurs or max iterations exceeded.
	let work = tokens.slice();
	const MAX_PASSES = 50; // safety
	// Hide-set: track macro names that produced current token to avoid re-expansion in same position
	const hides: WeakMap<Token, Set<string>> = new WeakMap();
	for (let pass=0; pass<MAX_PASSES; pass++) {
		let changed = false;
		const out: Token[] = [];
		for (let i=0;i<work.length;i++) {
			const t = work[i]!;
			if (t.kind !== 'id') { out.push(t); continue; }
			const name = t.value;
			const hs = hides.get(t);
			if (hs && hs.has(name)) { out.push(t); continue; }
			// NOTE: __FILE__ is handled later during AST parsing (applyBuiltinExpansions) so that
			// basename logic is centralized and consistent. We intentionally do not expand here.
			if (name === '__FILE__') { out.push(t); continue; }
			if (Object.prototype.hasOwnProperty.call(dynamicMacros ?? {}, name)) { out.push(t); continue; }
			// Object-like macro expansion
			if (Object.prototype.hasOwnProperty.call(obj, name)) {
				const body = objectMacroToTokens(obj[name], t.file);
				if (body.length) changed = true;
				const dist = distributeSpan(body, t.span.start, t.span.end, t.file);
				for (const nt of dist) {
					const set = new Set<string>([...(hs ?? []), name]);
					hides.set(nt, set);
					out.push(nt);
				}
				continue;
			}
			if (Object.prototype.hasOwnProperty.call(fn, name)) {
				const call = parseMacroCall(work, i+1);
				if (!call) { out.push(t); continue; }
				// Avoid infinite self-expansion: mark this invocation by removing name during its own expansion
				const saved = obj[name];
				delete obj[name];
				const mdef = fn[name]!;
				const expandedBody = expandFunctionMacro(name, mdef, call.args, obj, fn, t.span.start, call.endSpanEnd, t.file);
				if (saved !== undefined) obj[name] = saved; // restore
				if (expandedBody.length) changed = true;
				// advance index to token after call
				i = call.nextIndex - 1;
				const dist = expandedBody; // already distributed
				for (const nt of dist) {
					const set = new Set<string>((hides.get(t) ? Array.from(hides.get(t)!) : []).concat([name]));
					hides.set(nt, set);
					out.push(nt);
				}
				continue;
			}
			out.push(t);
		}
		work = out;
		if (!changed) break;
	}
	return work;
}

// Derive simple alias map (#define FOO BAR) where body is single identifier; exported for signature help.
export function computeMacroAliases(macros: MacroDefines): Record<string,string> {
	const aliases: Record<string,string> = {};
	for (const [k,v] of Object.entries(macros)) {
		if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') {
			const text = String(v).trim();
			if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(text)) aliases[k] = text;
		}
	}
	return aliases;
}

function objectMacroToTokens(v: string | number | boolean, file?: string): Token[] {
	const text = typeof v === 'boolean' ? (v ? 'TRUE' : 'FALSE') : String(v);
	if (!text.length) return [];
	let toks = tokenize(text).filter(t=> t.kind !== 'eof' && t.kind !== 'directive');
	if (file) { for (const tk of toks) { if (!tk.file || tk.file === '<unknown>') (tk as Token).file = file; if (!tk.span.file || tk.span.file === '<unknown>') tk.span.file = file; } }
	// If object-like macro is a single parenthesized literal or identifier, unwrap redundant parens so AST tests expecting NumberLiteral succeed.
	// Do not strip grouping from compound expressions: a bitmask macro like (A | B) must stay grouped when used as x & MASK.
	if (toks.length >=3 && toks[0].kind==='punct' && toks[0].value==='(' && toks[toks.length-1].kind==='punct' && toks[toks.length-1].value===')') {
		let depth=0, ok=true; for (let i=0;i<toks.length;i++){ const tk=toks[i]!; if (tk.kind==='punct'){ if (tk.value==='(') depth++; else if (tk.value===')') depth--; if (depth===0 && i < toks.length-1) { ok=false; break; } } }
		if (ok && canUnwrapParenthesizedMacroTokens(toks)) toks = toks.slice(1,-1);
	}
	return toks;
}

function canUnwrapParenthesizedMacroTokens(toks: Token[]): boolean {
	const inner = toks.slice(1, -1).filter(t => t.kind !== 'comment-line' && t.kind !== 'comment-block');
	return inner.length === 1 && (inner[0]!.kind === 'id' || inner[0]!.kind === 'number' || inner[0]!.kind === 'string' || inner[0]!.kind === 'keyword');
}

type MacroCall = { args: string[]; nextIndex: number; endSpanEnd: number };
function parseMacroCall(tokens: Token[], startIndex: number): MacroCall | null {
	// Normalize original whitespace for stringification while retaining token
	// boundaries, including operators that would otherwise merge (e.g. - -).
	let i = startIndex;
	const open = tokens[i];
	if (!open || open.kind !== 'punct' || open.value !== '(') return null;
	i++; // after '('
	let depth = 1;
	let bracketDepth = 0;
	let angleDepth = 0;
	let current = '';
	const args: string[] = [];
	let previous: Token | undefined;
	let pendingSpace = false;
	const append = (token: Token) => {
		if (current && (pendingSpace || (previous && (token.span.start > previous.span.end || macroTokensNeedSpace(previous, token))))) current += ' ';
		current += token.value;
		previous = token;
		pendingSpace = false;
	};
	let prevCanStartAngleLiteral = true;
	let sawTopLevelComma = false;
	for (; i < tokens.length; i++) {
		const tk = tokens[i]!;
		if (tk.kind === 'comment-line' || tk.kind === 'comment-block' || tk.kind === 'directive') {
			pendingSpace = true;
			continue;
		}
		if (tk.kind === 'punct') {
			if (tk.value === '(') { depth++; append(tk); prevCanStartAngleLiteral = true; continue; }
			if (tk.value === ')') {
				depth--; if (depth === 0) {
					const trimmed = current.trim();
					if (trimmed.length || sawTopLevelComma) args.push(trimmed);
					return { args, nextIndex: i+1, endSpanEnd: tk.span.end };
				}
				append(tk); prevCanStartAngleLiteral = false; continue;
			}
			if (tk.value === '[') { bracketDepth++; append(tk); prevCanStartAngleLiteral = true; continue; }
			if (tk.value === ']') { if (bracketDepth > 0) bracketDepth--; append(tk); prevCanStartAngleLiteral = false; continue; }
			if (tk.value === ',' && depth === 1 && bracketDepth === 0 && angleDepth === 0) { args.push(current.trim()); current=''; previous=undefined; pendingSpace=false; prevCanStartAngleLiteral=true; sawTopLevelComma=true; continue; }
			// other punctuation is significant
			append(tk); prevCanStartAngleLiteral=true; continue;
		}
		if (tk.kind === 'op') {
			if (tk.value === '<' && prevCanStartAngleLiteral) {
				angleDepth++;
				append(tk);
				prevCanStartAngleLiteral = true;
				continue;
			}
			if (tk.value === '>' && angleDepth > 0) {
				angleDepth--;
				append(tk);
				prevCanStartAngleLiteral = false;
				continue;
			}
			append(tk);
			prevCanStartAngleLiteral = true;
			continue;
		}
		append(tk);
		prevCanStartAngleLiteral = false;
	}
	return null; // unterminated -> treat as not a call; parser will handle
}

function expandFunctionMacro(name: string, def: FuncMacroDef, callArgs: string[], obj: Record<string, string | number | boolean>, fn: Record<string, FuncMacroDef>, callStart: number, callEnd: number, file?: string): Token[] {
	const fixedCount = def.params.length;
	const hasVar = def.hasVarArgs;
	const varProvided = hasVar ? callArgs.slice(fixedCount).some(arg => arg.trim().length > 0) : false;
	const mapping = new Map<string,string>();
	for (let i=0;i<fixedCount;i++) mapping.set(def.params[i]!, (callArgs[i] ?? '').trim());
	const vaList = hasVar ? callArgs.slice(fixedCount).map(s=>s.trim()).filter(Boolean) : [];
	const expandArgs = !def.body.includes('##');
	const expandedMapping = new Map<string,string>();
	for (const [p, val] of mapping) expandedMapping.set(p, expandArgs ? expandMacroArgText(val, obj, fn, file) : val);
	const expandedVaList = expandArgs ? vaList.map(arg => expandMacroArgText(arg, obj, fn, file)) : vaList;
	let body = def.body;
	body = expandVaOpt(body, varProvided);
	// Substitute preprocessing tokens, preserving strings/comments and avoiding
	// a second substitution inside an argument inserted by an earlier parameter.
	body = mapMacroCode(body, code => code.replace(/(?<!#)#(?!#)\s*([A-Za-z_]\w*)|\b([A-Za-z_]\w*)\b/g, (match, stringify: string | undefined, parameter: string | undefined) => {
		if (stringify && mapping.has(stringify)) return JSON.stringify(mapping.get(stringify)!);
		return parameter && expandedMapping.has(parameter) ? expandedMapping.get(parameter)! : match;
	}));
	if (hasVar) {
		const joined = expandedVaList.join(', ');
		body = mapMacroCode(body, code => code.replace(/\b__VA_ARGS__\b/g, () => joined));
		if (!varProvided) body = mapMacroCode(body, code => code.replace(/,\s*\)/g, ')'));
	}
	// Token pasting: A ## B -> AB. Perform iterative replacement until no more occurrences.
	// This is done before tokenization so the concatenated identifier is lexed as one token.
	let prevBody: string | null = null;
	while (prevBody !== body) { prevBody = body; body = mapMacroCode(body, applyTokenPasteSimple); }
	// Cleanup: remove artifacts from empty __VA_ARGS__/__VA_OPT__ eliminations.
	body = mapMacroCode(body, code => code
		// Remove a comma right after opening bracket/paren
		.replace(/\[(\s*),/g, '[$1')
		// Remove leading comma before closing bracket or paren: ", ]" or ", )"
		.replace(/,\s*([)\]])/g, '$1')
		// Collapse duplicate commas
		.replace(/,\s*,+/g, ',')
		// Trim comma immediately before closing list bracket
		.replace(/,\s*\]/g, ']')
		// Trim comma immediately after opening list bracket
		.replace(/\[\s*,/g, '['));
	// Turn into tokens (lex body) and distribute span
	let toks = body.length ? tokenize(body).filter(t=> t.kind !== 'eof' && t.kind !== 'directive') : [];
	if (file) { for (const tk of toks) { if (!tk.file || tk.file === '<unknown>') (tk as Token).file = file; if (!tk.span.file || tk.span.file === '<unknown>') tk.span.file = file; } }
	// Drop single enclosing paren pair only for one-token literal/name expansions. Compound expressions need their grouping preserved.
	if (toks.length >=3 && toks[0].kind==='punct' && toks[0].value==='(' && toks[toks.length-1].kind==='punct' && toks[toks.length-1].value===')') {
		let depth=0, ok=true; for (let i=0;i<toks.length;i++){ const tk=toks[i]!; if (tk.kind==='punct'){ if (tk.value==='(') depth++; else if (tk.value===')') depth--; if (depth===0 && i < toks.length-1) { ok=false; break; } } }
		if (ok && canUnwrapParenthesizedMacroTokens(toks)) toks = toks.slice(1,-1);
	}
	// Post-tokenization merging for token pasting that may still have split identifiers (e.g., n + 1 -> n1)
	if (def.body.includes('##') && toks.length > 1) {
		const merged: Token[] = [];
		for (let i = 0; i < toks.length; i++) {
			const a = toks[i]!;
			const b = toks[i+1];
			// Merge patterns: id+id, id+number, number+id when concatenation forms a valid identifier (must start with letter/_)
			if (b && ((a.kind === 'id' || a.kind === 'number') && (b.kind === 'id' || b.kind === 'number'))) {
				const combined = a.value + b.value;
				if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(combined)) {
					merged.push({ kind: 'id', value: combined, span: { start: a.span.start, end: b.span.end, file: a.span.file || a.file }, file: a.file } as Token);
					i++; // skip b
					continue;
				}
			}
			merged.push(a);
		}
		// Only replace if we actually merged something (length reduced)
		if (merged.length < toks.length) toks = merged;
	}
	return distributeSpan(toks, callStart, callEnd, file);
}

function expandMacroArgText(text: string, obj: Record<string, string | number | boolean>, fn: Record<string, FuncMacroDef>, file?: string): string {
	if (!text.trim()) return text;
	const macroTable: MacroDefines = { ...obj };
	for (const [name, def] of Object.entries(fn)) macroTable[name] = `(${def.params.join(',')}${def.hasVarArgs ? `${def.params.length ? ',' : ''}...` : ''}) ${def.body}`;
	functionMacroKinds.set(macroTable, new Set(Object.keys(fn)));
	const toks = tokenize(text).filter(t => t.kind !== 'eof' && t.kind !== 'directive');
	if (file) {
		for (const tk of toks) {
			if (!tk.file || tk.file === '<unknown>') (tk as Token).file = file;
			if (!tk.span.file || tk.span.file === '<unknown>') tk.span.file = file;
		}
	}
	return macroTokensToText(expandActiveTokens(toks, macroTable));
}

function macroTokensToText(tokens: Token[]): string {
	let out = '';
	let previous: Token | undefined;
	for (const tk of tokens) {
		if (tk.kind === 'comment-line' || tk.kind === 'comment-block' || tk.kind === 'directive' || tk.kind === 'eof') continue;
		if (previous && macroTokensNeedSpace(previous, tk)) out += ' ';
		out += tk.value;
		previous = tk;
	}
	return out;
}

function macroTokensNeedSpace(left: Token, right: Token): boolean {
	const joined = tokenize(left.value + right.value).filter(t => t.kind !== 'eof');
	return joined.length !== 2 || joined[0]!.value !== left.value || joined[1]!.value !== right.value;
}

function applyTokenPasteSimple(s: string): string {
	// Accept multi-char left/right (ident/number) not just single char, merge greedily.
	// We iterate merging longest adjacent identifier/number chunks separated by ##.
	return s.replace(/([A-Za-z_][A-Za-z0-9_]*|\d+)\s*##\s*([A-Za-z_][A-Za-z0-9_]*|\d+)/g, (_,a,b)=> a + b);
}

function mapMacroCode(body: string, transform: (code: string) => string): string {
	const protectedTokens = macroBodyTokens(body).filter(t => t.kind === 'string' || t.kind === 'comment-line' || t.kind === 'comment-block');
	let out = '';
	let start = 0;
	for (const token of protectedTokens) {
		out += transform(body.slice(start, token.span.start)) + body.slice(token.span.start, token.span.end);
		start = token.span.end;
	}
	return out + transform(body.slice(start));
}

function macroBodyTokens(body: string): Token[] {
	// A leading # is an operator in a replacement list, not a directive. A
	// harmless prefix keeps the source tokenizer from consuming the whole line.
	return tokenize('(' + body).filter(t => t.span.start > 0 && t.kind !== 'eof').map(t => ({
		...t, span: { ...t.span, start: t.span.start - 1, end: t.span.end - 1 }
	}));
}

function expandVaOpt(body: string, present: boolean): string {
	const tokens = macroBodyTokens(body).filter(t => t.kind !== 'comment-line' && t.kind !== 'comment-block');
	let out = '';
	let start = 0;
	for (let i = 0; i < tokens.length; i++) {
		const marker = tokens[i]!;
		const open = tokens[i + 1];
		if (marker.kind !== 'id' || marker.value !== '__VA_OPT__' || open?.kind !== 'punct' || open.value !== '(') continue;
		let depth = 1;
		let end = i + 2;
		for (; end < tokens.length; end++) {
			const token = tokens[end]!;
			if (token.kind !== 'punct') continue;
			if (token.value === '(') depth++;
			else if (token.value === ')' && --depth === 0) break;
		}
		if (depth !== 0) continue; // Preserve malformed input for normal diagnostics.
		const close = tokens[end]!;
		out += body.slice(start, marker.span.start);
		if (present) out += body.slice(open.span.end, close.span.start);
		start = close.span.end;
		i = end;
	}
	return out + body.slice(start);
}

function distributeSpan(toks: Token[], start: number, end: number, file?: string): Token[] {
	if (toks.length <= 1) return toks.map(t=> ({ ...t, span:{ start, end, file: file || t.span.file || (t as Token).file }, file: file || (t as Token).file }));
	const width = Math.max(1, end-start);
	return toks.map((t,i)=> {
		const a = start + Math.floor((i/ toks.length)*width);
		const b = (i===toks.length-1)? end : start + Math.floor(((i+1)/toks.length)*width);
		return { ...t, span:{ start:a, end: Math.max(a,b), file: file || t.span.file || (t as Token).file }, file: file || (t as Token).file };
	});
}

// pushExpanded no longer used after hide-set integration; keep placeholder for future diff stability
// function pushExpanded(out: Token[], toks: Token[]) { for (const t of toks) out.push(t); }
