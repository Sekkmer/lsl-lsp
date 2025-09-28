import { SemanticTokens, SemanticTokensBuilder, SemanticTokensLegend } from 'vscode-languageserver/node';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { Token } from './lexer';
import { Defs } from './defs';
import type { PreprocResult } from './core/preproc';
import { Analysis } from './analysisTypes';
import type { Decl } from './analysisTypes';
import { isKeyword as isAstKeyword, isKeyword } from './ast/lexer';
import { isType } from './ast';

const tokenTypes = [
	'namespace', 'type', 'class', 'enum', 'interface', 'struct', 'typeParameter',
	'parameter', 'variable', 'property', 'enumMember', 'event', 'function', 'method',
	'macro', 'keyword', 'modifier', 'comment', 'string', 'number', 'regexp', 'operator'
] as const;
const tokenModifiers = ['declaration', 'definition', 'readonly', 'deprecated', 'static', 'abstract', 'async', 'modification', 'documentation', 'defaultLibrary'] as const;

export const semanticTokensLegend: SemanticTokensLegend = {
	tokenTypes: Array.from(tokenTypes),
	tokenModifiers: Array.from(tokenModifiers)
};

export function buildSemanticTokens(
	doc: TextDocument,
	toks: Token[],
	defs: Defs,
	pre: PreprocResult,
	analysis?: Analysis
): SemanticTokens {
	const b = new SemanticTokensBuilder();
	const hasDeclAnalysis = !!analysis;

	// Detect Git merge conflict blocks and their marker lines so we can:
	// 1) highlight marker lines distinctly
	// 2) skip semantic coloring for code within conflict blocks
	const textAll = doc.getText();
	const conflictBlocks = findMergeConflictBlocks(textAll);

	function isWriteUse(tokens: Token[], i: number): boolean {
		const t = tokens[i];
		if (!t || t.kind !== 'id') return false;
		// Postfix ++/--: id ++ / id -- (support combined '++'/'--' or split '+' '+')
		const n1 = tokens[i + 1], n2 = tokens[i + 2];
		if (n1 && n1.kind === 'op') {
			if (n1.value === '++' || n1.value === '--') return true;
			if (n2 && n2.kind === 'op') {
				if (n1.value === '+' && n2.value === '+') return true;
				if (n1.value === '-' && n2.value === '-') return true;
			}
		}
		// Prefix ++/--: ++ id / -- id (support combined '++'/'--' or split '+' '+')
		const p1 = tokens[i - 1], p2 = tokens[i - 2];
		if (p1 && p1.kind === 'op') {
			if (p1.value === '++' || p1.value === '--') return true;
			if (p2 && p2.kind === 'op') {
				if (p2.value === '+' && p1.value === '+') return true;
				if (p2.value === '-' && p1.value === '-') return true;
			}
		}
		// Assignment or compound assignment: id [op...]= ... or combined token like '+=', '-=' etc.
		const j = i + 1;
		const t1 = tokens[j];
		if (t1 && t1.kind === 'op') {
			// Direct combined operators
			if (t1.value === '=' || t1.value === '+=') return true;
			if (t1.value === '-=' || t1.value === '*=' || t1.value === '/=' || t1.value === '%=') return true;
			// Fallback: gather a run and detect an '=' that isn't part of '==' or '<=' '>='
			let k = j; const ops: string[] = [];
			while (k < tokens.length && tokens[k].kind === 'op') { ops.push(tokens[k].value); k++; }
			if (ops.length > 0) {
				const eqIdx = ops.indexOf('=');
				if (eqIdx >= 0) {
					const prev = eqIdx >= 1 ? ops[eqIdx - 1] : '';
					const prev2 = eqIdx >= 2 ? ops[eqIdx - 2] : '';
					const next = eqIdx + 1 < ops.length ? ops[eqIdx + 1] : '';
					const isEquality = (prev === '=' || prev === '!') || next === '=';
					const isRelationalLeGe = (prev === '<' && prev2 !== '<') || (prev === '>' && prev2 !== '>');
					if (!isEquality && !isRelationalLeGe) return true;
				}
			}
		}
		return false;
	}

	// Pre-scan to find write occurrences and counts; prefer per-declaration when analysis is available.
	const { writeCountsByDecl, writeCountsByName, firstWriteByDecl, firstWriteByName } = computeWrites(toks, analysis);

	function isReadonlyForToken(decl: Decl, tokenOffset: number): boolean {
		// Parameters: readonly until first write; if never written, readonly everywhere
		if (decl.kind === 'param') {
			const k = keyForDecl(decl);
			const cnt = writeCountsByDecl.get(k);
			if (hasDeclAnalysis) {
				// With decl-aware analysis: if per-decl info is missing, fall back to name-level info
				if (cnt == null) {
					const byName = writeCountsByName.get(decl.name) || 0;
					if (byName === 0) return true;
					const firstN = firstWriteByName.get(decl.name);
					return firstN != null ? tokenOffset < firstN : true;
				}
				if (cnt === 0) return true;
				const first = firstWriteByDecl.get(k);
				return first != null ? tokenOffset < first : true;
			} else {
				// Fallback by name only when decl mapping isn’t available
				const nameCnt = writeCountsByName.get(decl.name) || 0;
				if (nameCnt === 0) return true;
				const first = firstWriteByName.get(decl.name);
				return first != null ? tokenOffset < first : true;
			}
		}
		// Variables/globals: readonly only when there are NO writes except an optional declaration initializer.
		// Any non-declaration write (assignment, ++/--) anywhere in the file should remove readonly.
		const k = keyForDecl(decl);
		const cnt = writeCountsByDecl.get(k);
		if (!hasDeclAnalysis && cnt == null) {
			// Fallback by name when declaration mapping is unavailable
			const n = writeCountsByName.get(decl.name) || 0;
			// If there's any write by name, assume not readonly; only zero writes => readonly
			return n === 0;
		}
		if (cnt != null && cnt === 0) return true; // nothing wrote at all
		if (cnt != null && cnt >= 2) return false; // at least one non-decl write exists in addition to potential initializer
		// cnt === 1: readonly only if that single write is the declaration initializer
		// Compare against the identifier position within the declaration range, not the range start (which may include type/kw)
		const declIdOffset = findDeclIdentifierOffset(doc, decl);
		const first = firstWriteByDecl.get(k);
		return first != null && declIdOffset != null ? first === declIdOffset : false;
	}

	function push(t: Token, type: number, mods = 0) {
		const start = doc.positionAt(t.start);
		const len = t.end - t.start;
		b.push(start.line, start.character, len, type, mods);
	}

	// Pre-highlight include path target as string, but only the quoted path within the directive
	if (pre && pre.includeTargets && pre.includeTargets.length > 0) {
		for (const it of pre.includeTargets) {
			// Extract the directive text and find the quoted path
			const text = doc.getText().slice(it.start, it.end);
			const qm1 = text.indexOf('"');
			const qm2 = qm1 >= 0 ? text.indexOf('"', qm1 + 1) : -1;
			if (qm1 >= 0 && qm2 > qm1) {
				const s = it.start + qm1;
				const e = it.start + qm2 + 1; // include closing quote
				const tok: Token = { kind: 'str', value: '', start: s, end: e };
				push(tok, idx('string'));
			} else {
				// Fallback: highlight only after the keyword 'include' if present
				const m = /\binclude\b\s+(.*)$/.exec(text);
				if (m) {
					const after = text.indexOf(m[1]);
					if (after >= 0) {
						const tok: Token = { kind: 'str', value: '', start: it.start + after, end: it.end };
						push(tok, idx('string'));
					}
				}
			}
		}
	}

	// Pre-highlight merge conflict marker lines distinctly
	if (conflictBlocks.length > 0) {
		for (const blk of conflictBlocks) {
			for (const ln of blk.markerLines) {
				const tok: Token = { kind: 'id', value: '<<<<<<<', start: ln.start, end: ln.end };
				push(tok, idx('regexp'));
			}
		}
	}

	for (let ti = 0; ti < toks.length; ti++) {
		const t = toks[ti];
		// Skip tokens that are fully inside a merge conflict block; we only color the markers themselves
		if (conflictBlocks.length > 0) {
			let inConflict = false;
			for (const blk of conflictBlocks) {
				if (t.start >= blk.start && t.end <= blk.end) { inConflict = true; break; }
			}
			if (inConflict) continue;
		}
		if (t.kind === 'comment') { push(t, idx('comment')); continue; }
		if (t.kind === 'str') { push(t, idx('string')); continue; }
		if (t.kind === 'num') { push(t, idx('number')); continue; }
		if (t.kind === 'pp') {
			// Parse preprocessor directive for finer-grained coloring
			const text = doc.getText().slice(t.start, t.end);
			const m = /^\s*#\s*(\w+)(?:\s+([A-Za-z_]\w*))?/.exec(text);
			if (m) {
				const dir = m[1];
				// Highlight directive keyword (define/ifdef/ifndef/else/endif/include)
				const dirIdxInLine = text.indexOf(dir);
				if (dirIdxInLine >= 0) {
					const dirStart = t.start + dirIdxInLine;
					const tok: Token = { kind: 'id', value: dir, start: dirStart, end: dirStart + dir.length };
					push(tok, idx('keyword'));
				}
				// If define, highlight the macro name as macro
				if (dir === 'define' && m[2]) {
					const name = m[2];
					const nameIdxInLine = text.indexOf(name, dirIdxInLine + dir.length);
					if (nameIdxInLine >= 0) {
						const s = t.start + nameIdxInLine;
						const tok: Token = { kind: 'id', value: name, start: s, end: s + name.length };
						push(tok, idx('macro'));
					}
				}
				// If include, the include path was already highlighted above via includeTargets
				continue;
			}
			// Fallback: color entire line as macro if parsing fails
			push(t, idx('macro'));
			continue;
		}

		if (t.kind === 'id') {
			// Types must not be colored as keywords; classify types first
			if (isType(t.value)) { push(t, idx('type')); continue; }
			// Keywords should win regardless of following tokens (e.g., 'if('), but exclude types
			if (isKeyword(t.value) || isAstKeyword(t.value)) { push(t, idx('keyword')); continue; }
			// Declarations: classify only when the token is exactly the declaration identifier, not merely inside its range
			if (analysis) {
				const decl = analysis.symbolAt(t.start);
				if (decl) {
					const declIdOffset = findDeclIdentifierOffset(doc, decl);
					const isAtDeclId = declIdOffset != null && declIdOffset === t.start && (decl.name.length === (t.end - t.start));
					if (isAtDeclId) {
						const ro = isReadonlyForToken(decl, t.start);
						const atWrite = false; // declarations are not writes
						const mods = (ro ? bit('readonly') : 0) | (atWrite ? bit('modification') : 0);
						if (decl.kind === 'event') { push(t, idx('function'), mods); continue; }
						if (decl.kind === 'param') { push(t, idx('parameter'), mods); continue; }
						if (decl.kind === 'var') { push(t, idx('variable'), mods); continue; }
					}
				}
			}
			// Function calls: if next token is '(' treat as function/event/macro
			const next = toks[ti + 1];
			// Event handlers inside states: eventName '(' (use defs.events)
			if (next && next.value === '(' && defs.events.has(t.value)) { push(t, idx('function'), bit('defaultLibrary')); continue; }
			// Function-like macros: name '('
			if (next && next.value === '(' && pre && pre.funcMacros && Object.prototype.hasOwnProperty.call(pre.funcMacros, t.value)) {
				push(t, idx('macro')); continue;
			}
			if (next && next.value === '(') {
				if (defs.funcs.has(t.value)) {
					// Built-in function: defaultLibrary and possibly deprecated
					let mods = bit('defaultLibrary');
					const overloads = defs.funcs.get(t.value)!;
					if (overloads.some(o => o.deprecated)) mods |= bit('deprecated');
					push(t, idx('function'), mods); continue;
				}
				if (analysis && analysis.functions.has(t.value)) {
					push(t, idx('function')); continue;
				}
			}
			// (types and keywords handled above)
			if (defs.consts.has(t.value)) {
				let mods = bit('defaultLibrary');
				const c = defs.consts.get(t.value);
				if (c && c.deprecated) mods |= bit('deprecated');
				push(t, idx('enumMember'), mods); continue;
			}
			// Object-like macros (and magic __LINE__)
			if (pre && pre.macros && Object.prototype.hasOwnProperty.call(pre.macros, t.value)) { push(t, idx('macro')); continue; }
			if (t.value === '__LINE__') { push(t, idx('macro')); continue; }
			// Variable/parameter uses: prefer scope-aware classification via refAt
			if (analysis) {
				const target = analysis.refAt(t.start);
				if (target && (target.kind === 'param' || target.kind === 'var')) {
					const atWrite = isWriteUse(toks, ti);
					// Readonly decided per-token for parameters (until first write),
					// and per-declaration for variables/globals.
					const ro = isReadonlyForToken(target, t.start);
					const mods = (ro ? bit('readonly') : 0) | (atWrite ? bit('modification') : 0);
					push(t, idx(target.kind === 'param' ? 'parameter' : 'variable'), mods);
					continue;
				}
			}
			// Remaining bare identifiers could be states/events/etc.; leave untyped
		}
		if (t.kind === 'op' || t.kind === 'punc') { push(t, idx('operator')); continue; }
	}

	return b.build();
}

