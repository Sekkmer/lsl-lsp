import { SemanticTokens, SemanticTokensBuilder, SemanticTokensLegend } from 'vscode-languageserver/node';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { Token } from './lexer';
import { Defs } from './defs';
import { PreprocResult } from './preproc';
import { Analysis } from './parser';
import type { Decl } from './parser';

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

	function isWriteUse(tokens: Token[], i: number): boolean {
		const t = tokens[i];
		if (!t || t.kind !== 'id') return false;
		// Postfix ++/--: id ++ / id --
		const n1 = tokens[i + 1], n2 = tokens[i + 2];
		if (n1 && n2 && n1.kind === 'op' && n2.kind === 'op') {
			if (n1.value === '+' && n2.value === '+') return true;
			if (n1.value === '-' && n2.value === '-') return true;
		}
		// Prefix ++/--: ++ id / -- id
		const p1 = tokens[i - 1], p2 = tokens[i - 2];
		if (p1 && p2 && p1.kind === 'op' && p2.kind === 'op') {
			if (p2.value === '+' && p1.value === '+') return true;
			if (p2.value === '-' && p1.value === '-') return true;
		}
		// Assignment or compound assignment: id [op...]= ...
		let j = i + 1;
		const ops: string[] = [];
		while (j < tokens.length && tokens[j].kind === 'op') { ops.push(tokens[j].value); j++; }
		if (ops.length > 0) {
			const last = ops[ops.length - 1];
			const prev = ops.length >= 2 ? ops[ops.length - 2] : '';
			const prev2 = ops.length >= 3 ? ops[ops.length - 3] : '';
			const endsWithEq = last === '=';
			const isEquality = endsWithEq && (prev === '=' || prev === '!');
			const isRelationalLeGe = endsWithEq && ((prev === '<' && prev2 !== '<') || (prev === '>' && prev2 !== '>'));
			if (endsWithEq && !isEquality && !isRelationalLeGe) return true;
		}
		return false;
	}

	// Pre-scan to find write occurrences and counts; prefer per-declaration when analysis is available.
	const { writeCountsByDecl, writeCountsByName } = computeWrites(toks, analysis);

	function push(t: Token, type: number, mods = 0) {
		const start = doc.positionAt(t.start);
		const len = t.end - t.start;
		b.push(start.line, start.character, len, type, mods);
	}

	// Pre-highlight include path targets as strings for distinct coloring
	if (pre && pre.includeTargets && pre.includeTargets.length > 0) {
		for (const it of pre.includeTargets) {
			const tok: Token = { kind: 'str', value: '', start: it.start, end: it.end } as any;
			push(tok, idx('string'));
		}
	}

	for (let ti = 0; ti < toks.length; ti++) {
		const t = toks[ti];
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
					const tok: Token = { kind: 'id', value: dir, start: dirStart, end: dirStart + dir.length } as any;
					push(tok, idx('keyword'));
				}
				// If define, highlight the macro name as macro
				if (dir === 'define' && m[2]) {
					const name = m[2];
					const nameIdxInLine = text.indexOf(name, dirIdxInLine + dir.length);
					if (nameIdxInLine >= 0) {
						const s = t.start + nameIdxInLine;
						const tok: Token = { kind: 'id', value: name, start: s, end: s + name.length } as any;
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
			// Declarations: classify var/param names where the symbolAt points to a declaration range
			if (analysis) {
				const decl = analysis.symbolAt(t.start);
				if (decl) {
					const ro = isReadonlyDecl(decl, writeCountsByDecl, writeCountsByName);
					const atWrite = false; // declarations are not writes
					const mods = (ro ? bit('readonly') : 0) | (atWrite ? bit('modification') : 0);
					if (decl.kind === 'event') { push(t, idx('function'), mods); continue; }
					if (decl.kind === 'param') { push(t, idx('parameter'), mods); continue; }
					if (decl.kind === 'var') { push(t, idx('variable'), mods); continue; }
				}
			}
			// Function calls: if next token is '(' treat as function/event/macro
			const next = toks[ti + 1];
			// Event handlers inside states: eventName '(' (use defs.events)
			if (next && next.value === '(' && defs.events.has(t.value)) { push(t, idx('function')); continue; }
			// Function-like macros: name '('
			if (next && next.value === '(' && pre && pre.funcMacros && Object.prototype.hasOwnProperty.call(pre.funcMacros, t.value)) {
				push(t, idx('macro')); continue;
			}
			const inIncluded = pre && pre.includeSymbols && Array.from(pre.includeSymbols.values()).some(s => s.functions.has(t.value));
			if (next && next.value === '(' && (defs.funcs.has(t.value) || (analysis && analysis.functions.has(t.value)) || inIncluded)) {
				push(t, idx('function')); continue;
			}
			if (defs.types.has(t.value)) { push(t, idx('type')); continue; }
			if (defs.keywords.has(t.value)) { push(t, idx('keyword')); continue; }
			if (defs.consts.has(t.value)) { push(t, idx('enumMember')); continue; }
			// Object-like macros (and magic __LINE__)
			if (pre && pre.macros && Object.prototype.hasOwnProperty.call(pre.macros, t.value)) { push(t, idx('macro')); continue; }
			if (t.value === '__LINE__') { push(t, idx('macro')); continue; }
			// Variable/parameter uses: prefer scope-aware classification via refAt
			if (analysis) {
				const target = analysis.refAt(t.start);
				if (target && (target.kind === 'param' || target.kind === 'var')) {
					const atWrite = isWriteUse(toks, ti);
					// Parameters are always readonly; variables: readonly is decided per-declaration across the entire scope.
					const ro = target.kind === 'param' ? true : isReadonlyDecl(target, writeCountsByDecl, writeCountsByName);
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

function isReadonlyDecl(decl: Decl, countsByDecl: Map<string, number>, fallbackByName: Map<string, number>): boolean {
	const k = keyForDecl(decl);
	const c = countsByDecl.get(k);
	// Parameters are readonly by language semantics; always mark as readonly.
	if (decl.kind === 'param') return true;
	// For variables/globals: treat single write (typically initializer) as readonly
	if (c != null) return c <= 1;
	// Fallback on name if unresolved
	const n = fallbackByName.get(decl.name) || 0;
	return n <= 1;
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
			const last = ops[ops.length - 1];
			const prev = ops.length >= 2 ? ops[ops.length - 2] : '';
			const prev2 = ops.length >= 3 ? ops[ops.length - 3] : '';
			const endsWithEq = last === '=';
			// Exclude equality (==) and inequality (!=)
			const isEquality = endsWithEq && (prev === '=' || prev === '!');
			// Exclude simple relational <= or >= (but allow <<=/>>= compound assigns)
			const isRelationalLeGe = endsWithEq && ((prev === '<' && prev2 !== '<') || (prev === '>' && prev2 !== '>'));
			if (endsWithEq && !isEquality && !isRelationalLeGe) {
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
	return { writeCountsByDecl: countsByDecl, writeCountsByName: countsByName, writeOffsets: offsets, firstWriteByDecl: firstByDecl, firstWriteByName: firstByName };
}

function bump(map: Map<string, number>, key: string) {
	map.set(key, (map.get(key) || 0) + 1);
}
