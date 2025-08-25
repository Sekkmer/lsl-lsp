import { SemanticTokens, SemanticTokensBuilder, SemanticTokensLegend } from 'vscode-languageserver/node';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { Token } from './lexer';
import { Defs } from './defs';
import { PreprocResult } from './preproc';
import { Analysis } from './parser';

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
					if (decl.kind === 'event') { push(t, idx('function')); continue; }
					if (decl.kind === 'param') { push(t, idx('parameter')); continue; }
					if (decl.kind === 'var') { push(t, idx('variable')); continue; }
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
			// Variable/parameter uses: if there exists a decl with this name (var/param), prefer variable coloring
			if (analysis) {
				const hasParam = analysis.decls.some(d => (d.kind === 'param') && d.name === t.value);
				if (hasParam) { push(t, idx('parameter')); continue; }
				const hasVar = analysis.decls.some(d => (d.kind === 'var') && d.name === t.value);
				if (hasVar) { push(t, idx('variable')); continue; }
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