function idx(name: typeof tokenTypes[number]): number {
	return (semanticTokensLegend.tokenTypes as string[]).indexOf(name);
}

function bit(name: typeof tokenModifiers[number]): number {
	return 1 << (semanticTokensLegend.tokenModifiers as string[]).indexOf(name);
}

function keyForDecl(d: Decl): string {
	// Unique enough key by kind+span+name
	return `${d.kind}:${(d.range.start.line)}:${(d.range.start.character)}-${(d.range.end.line)}:${(d.range.end.character)}:${d.name}`;
}

// Note: isReadonlyDecl helper removed; logic inlined in isReadonlyForToken for clarity.

function findDeclIdentifierOffset(doc: TextDocument, decl: Decl): number | null {
	try {
		const start = doc.offsetAt(decl.range.start);
		const end = doc.offsetAt(decl.range.end);
		if (end <= start) return null;
		const text = doc.getText().slice(start, end);
		const idx = text.indexOf(decl.name);
		if (idx < 0) return null;
		return start + idx;
	} catch {
		return null;
	}
}

function computeWrites(toks: Token[], analysis?: Analysis): {
	writeCountsByDecl: Map<string, number>;
	writeCountsByName: Map<string, number>;
	writeOffsets: Set<number>;
	firstWriteByDecl: Map<string, number>;
	firstWriteByName: Map<string, number>;
} {
	const countsByDecl = new Map<string, number>();
	const countsByName = new Map<string, number>();
	const firstByDecl = new Map<string, number>();
	const firstByName = new Map<string, number>();
	const offsets = new Set<number>();
	for (let i = 0; i < toks.length; i++) {
		const t = toks[i];
		if (t.kind !== 'id') continue;
		// Handle combined postfix ++/-- (id '++' / id '--')
		const tNext = toks[i + 1];
		if (tNext && tNext.kind === 'op' && (tNext.value === '++' || tNext.value === '--')) {
			bump(countsByName, t.value);
			if (!firstByName.has(t.value)) firstByName.set(t.value, t.start); else { const cur = firstByName.get(t.value)!; if (t.start < cur) firstByName.set(t.value, t.start); }
			const d = analysis ? (analysis.refAt(t.start) || analysis.symbolAt(t.start)) : null;
			if (d) {
				const k = keyForDecl(d);
				bump(countsByDecl, k);
				if (!firstByDecl.has(k) || t.start < (firstByDecl.get(k) as number)) firstByDecl.set(k, t.start);
			}
			offsets.add(t.start);
			continue;
		}
		// Handle combined prefix ++/-- ('++' id / '--' id)
		const tPrev = toks[i - 1];
		if (tPrev && tPrev.kind === 'op' && (tPrev.value === '++' || tPrev.value === '--')) {
			bump(countsByName, t.value);
			if (!firstByName.has(t.value)) firstByName.set(t.value, t.start); else { const cur = firstByName.get(t.value)!; if (t.start < cur) firstByName.set(t.value, t.start); }
			const d = analysis ? (analysis.refAt(t.start) || analysis.symbolAt(t.start)) : null;
			if (d) {
				const k = keyForDecl(d);
				bump(countsByDecl, k);
				if (!firstByDecl.has(k) || t.start < (firstByDecl.get(k) as number)) firstByDecl.set(k, t.start);
			}
			offsets.add(t.start);
			continue;
		}
		// Direct combined compound assignment right after id:
		// id += expr, id -= expr, id *= expr, id /= expr, id %= expr
		const t1 = toks[i + 1];
		if (t1 && t1.kind === 'op' && (t1.value === '+=' || t1.value === '-=' || t1.value === '*=' || t1.value === '/=' || t1.value === '%=')) {
			bump(countsByName, t.value);
			if (!firstByName.has(t.value)) firstByName.set(t.value, t.start); else { const cur = firstByName.get(t.value)!; if (t.start < cur) firstByName.set(t.value, t.start); }
			const d = analysis ? (analysis.refAt(t.start) || analysis.symbolAt(t.start)) : null;
			if (d) {
				const k = keyForDecl(d);
				bump(countsByDecl, k);
				if (!firstByDecl.has(k) || t.start < (firstByDecl.get(k) as number)) firstByDecl.set(k, t.start);
			}
			offsets.add(t.start);
			continue;
		}
		// Detect postfix ++ / -- (id ++ / id --)
		const n1 = toks[i + 1], n2 = toks[i + 2];
		const isPostInc = n1 && n2 && n1.kind === 'op' && n2.kind === 'op' && n1.value === '+' && n2.value === '+';
		const isPostDec = n1 && n2 && n1.kind === 'op' && n2.kind === 'op' && n1.value === '-' && n2.value === '-';
		if (isPostInc || isPostDec) {
			// Name-level accounting
			bump(countsByName, t.value);
			if (!firstByName.has(t.value)) firstByName.set(t.value, t.start);
			else { const cur = firstByName.get(t.value)!; if (t.start < cur) firstByName.set(t.value, t.start); }
			// Decl-level accounting when resolvable
			const d = analysis ? (analysis.refAt(t.start) || analysis.symbolAt(t.start)) : null;
			if (d) {
				const k = keyForDecl(d);
				bump(countsByDecl, k);
				if (!firstByDecl.has(k) || t.start < (firstByDecl.get(k) as number)) firstByDecl.set(k, t.start);
			}
			offsets.add(t.start); continue;
		}
		// Detect prefix ++ / -- (++ id / -- id)
		const p1 = toks[i - 1], p2 = toks[i - 2];
		const isPreInc = p1 && p2 && p1.kind === 'op' && p2.kind === 'op' && p2.value === '+' && p1.value === '+';
		const isPreDec = p1 && p2 && p1.kind === 'op' && p2.kind === 'op' && p2.value === '-' && p1.value === '-';
		if (isPreInc || isPreDec) {
			bump(countsByName, t.value);
			if (!firstByName.has(t.value)) firstByName.set(t.value, t.start); else { const cur = firstByName.get(t.value)!; if (t.start < cur) firstByName.set(t.value, t.start); }
			const d = analysis ? (analysis.refAt(t.start) || analysis.symbolAt(t.start)) : null;
			if (d) {
				const k = keyForDecl(d);
				bump(countsByDecl, k);
				if (!firstByDecl.has(k) || t.start < (firstByDecl.get(k) as number)) firstByDecl.set(k, t.start);
			}
			offsets.add(t.start); continue;
		}
		// Detect assignments and compound assignments: id [op...]= expr
		let j = i + 1;
		// Gather contiguous operator tokens after the identifier
		const ops: string[] = [];
		while (j < toks.length && toks[j].kind === 'op') { ops.push(toks[j].value); j++; }
		if (ops.length > 0) {
			const eqIdx = ops.indexOf('=');
			if (eqIdx >= 0) {
				const prev = eqIdx >= 1 ? ops[eqIdx - 1] : '';
				const prev2 = eqIdx >= 2 ? ops[eqIdx - 2] : '';
				const next = eqIdx + 1 < ops.length ? ops[eqIdx + 1] : '';
				// Exclude equality (==) and inequality (!=)
				const isEquality = (prev === '=' || prev === '!') || next === '=';
				// Exclude simple relational <= or >= (but allow <<=/>>= compound assigns)
				const isRelationalLeGe = (prev === '<' && prev2 !== '<') || (prev === '>' && prev2 !== '>');
				if (!isEquality && !isRelationalLeGe) {
					bump(countsByName, t.value);
					if (!firstByName.has(t.value)) firstByName.set(t.value, t.start); else { const cur = firstByName.get(t.value)!; if (t.start < cur) firstByName.set(t.value, t.start); }
					const d = analysis ? (analysis.refAt(t.start) || analysis.symbolAt(t.start)) : null;
					if (d) {
						const k = keyForDecl(d);
						bump(countsByDecl, k);
						if (!firstByDecl.has(k) || t.start < (firstByDecl.get(k) as number)) firstByDecl.set(k, t.start);
					}
					offsets.add(t.start); continue;
				}
			}
		}
	}
	return { writeCountsByDecl: countsByDecl, writeCountsByName: countsByName, writeOffsets: offsets, firstWriteByDecl: firstByDecl, firstWriteByName: firstByName };
}

function bump(map: Map<string, number>, key: string) {
	map.set(key, (map.get(key) || 0) + 1);
}

// Detect Git merge conflict blocks in raw text. Returns block spans and marker line spans.
function findMergeConflictBlocks(text: string): { start: number; end: number; markerLines: { start: number; end: number }[] }[] {
	const blocks: { start: number; end: number; markerLines: { start: number; end: number }[] }[] = [];
	const lines: { start: number; end: number; text: string }[] = [];
	let idx = 0;
	while (idx <= text.length) {
		const nl = text.indexOf('\n', idx);
		const end = nl === -1 ? text.length : nl + 1;
		lines.push({ start: idx, end, text: text.slice(idx, end) });
		if (nl === -1) break; idx = end;
	}
	let i = 0;
	while (i < lines.length) {
		const L = lines[i]!;
		if (/^<<<<<<< .*/.test(L.text)) {
			const markerLines: { start: number; end: number }[] = [{ start: L.start, end: L.end }];
			let j = i + 1;
			let sawSep = false;
			// optional base marker exists in 3-way conflicts (|||||||). We record the line but don't use the index.
			// Optional base marker for 3-way: ||||||| BASE
			while (j < lines.length) {
				const T = lines[j]!;
				if (!sawSep && /^\|\|\|\|\|\|\|.*$/.test(T.text)) { markerLines.push({ start: T.start, end: T.end }); j++; continue; }
				if (!sawSep && /^=======\s*$/.test(T.text)) { markerLines.push({ start: T.start, end: T.end }); sawSep = true; j++; continue; }
				if (sawSep && /^>>>>>>> .*/.test(T.text)) { markerLines.push({ start: T.start, end: T.end }); const end = T.end; blocks.push({ start: L.start, end, markerLines }); i = j; break; }
				j++;
			}
		}
		i++;
	}
	return blocks;
}
