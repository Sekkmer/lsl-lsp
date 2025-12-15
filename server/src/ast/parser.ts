/*
	New AST parser for LSL that builds server/src/ast structures and resolves macros.
	It uses the preprocessor to get macro tables and disabled ranges, then tokenizes
	the active code, attaches leading comments as `comment` on decl nodes.
*/
import type { Expr, Stmt, Script, Function as FnNode, State, Event, Type, Span, Diagnostic } from './types';
import { isType, spanFrom } from './types';
import { Lexer } from './lexer';
import type { Token } from '../core/tokens';
import { preprocessForAst } from '../core/pipeline';
import type { MacroDefines } from '../core/macro';
import { basenameFromUri } from '../builtins';
import { Tokenizer } from '../core/tokenizer';
import { TokenStream } from '../core/tokens';
// (macro expansion already applied via preprocessForAst.expandedTokens)

type ParseOptions = {
	macros?: MacroDefines;
	includePaths?: string[];
	// When provided, reuse precomputed preprocessing (tokens/macros) instead of invoking internally again.
	pre?: ReturnType<typeof preprocessForAst>;
};

export function parseScriptFromText(text: string, uri = 'file:///memory.lsl', opts?: ParseOptions): Script {
	// Reuse provided pre result when available to avoid double preprocessing (important for tests/pipeline).
	const fromPath = uri.startsWith('file://') ? require('vscode-uri').URI.parse(uri).fsPath : undefined;
	const basename = basenameFromUri(uri);
	// Avoid redefining __FILE__ early; builtin expansion handles it.
	const baseDefines = { ...(opts?.macros ?? {}) };
	const pre = opts?.pre ?? preprocessForAst(text, { includePaths: opts?.includePaths ?? [], fromPath, defines: baseDefines });
	const tz = new Tokenizer(text);
	const commentTokens: Token[] = [];
	for (;;) { const t = tz.next(); if (t.kind === 'comment-line' || t.kind === 'comment-block') commentTokens.push(t); if (t.kind === 'eof') break; }
	const lineStarts = computeLineStarts(text);
	const builtinsExpanded = applyBuiltinExpansions(pre.expandedTokens || [], basename, lineStarts);
	const merged: Token[] = mergeTokensWithComments(builtinsExpanded, commentTokens);
	const ts = new TokenStream(merged);
	const lxAdapter: Pick<Lexer, 'next' | 'peek' | 'pushBack'> = {
		next: () => ts.next(),
		peek: () => ts.peek(),
		pushBack: (t: Token) => ts.pushBack(t)
	} as unknown as Lexer;
	const P = new Parser(lxAdapter as Lexer, text, { disableSourceHeuristics: true });
	return P.parseScript();
}

function computeLineStarts(text: string): number[] {
	const ls = [0];
	for (let i = 0; i < text.length; i++) if (text[i] === '\n') ls.push(i + 1);
	return ls;
}

function lineOf(offset: number, lineStarts: number[]): number {
	let lo = 0, hi = lineStarts.length - 1, ans = 0;
	while (lo <= hi) {
		const mid = (lo + hi) >> 1;
		const s = lineStarts[mid]!;
		const e = mid + 1 < lineStarts.length ? lineStarts[mid + 1]! - 1 : Number.MAX_SAFE_INTEGER;
		if (offset < s) hi = mid - 1; else if (offset > e) lo = mid + 1; else { ans = mid; break; }
	}
	return ans + 1;
}

// Replace built-in identifiers with proper literal tokens so parser produces correct AST nodes.
function applyBuiltinExpansions(tokens: Token[], basename: string, lineStarts: number[]): Token[] {
	return tokens.map(t => {
		if (t.kind === 'id') {
			if (t.value === '__LINE__') {
				return { kind: 'number', value: String(lineOf(t.span.start, lineStarts)), span: t.span, file: t.file || '<unknown>' } as Token;
			}
			if (t.value === '__FILE__') {
				return { kind: 'string', value: JSON.stringify(basename), span: t.span, file: t.file || '<unknown>' } as Token;
			}
		}
		return t;
	});
}

function mergeTokensWithComments(code: Token[], comments: Token[]): Token[] {
	// Goal: keep original expanded token order (which encodes include inlining) while
	// still exposing root-file comments to the parser so leading doc comments attach.
	// Previous implementation globally sorted by span which broke ordering because
	// include tokens use their own file-local span coordinates.
	const codeFiltered = code.filter(t => t.kind !== 'eof');
	// Root-file path is the first token's file (best effort)
	const rootFile = codeFiltered.find(t => !!t.file)?.file;
	const pendingComments = comments
		.filter(c => c.kind === 'comment-line' || c.kind === 'comment-block')
		.sort((a, b) => a.span.start - b.span.start || a.span.end - b.span.end);
	const out: Token[] = [];
	let ci = 0;
	for (const tk of codeFiltered) {
		if (rootFile && tk.file === rootFile) {
			// Flush any comments whose start is <= this root-file token start
			while (ci < pendingComments.length && pendingComments[ci]!.span.start <= tk.span.start) {
				out.push(pendingComments[ci++]!);
			}
		}
		out.push(tk);
	}
	// Append remaining comments (e.g., those after last code token)
	while (ci < pendingComments.length) out.push(pendingComments[ci++]!);
	const lastEnd = out.length ? Math.max(...out.map(t => t.span.end)) : 0;
	const eofFile = codeFiltered.length ? (codeFiltered[codeFiltered.length - 1]!.file || rootFile || '<unknown>') : (rootFile || '<unknown>');
	out.push({ kind: 'eof', value: '', span: { start: lastEnd, end: lastEnd }, file: eofFile } as Token);
	return out;
}

interface ParserOptions { disableSourceHeuristics?: boolean }

class Parser {
	private readonly lx: Lexer;
	private readonly src: string;
	private look: Token | null = null;
	// comment buffer for leading doc comments
	private leadingComment = '';
	private diagnostics: Diagnostic[] = [];
	private readonly disableSourceHeuristics: boolean;

	constructor(lx: Lexer, src: string, opts?: ParserOptions) { this.lx = lx; this.src = src; this.disableSourceHeuristics = !!opts?.disableSourceHeuristics; }

	private next(): Token {
		if (this.look) { const t = this.look; this.look = null; return t; }
		let t = this.lx.next();
		// accumulate comments; skip preprocessor directives entirely
		for (; ;) {
			if (t.kind === 'comment-line' || t.kind === 'comment-block') {
				// If this is a block comment that does not end with */, report a syntax error but continue.
				if (t.kind === 'comment-block') {
					const end = t.span.end;
					const closed = end >= 2 && this.src.slice(Math.max(0, end - 2), end) === '*/';
					if (!closed) {
						this.report(t, 'Unterminated block comment', 'LSL000');
					}
				}
				const text = t.value.replace(/^[ \t]*\/\/?[ \t]?/, '');
				if (this.leadingComment) this.leadingComment += '\n';
				this.leadingComment += text;
				t = this.lx.next();
				continue;
			}
			if (t.kind === 'directive') { t = this.lx.next(); continue; }
			break;
		}
		return t;
	}

	private peek(): Token { if (!this.look) this.look = this.next(); return this.look; }
	private eat(kind?: Token['kind'], value?: string): Token {
		const t = this.peek();
		const kindOk = !kind || t.kind === kind;
		const valueOk = !value || t.value === value;
		if (kindOk && valueOk) { this.look = null; return t; }
		// insertion recovery: do not consume unexpected token; fabricate the expected one
		const pos = t.span.start;
		this.report(t, `expected ${value ? `'${value}'` : (kind ?? 'token')}`);
		const k: Token['kind'] = kind ?? t.kind;
		const v: string = value ?? '';
		return { kind: k, value: v, span: { start: pos, end: pos }, file: this.peek().file || '<unknown>' };
	}
	private maybe(kind: Token['kind'], value?: string): Token | null {
		const t = this.peek();
		if (t.kind === kind && (value === undefined || t.value === value)) { this.look = null; return t; }
		return null;
	}
	private err(t: Token, msg: string): Error { return new Error(`ParseError@${t.span.start}-${t.span.end}: ${msg}`); }

	private report(t: Token, message: string, code = 'LSL000') { this.diagnostics.push({ span: { start: t.span.start, end: t.span.end }, message, severity: 'error', code }); }

	private recover(message: string, at: Token): Token {
		// record and fabricate a harmless token matching expectation to allow progress
		this.report(at, message);
		return at;
	}

	// Accept an identifier-like name token: either a normal identifier or a keyword used as a name.
	// This lets the analyzer later flag reserved identifiers instead of the parser hard-failing.
	private eatNameToken(): Token {
		const t = this.peek();
		if (t.kind === 'id' || t.kind === 'keyword') { this.look = null; return t; }
		// fallback: fabricate expected id token to keep progress
		const fabricated = this.eat('id');
		if (!fabricated.file) (fabricated as Token).file = this.peek().file || '<unknown>';
		return fabricated;
	}

	private syncTopLevel() {
		// consume tokens until a reasonable top-level start: type keyword or 'state' or EOF/';'
		for (; ;) {
			const t = this.peek();
			if (t.kind === 'eof') return;
			if (t.kind === 'keyword' && (isType(t.value) || t.value === 'state')) return;
			if (t.kind === 'punct' && t.value === ';') { this.next(); return; }
			// skip a token
			this.next();
		}
	}

	// Return the next k non-trivia tokens (skipping directives and comments) without consuming the stream
	private lookAheadNonTrivia(k: number): Token[] {
		const out: Token[] = [];
		const savedLook = this.look;
		// Helper to fetch next raw token from lexer
		const nextRaw = (): Token => this.lx.next();
		const isTrivia = (t: Token) => t.kind === 'directive' || t.kind === 'comment-line' || t.kind === 'comment-block';
		// Seed from current peek()
		let t0: Token;
		if (this.look) { t0 = this.look; }
		else {
			let t = nextRaw();
			while (isTrivia(t)) t = nextRaw();
			// push back for normal consumption by parser.next()
			if (t.kind !== 'eof') this.lx.pushBack(t);
			t0 = t;
		}
		out.push(t0);
		// If we're already at EOF, don't attempt to pull further tokens
		if (t0.kind === 'eof') { this.look = savedLook; return out; }
		// Collect further tokens by pulling from lexer and then pushing back
		for (let i = 1; i < k; i++) {
			let t = nextRaw();
			while (isTrivia(t)) t = nextRaw();
			out.push(t);
			if (t.kind === 'eof') break;
		}
		// Restore stream: push back only tokens after the first in reverse order.
		// The first token is either already stored in this.look or was already pushBack'ed above.
		for (let i = out.length - 1; i >= 1; i--) { const t = out[i]!; if (t.kind !== 'eof') this.lx.pushBack(t); }
		// Restore look token
		this.look = savedLook;
		return out;
	}

	parseScript(): Script {
		const start = this.peek().span.start;
		type FnWithOrigin = FnNode & { originFile?: string };
		type GlobalWithOrigin = import('./types').GlobalVar & { originFile?: string };
		const functions = new Map<string, FnWithOrigin>();
		const states = new Map<string, State>();
		const globals = new Map<string, GlobalWithOrigin>();
		// Helper to normalize identifier names so that leading/trailing "noise" characters
		// (historically tolerated in LSL tooling: # $ ? \ ' ") do not cause distinct symbols.
		// The lexer already strips these for identifier tokens produced after unification, but
		// some earlier test expectations (identifier_noise) rely on a defensive normalization
		// layer here in case future token sources (e.g. synthetic include decl scan) surface
		// raw names containing noise. Keep logic extremely small and allocation-light.
		const normalizeName = (name: string): string => {
			if (!name) return name;
			let s = 0; let e = name.length;
			const isNoise = (c: string) => c === '#' || c === '$' || c === '?' || c === '\\' || c === '"' || c === '\'';
			while (s < e && isNoise(name[s]!)) s++;
			while (e > s && isNoise(name[e - 1]!)) e--;
			return name.slice(s, e);
		};
		while (this.peek().kind !== 'eof') {
			// skip any directives that may have been peeked
			if (this.peek().kind === 'directive') { this.look = null; this.lx.next(); continue; }
			// skip stray semicolons
			if (this.maybe('punct', ';')) continue;
			// Permissive mode: tolerate bare call or expression statements that appear at
			// top-level in included headers (test fixtures intentionally include a call
			// like `llSay(0, "dbg");`). Historically these were ignored; to preserve
			// zero-diagnostic expectation we consume a leading pattern <id '(' ... ')'> ';'
			// without emitting an error. We only trigger when the first token is an id
			// (not a type keyword) and we immediately see '(' as the next non-trivia token.
			{
				const t0 = this.peek();
				if (t0.kind === 'id') {
					const la = this.lookAheadNonTrivia(2)[1];
					if (la && la.kind === 'punct' && la.value === '(') {
						// Before treating it as a bare call, detect implicit-void function pattern id(...) { ... }.
						// We can't toggle disableSourceHeuristics (readonly); instead perform a lightweight
						// ad-hoc scan: ensure that after the parenthesis group the next non-trivia token is '{'.
						let scanIdx = 0;
						let parenDepth = 0;
						let sawGroup = false;
						const tokens: Token[] = [];
						// Collect a small window of tokens to inspect pattern id ( ... ) '{'
						while (scanIdx < 40) { // arbitrary small cap
							const t = this.lookAheadNonTrivia(scanIdx + 1)[scanIdx];
							if (!t) break;
							tokens.push(t);
							if (tokens.length === 1) { scanIdx++; continue; } // first is id
							if (tokens.length === 2 && !(t.kind === 'punct' && t.value === '(')) break; // not call pattern
							if (t.kind === 'punct' && t.value === '(') { parenDepth++; }
							else if (t.kind === 'punct' && t.value === ')') { parenDepth--; if (parenDepth === 0) { sawGroup = true; break; } }
							scanIdx++;
						}
						let looksImplicit = false;
						if (sawGroup) {
							// After capturing the group, peek the next non-trivia token after the ')'
							const afterGroup = this.lookAheadNonTrivia(tokens.length + 1)[tokens.length];
							looksImplicit = !!afterGroup && afterGroup.kind === 'punct' && afterGroup.value === '{';
						}
						if (!looksImplicit) {
							// Treat as bare call/expression statement: consume id + balanced parens then optional ';'
							this.next(); // id
							if (this.peek().kind === 'punct' && this.peek().value === '(') {
								let depth = 0;
								while (true) {
									const t = this.next();
									if (t.kind === 'punct' && t.value === '(') depth++;
									else if (t.kind === 'punct' && t.value === ')') { depth--; if (depth === 0) break; }
									if (t.kind === 'eof') break;
								}
								if (this.peek().kind === 'punct' && this.peek().value === ';') this.next();
								continue; // proceed to next top-level construct
							}
						}
					}
				}
			}
			// Detect and report illegal global state-change statements: "state <id>;"
			if (this.peek().kind === 'keyword' && this.peek().value === 'state') {
				const tState = this.peek();
				let matched: { end: number } | null = null;
				if (!this.disableSourceHeuristics) {
					const sc = this.looksLikeStateChangeAfter(tState.span.end);
					if (sc) matched = { end: sc.end };
				} else {
					// Token-based fallback: state <id|default> ';' (but NOT followed by '{')
					const la = this.lookAheadNonTrivia(3);
					const t1 = la[1];
					const t2 = la[2];
					const t1IsName = t1 && ((t1.kind === 'id') || (t1.kind === 'keyword' && t1.value === 'default'));
					if (t1IsName && t2 && t2.kind === 'punct') {
						if (t2.value === ';') {
							matched = { end: t2.span.end };
						} else if (t2.value === '{') {
							// state decl, not a change
						}
					}
				}
				if (matched) {
					this.eat('keyword', 'state');
					if (this.peek().kind === 'keyword' && this.peek().value === 'default') { this.next(); }
					else { this.eat('id'); }
					this.maybe('punct', ';');
					this.report({ kind: 'id', value: '', span: { start: tState.span.start, end: matched.end }, file: tState.file || '<unknown>' }, 'State change statements are only allowed inside event handlers', 'LSL023');
					continue;
				}
			}
			// try state decl
			if (this.peek().kind === 'keyword' && this.peek().value === 'state') {
				const st = this.parseState();
				states.set(st.name, st);
				continue;
			}
			// default state without explicit 'state' keyword
			if (this.peek().kind === 'keyword' && this.peek().value === 'default') {
				const st = this.parseDefaultState();
				states.set(st.name, st);
				continue;
			}
			// function or global var: only start if next is a type keyword
			const nextTok = this.peek();
			if (nextTok.kind === 'keyword' && isType(nextTok.value)) {
				let decl: FnNode | { span: Span; kind: 'GlobalVar'; varType: Type; name: string; initializer?: Expr; comment?: string; };
				try { decl = this.parseTopLevel(); }
				catch (e: unknown) { const msg = e instanceof Error ? e.message : String(e); this.report(this.peek(), msg); this.syncTopLevel(); continue; }
				if ('varType' in decl) {
					const norm = normalizeName(decl.name);
					const prev = globals.get(norm);
					if (prev) {
						const prevFile = prev.originFile;
						const curFile = nextTok.file || '<unknown>';
						if (!prevFile || prevFile === curFile) {
							this.report({ kind: 'id', value: norm, span: decl.span, file: curFile }, 'Duplicate declaration', 'LSL070');
						}
					}
					if (norm !== decl.name) { (decl as { name: string }).name = norm; }
					const gWithOrigin: GlobalWithOrigin = { ...decl, originFile: nextTok.file || '<unknown>' } as GlobalWithOrigin;
					globals.set(norm, gWithOrigin);
				} else {
					const norm = normalizeName(decl.name);
					const prev = functions.get(norm);
					if (prev) {
						const prevFile = prev.originFile;
						const curFile = nextTok.file || '<unknown>';
						if (!prevFile || prevFile === curFile) {
							this.report({ kind: 'id', value: norm, span: decl.span, file: curFile }, 'Duplicate declaration', 'LSL070');
						}
					}
					if (norm !== decl.name) { (decl as { name: string }).name = norm; }
					const fWithOrigin: FnWithOrigin = { ...decl, originFile: nextTok.file || '<unknown>' } as FnWithOrigin;
					functions.set(norm, fWithOrigin);
				}
				continue;
			}
			// Implicit-void function: <id> '(' ... ')' '{' ... '}'
			// Allow implicit-void function detection even in expanded token mode (tests rely on this)
			const implicitFn = nextTok.kind === 'id' && (
				this.looksLikeImplicitFunctionDeclAfter(nextTok.span.end)
				|| (this.disableSourceHeuristics && (() => { const la = this.lookAheadNonTrivia(2); return la[1] && la[1].kind === 'punct' && la[1].value === '('; })())
			);
			if (implicitFn) {
				const leading = this.consumeLeadingComment();
				const nameTok = this.eat('id');
				this.eat('punct', '(');
				const params = this.parseParamList();
				const body = this.parseBlock(/*inFunctionOrEvent*/ true);
				const span = spanFrom(nameTok.span.start, body.span.end);
				const norm = normalizeName(nameTok.value);
				const node: FnNode = { span, kind: 'Function', name: norm, parameters: params, body, comment: leading, returnType: 'void' };
				const prev = functions.get(norm);
				if (prev) {
					const prevFile = prev.originFile;
					const curFile = nameTok.file;
					if (!prevFile || prevFile === curFile) {
						this.report({ kind: 'id', value: norm, span, file: curFile } as Token, 'Duplicate declaration', 'LSL070');
					}
				}
				functions.set(norm, { ...node, originFile: nameTok.file });
				continue;
			}
			// otherwise, skip unexpected token at top-level
			this.report(nextTok, `unexpected token ${nextTok.kind} '${nextTok.value}' at top-level`);
			this.next();
		}
		const end = this.peek().span.end;
		return { span: spanFrom(start, end), kind: 'Script', functions, states, globals, diagnostics: this.diagnostics } as Script;
	}

	private parseTopLevel(): FnNode | { span: Span; kind: 'GlobalVar'; varType: Type; name: string; initializer?: Expr; comment?: string; } {
		// Either: <type> <name> '(' ... -> function ; or '{'
		// Or: <type> <name> [= expr] ;	-> global
		// Capture any leading doc comment right at decl start
		const leading = this.consumeLeadingComment();
		const first = this.next();
		if (!(first.kind === 'keyword' && isType(first.value))) { this.report(first, 'expected type', 'LSL000'); return { span: first.span, kind: 'GlobalVar', varType: 'integer' as Type, name: '__error', comment: undefined }; }
		const varType = first.value as Type;
		// Collect a run of identifier/keyword tokens immediately following the type. Some external
		// headers use attribute-like markers before the real variable name: `string _user DEFAULT_DOMAIN = "...";`
		// We treat the LAST token in such a run as the variable name unless the FIRST token is
		// immediately followed by '(' (function declaration). We continue consuming id/keyword tokens
		// until we see one of: '=' (initializer), ';' (end of decl), '(' (parameter list – only if it
		// follows the FIRST token), or any non id/keyword token. This avoids prematurely stopping on
		// attribute-like markers that appear between the type and the true variable name.
		const nameCandidates: Token[] = [];
		{
			let guard = 0;
			let sawPotentialFunc = false;
			while (guard < 32) { // slightly larger cap for safety
				const pk = this.peek();
				if (!(pk.kind === 'id' || pk.kind === 'keyword')) break;
				nameCandidates.push(this.next());
				guard++;
				// Function declaration detection: only consider the FIRST candidate; if immediately followed
				// by '(' treat entire construct as function and stop collecting further name candidates.
				if (nameCandidates.length === 1) {
					const la = this.lookAheadNonTrivia(2)[1];
					if (la && la.kind === 'punct' && la.value === '(') { sawPotentialFunc = true; break; }
					continue;
				}
				// Look ahead one token past current to decide if we should stop accumulating.
				const la2 = this.lookAheadNonTrivia(2)[1];
				if (!la2) break;
				if (la2.kind === 'op' && la2.value === '=') break; // start of initializer
				if (la2.kind === 'punct' && la2.value === ';') break; // end of declaration
				// If we encounter '(' after more than one candidate, that's ambiguous (likely stray attribute
				// followed by function name). Treat FIRST token as name for function; push back extra consumed
				// tokens (other than first) so they can be parsed as statements (rare). Simpler: just stop and
				// let normal function path below treat collected[0] as name.
				if (la2.kind === 'punct' && la2.value === '(') break;
			}
			// If we broke out because we saw a function pattern, ensure only the first candidate is kept
			// to avoid misinterpreting attributes as part of the name.
			if (sawPotentialFunc && nameCandidates.length > 1) {
				nameCandidates.splice(1); // keep only first
			}
		}
		if (nameCandidates.length === 0) {
			// Fallback to original behaviour
			nameCandidates.push(this.eatNameToken());
		}
		const funcLook = this.peek();
		if (funcLook.kind === 'punct' && funcLook.value === '(') {
			// Function decl: use FIRST candidate as name; remaining candidates ignored as stray attrs
			const fnNameTok = nameCandidates[0]!;
			this.next(); // consume '('
			const params = this.parseParamList();
			const body = this.parseBlock(/*inFunctionOrEvent*/ true);
			const span = spanFrom(first.span.start, body.span.end);
			const node: FnNode = { span, kind: 'Function', name: fnNameTok.value, parameters: params, body, comment: leading, returnType: varType };
			return node;
		}
		// Global variable: choose LAST candidate as the variable name; earlier ones are attributes
		const nameTok = nameCandidates[nameCandidates.length - 1]!;
		const name = nameTok.value;
		let initializer: Expr | undefined;
		if (this.maybe('op', '=')) { initializer = this.parseExpr(); }
		this.eat('punct', ';');
		const gv = { span: spanFrom(first.span.start, nameTok.span.end), kind: 'GlobalVar', varType, name, initializer, comment: leading } as const;
		return gv;
	}

	private parseParamList(): Map<string, Type> {
		// we are after '('
		const params = new Map<string, Type>();
		let guard = 0;
		while (!this.maybe('punct', ')')) {
			// EOF/stuck protection
			if (this.peek().kind === 'eof') { this.report(this.peek(), 'missing ) to close parameter list', 'LSL000'); break; }
			// If we encounter a block start before closing ')', assume missing ')' and recover
			if (this.peek().kind === 'punct' && this.peek().value === '{') { this.report(this.peek(), 'missing ) to close parameter list', 'LSL000'); break; }
			if (++guard > 10000) { this.report(this.peek(), 'parser recovery limit in parameter list', 'LSL000'); break; }
			const tType = this.next();
			if (!(tType.kind === 'keyword' && isType(tType.value))) {
				// Recovery: if we see an id or other token where a type is expected, report once and try to skip until ',' or ')'
				this.report(tType, 'expected param type', 'LSL000');
				// attempt to resync
				while (this.peek().kind !== 'punct' || (this.peek().value !== ',' && this.peek().value !== ')')) {
					if (this.peek().kind === 'eof') break;
					this.next();
				}
				this.maybe('punct', ',');
				continue;
			}
			const tName = this.eatNameToken();
			params.set(tName.value, tType.value as Type);
			this.maybe('punct', ',');
		}
		return params;
	}

	private parseState(): State {
		const kw = this.eat('keyword', 'state');
		// state name can be an identifier or the special keyword 'default'
		let nameTok = this.peek();
		let name: string;
		if (nameTok.kind === 'id') { name = this.next().value; }
		else if (nameTok.kind === 'keyword' && nameTok.value === 'default') { name = this.next().value; }
		else { nameTok = this.eat('id'); name = nameTok.value; }
		// Parse state body: a sequence of event declarations "name(type param, ...) { ... }"
		this.eat('punct', '{');
		const events: Event[] = [];
		let loopGuard = 0;
		while (!this.maybe('punct', '}')) {
			if (++loopGuard > 10000) { this.report(this.peek(), 'parser recovery limit reached inside state', 'LSL000'); break; }
			// Skip directives and stray semicolons
			while (this.peek().kind === 'directive') { this.look = null; this.lx.next(); }
			if (this.maybe('punct', ';')) continue;
			// If we see a new top-level declaration inside a state body, assume missing '}' before it
			const look = this.peek();
			if (look.kind === 'keyword') {
				const ahead = this.lookAheadNonTrivia(3);
				const t1 = ahead[1];
				const t2 = ahead[2];
				const tokenStateDecl = look.value === 'state' && (
					((t1 && (t1.kind === 'id' || (t1.kind === 'keyword' && t1.value === 'default'))) && t2 && t2.kind === 'punct' && t2.value === '{')
				);
				const tokenDefaultDecl = look.value === 'default' && (t1 && t1.kind === 'punct' && t1.value === '{');
				const tokenFuncDecl = isType(look.value) && (t1 && (t1.kind === 'id' || t1.kind === 'keyword') && t2 && t2.kind === 'punct' && t2.value === '(');
				if (tokenStateDecl || tokenDefaultDecl || tokenFuncDecl) { this.report(look, 'missing } before next declaration', 'LSL000'); break; }
			}
			if (look.kind === 'eof') { this.report(look, 'missing } before end of file', 'LSL000'); break; }
			const t = this.peek();
			if (t.kind === 'id') {
				const evNameTok = this.next();
				if (this.maybe('punct', '(')) {
					// parse typed parameter list
					const params = this.parseParamList();
					// parse body block
					const body = this.parseBlock(/*inFunctionOrEvent*/ true);
					const ev: Event = { span: spanFrom(evNameTok.span.start, body.span.end), kind: 'Event', name: evNameTok.value, parameters: params, body };
					events.push(ev);
					continue;
				} else {
					// Not an event declaration; attempt to recover by parsing as statement and discarding
					try { this.parseStmt(false); }
					catch { /* ignored; error already reported by parseStmt */ }
					continue;
				}
			}
			// Fallback: try to parse a statement to advance and recover
			try { this.parseStmt(false); } catch { /* errors already reported */ }
		}
		return { span: spanFrom(kw.span.start, this.peek().span.end), kind: 'State', name, events };
	}

	private parseDefaultState(): State {
		const def = this.eat('keyword', 'default');
		this.eat('punct', '{');
		const events: Event[] = [];
		let loopGuard = 0;
		while (!this.maybe('punct', '}')) {
			if (++loopGuard > 10000) { this.report(this.peek(), 'parser recovery limit reached inside default state', 'LSL000'); break; }
			while (this.peek().kind === 'directive') { this.look = null; this.lx.next(); }
			if (this.maybe('punct', ';')) continue;
			const look = this.peek();
			if (look.kind === 'keyword') {
				const ahead = this.lookAheadNonTrivia(3);
				const t1 = ahead[1];
				const t2 = ahead[2];
				const tokenStateDecl = look.value === 'state' && (((t1 && (t1.kind === 'id' || (t1.kind === 'keyword' && t1.value === 'default'))) && t2 && t2.kind === 'punct' && t2.value === '{'));
				const tokenDefaultDecl = look.value === 'default' && (t1 && t1.kind === 'punct' && t1.value === '{');
				const tokenFuncDecl = isType(look.value) && (t1 && (t1.kind === 'id' || t1.kind === 'keyword') && t2 && t2.kind === 'punct' && t2.value === '(');
				if (tokenStateDecl || tokenDefaultDecl || tokenFuncDecl) { this.report(look, 'missing } before next declaration', 'LSL000'); break; }
			}
			if (look.kind === 'eof') { this.report(look, 'missing } before end of file', 'LSL000'); break; }
			const t = this.peek();
			if (t.kind === 'id') {
				// Treat any identifier followed by '(' as an event declaration. This keeps unknown event
				// names producing proper analyzer diagnostics (LSL021) instead of being parsed as statements.
				const la = this.lookAheadNonTrivia(2)[1];
				if (la && la.kind === 'punct' && la.value === '(') {
					const evNameTok = this.next();
					this.eat('punct', '(');
					const params = this.parseParamList();
					const body = this.parseBlock(/*inFunctionOrEvent*/ true);
					const ev: Event = { span: spanFrom(evNameTok.span.start, body.span.end), kind: 'Event', name: evNameTok.value, parameters: params, body };
					events.push(ev);
					continue;
				}
				// Otherwise parse as a statement
				try { this.parseStmt(false); } catch { /* ignore */ }
				continue;
			}
			try { this.parseStmt(false); } catch { /* ignore */ }
		}
		return { span: spanFrom(def.span.start, this.peek().span.end), kind: 'State', name: 'default', events };
	}

	private parseBlock(inFunctionOrEvent = false): Stmt {
		const lbrace = this.eat('punct', '{');
		const statements: Stmt[] = [];
		let loopGuard = 0;
		let rbraceEnd: number | null = null;
		for (; ;) {
			if (++loopGuard > 20000) { this.report(this.peek(), 'parser recovery limit reached inside block', 'LSL000'); break; }
			// Close on explicit '}'
			const rb = this.maybe('punct', '}');
			if (rb) { rbraceEnd = rb.span.end; break; }
			// If we see the beginning of a new top-level declaration inside a block,
			// either (a) emit LSL022 for illegal state/default blocks declared in function/event bodies,
			// or (b) assume missing '}' before next true top-level declaration (function) and recover by exiting.
			const look = this.peek();
			if (look.kind === 'keyword') {
				const ahead = this.lookAheadNonTrivia(3);
				const t1 = ahead[1];
				const t2 = ahead[2];
				const tokenStateDecl = look.value === 'state' && (
					((t1 && (t1.kind === 'id' || (t1.kind === 'keyword' && t1.value === 'default'))) && t2 && t2.kind === 'punct' && t2.value === '{')
				);
				const tokenDefaultDecl = look.value === 'default' && (t1 && t1.kind === 'punct' && t1.value === '{');
				const tokenFuncDecl = isType(look.value) && (t1 && (t1.kind === 'id' || t1.kind === 'keyword') && t2 && t2.kind === 'punct' && t2.value === '(');
				const isFuncDecl = (isType(look.value) && this.looksLikeFunctionDeclAfter(look.span.end)) || tokenFuncDecl;
				const isStateDecl = (look.value === 'state' && this.looksLikeStateDeclAfter(look.span.end)) || tokenStateDecl;
				const isDefaultStateDecl = (look.value === 'default' && this.looksLikeDefaultStateDeclAfter(look.span.end)) || tokenDefaultDecl;
				if (isStateDecl || isDefaultStateDecl) {
					if (inFunctionOrEvent) {
						if (this.atLineStart(look.span.start)) { this.report(look, 'missing } before next declaration', 'LSL000'); break; }
						if (isStateDecl) {
							const kw = this.eat('keyword', 'state');
							if (this.peek().kind === 'keyword' && this.peek().value === 'default') this.next(); else this.eat('id');
							const body = this.parseBlock(true);
							this.report({ kind: 'id', value: '', span: { start: kw.span.start, end: body.span.end }, file: kw.file || '<unknown>' }, 'State declarations are only allowed at global scope', 'LSL022');
							statements.push({ span: spanFrom(kw.span.start, body.span.end), kind: 'ErrorStmt' } as Stmt);
							continue;
						} else if (isDefaultStateDecl) {
							const def = this.eat('keyword', 'default');
							const body = this.parseBlock(true);
							this.report({ kind: 'id', value: '', span: { start: def.span.start, end: body.span.end }, file: def.file || '<unknown>' }, 'State declarations are only allowed at global scope', 'LSL022');
							statements.push({ span: spanFrom(def.span.start, body.span.end), kind: 'ErrorStmt' } as Stmt);
							continue;
						}
					}
					this.report(look, 'missing } before next declaration', 'LSL000');
					break;
				}
				if (isFuncDecl) {
					// Heuristic: if the immediate non-trivia character before this token is '}',
					// assume the enclosing block just ended and avoid a spurious LSL000.
					// This helps when preprocessor boundaries or recovery consumed the '}' token
					// before we observed it here.
					const prevNonTrivia = (() => {
						let i = look.span.start - 1;
						// skip whitespace
						while (i >= 0) {
							const ch = this.src[i]!;
							if (ch === ' ' || ch === '\t' || ch === '\r' || ch === '\n') { i--; continue; }
							// skip line comments
							if (ch === '\n') { i--; continue; }
							// crude skip for block comments/endings handled above in scanning forward paths
							return ch;
						}
						return '';
					})();
					if (prevNonTrivia === '}') { break; }
					this.report(look, 'missing } before next declaration', 'LSL000');
					break;
				}
			}
			// Recovery for missing '}' before an 'else' that begins a line inside a block.
			// Treat this as the end of the current block and let the enclosing parser (e.g., parseIf)
			// consume the 'else'. Do not consume 'else' here.
			if (look.kind === 'keyword' && look.value === 'else' && this.atLineStart(look.span.start)) {
				// Only attach an 'else' to the preceding IfStmt when the raw source contains a
				// closing '}' immediately before 'else' (possibly inside a disabled preprocessor range).
				// This keeps the grammar sound while still handling preprocessor-split branches.
				let j = look.span.start - 1;
				while (j >= 0) { const ch = this.src[j]!; if (ch === ' ' || ch === '\t' || ch === '\r' || ch === '\n') { j--; continue; } break; }
				const prevCh = j >= 0 ? this.src[j]! : '';
				if (prevCh === '}' && statements.length > 0) {
					const prev = statements[statements.length - 1];
					if (prev && prev.kind === 'IfStmt' && !prev.else) {
						this.eat('keyword', 'else');
						let elseStmt: Stmt;
						if (this.peek().kind === 'keyword' && this.peek().value === 'if') elseStmt = this.parseIf(inFunctionOrEvent);
						else if (this.peek().kind === 'punct' && this.peek().value === '{') elseStmt = this.parseBlock(inFunctionOrEvent);
						else elseStmt = this.parseStmtInner(inFunctionOrEvent);
						prev.else = elseStmt;
						prev.span = spanFrom(prev.span.start, elseStmt.span.end);
						continue;
					}
				}
				// No matching if (or no preceding '}'): report and consume the stray else to avoid stalling
				this.report(look, 'unexpected \'else\' without matching \'if\'', 'LSL000');
				this.next();
				try { this.parseStmtInner(inFunctionOrEvent); } catch { /* ignore; already reported */ }
				continue;
			}
			// tolerate EOF to avoid crashes
			if (this.peek().kind === 'eof') { this.report(this.peek(), 'missing } before end of file', 'LSL000'); break; }
			try { statements.push(this.parseStmt(inFunctionOrEvent)); }
			catch (e: unknown) { const msg = e instanceof Error ? e.message : String(e); this.report(this.peek(), msg, 'LSL000'); this.syncTo([';', '}']); if (this.maybe('punct', ';')) continue; if (this.maybe('punct', '}')) { rbraceEnd = this.peek().span.end; break; } continue; }
		}
		const end = rbraceEnd ?? this.peek().span.end;
		return { span: spanFrom(lbrace.span.start, end), kind: 'BlockStmt', statements };
	}

	// Heuristic: after a type keyword at pos, do we have an identifier followed by '(' (function decl)?
	private looksLikeFunctionDeclAfter(pos: number): boolean {
		if (this.disableSourceHeuristics) return false;
		let i = pos;
		// skip whitespace and comments
		while (i < this.src.length) {
			const ch = this.src[i]!;
			if (ch === ' ' || ch === '\t' || ch === '\r' || ch === '\n') { i++; continue; }
			if (ch === '/' && this.src[i + 1] === '/') { i += 2; while (i < this.src.length && this.src[i] !== '\n') i++; continue; }
			if (ch === '/' && this.src[i + 1] === '*') { i += 2; while (i < this.src.length && !(this.src[i] === '*' && this.src[i + 1] === '/')) i++; if (i < this.src.length) i += 2; continue; }
			break;
		}
		// identifier (allow leading noise like #, $, ?, \\)
		const isNoise = (c: string | undefined) => c === '#' || c === '$' || c === '?' || c === '\\' || c === '"' || c === '\'';
		while (i < this.src.length && isNoise(this.src[i]!)) i++;
		const startId = i;
		if (i < this.src.length && /[A-Za-z_]/.test(this.src[i]!)) {
			i++;
			while (i < this.src.length && /[A-Za-z0-9_]/.test(this.src[i]!)) i++;
		} else {
			return false;
		}
		// trailing noise
		while (i < this.src.length && isNoise(this.src[i]!)) i++;
		// skip trivia
		while (i < this.src.length) {
			const ch = this.src[i]!;
			if (ch === ' ' || ch === '\t' || ch === '\r' || ch === '\n') { i++; continue; }
			if (ch === '/' && this.src[i + 1] === '/') { i += 2; while (i < this.src.length && this.src[i] !== '\n') i++; continue; }
			if (ch === '/' && this.src[i + 1] === '*') { i += 2; while (i < this.src.length && !(this.src[i] === '*' && this.src[i + 1] === '/')) i++; if (i < this.src.length) i += 2; continue; }
			break;
		}
		// function param list starts with '('
		return i > startId && this.src[i] === '(';
	}

	// Heuristic: after an identifier at pos, do we immediately see '(' (implicit-void function)?
	private looksLikeImplicitFunctionDeclAfter(pos: number): boolean {
		if (this.disableSourceHeuristics) return false;
		let i = pos;
		const skipTrivia = () => {
			while (i < this.src.length) {
				const ch = this.src[i]!;
				if (ch === ' ' || ch === '\t' || ch === '\r' || ch === '\n') { i++; continue; }
				if (ch === '/' && this.src[i + 1] === '/') { i += 2; while (i < this.src.length && this.src[i] !== '\n') i++; continue; }
				if (ch === '/' && this.src[i + 1] === '*') { i += 2; while (i < this.src.length && !(this.src[i] === '*' && this.src[i + 1] === '/')) i++; if (i < this.src.length) i += 2; continue; }
				break;
			}
		};
		skipTrivia();
		if (this.src[i] !== '(') return false;
		// scan to matching ')'
		let depth = 0;
		while (i < this.src.length) {
			const ch = this.src[i++]!;
			if (ch === '(') depth++;
			else if (ch === ')') { depth--; if (depth === 0) break; }
			else if (ch === '"' || ch === '\'') {
				const quote = ch; // skip string contents roughly
				while (i < this.src.length) { const c = this.src[i++]!; if (c === '\\') { i++; continue; } if (c === quote) break; }
			}
		}
		skipTrivia();
		return this.src[i] === '{';
	}


	// Heuristic: after 'state' keyword, do we have an identifier or 'default' followed by '{'?
	private looksLikeStateDeclAfter(pos: number): boolean {
		if (this.disableSourceHeuristics) return false;
		let i = pos;
		const skipTrivia = () => {
			while (i < this.src.length) {
				const ch = this.src[i]!;
				if (ch === ' ' || ch === '\t' || ch === '\r' || ch === '\n') { i++; continue; }
				if (ch === '/' && this.src[i + 1] === '/') { i += 2; while (i < this.src.length && this.src[i] !== '\n') i++; continue; }
				if (ch === '/' && this.src[i + 1] === '*') { i += 2; while (i < this.src.length && !(this.src[i] === '*' && this.src[i + 1] === '/')) i++; if (i < this.src.length) i += 2; continue; }
				break;
			}
		};
		skipTrivia();
		// identifier or 'default' (allow leading noise)
		const isNoise = (c: string | undefined) => c === '#' || c === '$' || c === '?' || c === '\\' || c === '"' || c === '\'';
		while (i < this.src.length && isNoise(this.src[i]!)) i++;
		if (i < this.src.length && /[A-Za-z_]/.test(this.src[i]!)) {
			// read word
			let j = i + 1; while (j < this.src.length && /[A-Za-z0-9_]/.test(this.src[j]!)) j++;
			i = j;
			while (i < this.src.length && isNoise(this.src[i]!)) i++;
		} else if (this.src.slice(i, i + 7) === 'default') {
			i += 7;
		} else {
			return false;
		}
		skipTrivia();
		return this.src[i] === '{';
	}

	private looksLikeDefaultStateDeclAfter(pos: number): boolean {
		if (this.disableSourceHeuristics) return false;
		let i = pos;
		while (i < this.src.length) {
			const ch = this.src[i]!;
			if (ch === ' ' || ch === '\t' || ch === '\r' || ch === '\n') { i++; continue; }
			if (ch === '/' && this.src[i + 1] === '/') { i += 2; while (i < this.src.length && this.src[i] !== '\n') i++; continue; }
			if (ch === '/' && this.src[i + 1] === '*') { i += 2; while (i < this.src.length && !(this.src[i] === '*' && this.src[i + 1] === '/')) i++; if (i < this.src.length) i += 2; continue; }
			break;
		}
		return this.src[i] === '{';
	}

	// Heuristic: detect pattern after 'state' at the given position: identifier followed by ';'
	private looksLikeStateChangeAfter(pos: number): { name: string; end: number } | null {
		if (this.disableSourceHeuristics) return null;
		let i = pos;
		const skipTrivia = () => {
			while (i < this.src.length) {
				const ch = this.src[i]!;
				if (ch === ' ' || ch === '\t' || ch === '\r' || ch === '\n') { i++; continue; }
				if (ch === '/' && this.src[i + 1] === '/') { i += 2; while (i < this.src.length && this.src[i] !== '\n') i++; continue; }
				if (ch === '/' && this.src[i + 1] === '*') { i += 2; while (i < this.src.length && !(this.src[i] === '*' && this.src[i + 1] === '/')) i++; if (i < this.src.length) i += 2; continue; }
				break;
			}
		};
		skipTrivia();
		const isNoise = (c: string | undefined) => c === '#' || c === '$' || c === '?' || c === '\\' || c === '"' || c === '\'';
		while (i < this.src.length && isNoise(this.src[i]!)) i++;
		const idStart = i;
		if (i < this.src.length && /[A-Za-z_]/.test(this.src[i]!)) { i++; while (i < this.src.length && /[A-Za-z0-9_]/.test(this.src[i]!)) i++; }
		else return null;
		const name = this.src.slice(idStart, i);
		skipTrivia();
		if (this.src[i] === ';') return { name, end: i + 1 };
		return null;
	}

	private syncTo(punctuations: string[]) {
		for (; ;) {
			const t = this.peek();
			if (t.kind === 'eof') return;
			if (t.kind === 'punct' && punctuations.includes(t.value)) return;
			this.next();
		}
	}

	private parseStmt(inFunctionOrEvent = false): Stmt {
		// skip any directives between statements
		while (this.peek().kind === 'directive') { this.look = null; this.lx.next(); }
		const t = this.peek();
		// empty statement ';'
		if (t.kind === 'punct' && t.value === ';') { const semi = this.next(); return { span: semi.span, kind: 'EmptyStmt' } as Stmt; }
		// block
		if (t.kind === 'punct' && t.value === '{') return this.parseBlock(inFunctionOrEvent);
		// Standalone 'else' is handled at the block level to allow attaching to the previous IfStmt.
		// if/while/for/return
		if (t.kind === 'keyword') {
			switch (t.value) {
				case 'if': return this.parseIf(inFunctionOrEvent);
				case 'while': return this.parseWhile(inFunctionOrEvent);
				case 'do': return this.parseDoWhile(inFunctionOrEvent);
				case 'for': return this.parseFor(inFunctionOrEvent);
				case 'return': return this.parseReturn();
				case 'state': {
					// could be state-change or illegal state decl inside block
					const kw = this.eat('keyword', 'state');
					let nameTok = this.peek();
					if (nameTok.kind === 'keyword' && nameTok.value === 'default') { this.next(); }
					else { nameTok = this.eat('id'); }
					if (this.peek().kind === 'punct' && this.peek().value === '{') {
						const body = this.parseBlock(true);
						this.report({ kind: 'id', value: '', span: { start: kw.span.start, end: body.span.end }, file: kw.file || '<unknown>' }, 'State declarations are only allowed at global scope', 'LSL022');
						return { span: spanFrom(kw.span.start, body.span.end), kind: 'ErrorStmt' } as Stmt;
					}
					this.maybe('punct', ';');
					return { span: spanFrom(kw.span.start, nameTok.span.end), kind: 'StateChangeStmt', state: nameTok.value } as Stmt;
				}
				case 'default': {
					// default block inside function/event is illegal here
					if (this.lx.peek().kind === 'punct' && this.lx.peek().value === '{') {
						const def = this.eat('keyword', 'default');
						const body = this.parseBlock(true);
						this.report({ kind: 'id', value: '', span: { start: def.span.start, end: body.span.end }, file: def.file || '<unknown>' }, 'State declarations are only allowed at global scope', 'LSL022');
						return { span: spanFrom(def.span.start, body.span.end), kind: 'ErrorStmt' } as Stmt;
					}
					break;
				}
			}
			// var decl inside block
			if (isType(t.value)) return this.parseVarDecl();
		}
		// label using '@name;' form (enforced)
		if (t.kind === 'punct' && t.value === '@') {
			const at = this.next();
			const nameTok = this.eat('id');
			// Require a terminating semicolon; if not present, emit a diagnostic via eat()
			const semi = this.eat('punct', ';');
			return { span: spanFrom(at.span.start, semi.span.end || nameTok.span.end), kind: 'LabelStmt', name: nameTok.value } as Stmt;
		}
		// legacy label: name:  -> emit diagnostic, still produce a LabelStmt for downstream analysis
		if (t.kind === 'id' || (t.kind === 'keyword' && t.value === 'default')) {
			// label: <id>:
			const t2 = this.lx.peek();
			if (t2.kind === 'punct' && t2.value === ':') {
				const nameTok = this.next();
				const colon = this.eat('punct', ':');
				this.report(nameTok, `Labels must start with @ (use "@${nameTok.value};")`, 'LSL000');
				return { span: spanFrom(nameTok.span.start, colon.span.end), kind: 'LabelStmt', name: nameTok.value } as Stmt;
			}
		}
		// jump statement
		if (t.kind === 'keyword' && t.value === 'jump') {
			const kw = this.eat('keyword', 'jump');
			const target = this.eat('id');
			const semi = this.maybe('punct', ';');
			const end = semi ? semi.span.end : target.span.end;
			return { span: spanFrom(kw.span.start, end), kind: 'JumpStmt', target: { span: target.span, kind: 'Identifier', name: target.value } } as Stmt;
		}
		// expr;
		try {
			const expr = this.parseExpr();
			// Expect semicolon; if missing, point error at current cursor and recover
			const semi = this.maybe('punct', ';');
			if (!semi) {
				// If the next token maps to the exact same span as the expression end (macro body remap),
				// look ahead one more non-directive token before deciding it’s a true missing semicolon.
				let nxt = this.peek();
				while (nxt.kind === 'directive') { this.look = null; this.lx.next(); nxt = this.peek(); }
				const sameSpan = (nxt.span.start === expr.span.end && nxt.span.end === expr.span.end);
				if (!sameSpan) {
					this.report(nxt, 'missing ; after statement', 'LSL000');
				}
			}
			const end = semi ? semi.span.end : this.peek().span.end;
			return { span: spanFrom(expr.span.start, end), kind: 'ExprStmt', expression: expr };
		} catch (e: unknown) {
			const msg = e instanceof Error ? e.message : String(e);
			this.report(this.peek(), msg, 'LSL000');
			this.syncTo([';', '}']);
			this.maybe('punct', ';');
			return { span: t.span, kind: 'ErrorStmt' } as Stmt;
		}
	}

	private parseVarDecl(): Stmt {
		const tType = this.eat('keyword');
		if (!isType(tType.value)) { this.report(tType, 'expected type', 'LSL000'); return { span: tType.span, kind: 'ErrorStmt' } as Stmt; }
		const nameTok = this.eatNameToken();
		let initializer: Expr | undefined;
		if (this.maybe('op', '=')) initializer = this.parseExpr();
		this.eat('punct', ';');
		return { span: spanFrom(tType.span.start, nameTok.span.end), kind: 'VarDecl', varType: tType.value as Type, name: nameTok.value, initializer, comment: this.consumeLeadingComment() };
	}
	private parseIf(inFunctionOrEvent: boolean): Stmt {
		const kw = this.eat('keyword', 'if'); this.eat('punct', '(');
		const cond = this.parseExpr(); this.eat('punct', ')');
		const thenS = this.parseStmtInner(inFunctionOrEvent);
		let elseS: Stmt | undefined;
		if (this.maybe('keyword', 'else')) elseS = this.parseStmtInner(inFunctionOrEvent);
		return { span: spanFrom(kw.span.start, thenS.span.end), kind: 'IfStmt', condition: cond, then: thenS, else: elseS };
	}

	private parseWhile(inFunctionOrEvent: boolean): Stmt {
		const kw = this.eat('keyword', 'while'); this.eat('punct', '(');
		const cond = this.parseExpr(); this.eat('punct', ')');
		const body = this.parseStmtInner(inFunctionOrEvent);
		return { span: spanFrom(kw.span.start, body.span.end), kind: 'WhileStmt', condition: cond, body };
	}

	private parseDoWhile(inFunctionOrEvent: boolean): Stmt {
		const kw = this.eat('keyword', 'do');
		const body = this.parseStmtInner(inFunctionOrEvent);
		this.eat('keyword', 'while'); this.eat('punct', '(');
		const cond = this.parseExpr(); this.eat('punct', ')'); this.eat('punct', ';');
		return { span: spanFrom(kw.span.start, body.span.end), kind: 'DoWhileStmt', body, condition: cond };
	}

	private parseFor(inFunctionOrEvent: boolean): Stmt {
		const kw = this.eat('keyword', 'for'); this.eat('punct', '(');
		// init (optional)
		let init: Expr | undefined;
		if (!this.maybe('punct', ';')) {
			init = this.parseExpr();
			this.eat('punct', ';');
		}
		// condition (optional)
		let cond: Expr | undefined;
		if (!this.maybe('punct', ';')) {
			cond = this.parseExpr();
			this.eat('punct', ';');
		}
		// update (optional)
		let update: Expr | undefined;
		if (!this.maybe('punct', ')')) {
			update = this.parseExpr();
			this.eat('punct', ')');
		}
		const body = this.parseStmtInner(inFunctionOrEvent);
		return { span: spanFrom(kw.span.start, body.span.end), kind: 'ForStmt', init, condition: cond, update, body } as Stmt;
	}

	// Helper to ensure inFunctionOrEvent flag is passed into nested blocks/statements
	private parseStmtInner(inFunctionOrEvent: boolean): Stmt {
		// Peek: if next is a block, call parseBlock with flag; otherwise call parseStmt with flag via dispatch
		const t = this.peek();
		if (t.kind === 'punct' && t.value === '{') return this.parseBlock(inFunctionOrEvent);
		// For single statements following control-flow, reuse parseStmt with the same context
		return this.parseStmt(inFunctionOrEvent);
	}

	private parseReturn(): Stmt {
		const kw = this.eat('keyword', 'return');
		// Allow bare `return;` (no expression)
		const semiEarly = this.maybe('punct', ';');
		if (semiEarly) {
			return { span: spanFrom(kw.span.start, semiEarly.span.end), kind: 'ReturnStmt' } as Stmt;
		}
		// If immediately followed by a closing brace or EOF, report missing semicolon and treat as bare return
		const next = this.peek();
		if ((next.kind === 'punct' && next.value === '}') || next.kind === 'eof') {
			this.report(next, 'Missing semicolon after return', 'LSL000');
			return { span: kw.span, kind: 'ReturnStmt' } as Stmt;
		}
		// Otherwise parse an expression and then require semicolon
		const expr = this.parseExpr();
		const semi = this.maybe('punct', ';');
		if (!semi) {
			this.report(this.peek(), 'Missing semicolon after return', 'LSL000');
			return { span: spanFrom(kw.span.start, expr.span.end), kind: 'ReturnStmt', expression: expr };
		}
		return { span: spanFrom(kw.span.start, semi.span.end), kind: 'ReturnStmt', expression: expr };
	}

	private parseExpr(stopOps?: Set<string>): Expr {
		try { return this.parseAssign(stopOps); }
		catch (e: unknown) { const msg = e instanceof Error ? e.message : String(e); this.report(this.peek(), msg); return { span: this.peek().span, kind: 'ErrorExpr' } as Expr; }
	}

	private parseAssign(stopOps?: Set<string>): Expr {
		const left = this.parseBinary(1, stopOps);
		if (this.peek().kind === 'op' && ['=', '+=', '-=', '*=', '/=', '%='].includes(this.peek().value)) {
			const op = this.next().value as import('./types').BinOp;
			const right = this.parseAssign(stopOps);
			return { span: spanFrom(left.span.start, right.span.end), kind: 'Binary', op, left, right };
		}
		return left;
	}

	private prec(op: string): number {
		switch (op) {
			// Logical OR/AND (same precedence in LSL, left-associative)
			case '||': return 1;
			case '&&': return 1;
			// Bitwise OR/XOR/AND
			case '|': return 2;
			case '^': return 3;
			case '&': return 4;
			// Equality
			case '==': case '!=': return 5;
			// Relational
			case '<': case '>': case '<=': case '>=': return 6;
			// Shifts
			case '<<': case '>>': return 7;
			// Additive
			case '+': case '-': return 8;
			// Multiplicative
			case '*': case '/': case '%': return 9;
			default: return 0;
		}
	}

	private parseBinary(minPrec: number, stopOps?: Set<string>): Expr {
		let left = this.parseUnary();
		for (;;) {
			const look = this.peek();
			if (look.kind !== 'op') break;
			// If a caller requested to stop at certain operators (e.g., vector literal closing '>'),
			// honor that here to avoid accidentally consuming the delimiter as a relational operator.
			if (stopOps && stopOps.has(look.value)) break;
			const prec = this.prec(look.value);
			if (prec === 0 || prec < minPrec) break;
			// consume operator
			const op = this.next().value as import('./types').BinOp;
			// Left-associative for all binary operators handled here
			const nextMinPrec = prec + 1;
			const right = this.parseBinary(nextMinPrec, stopOps);
			left = { span: spanFrom(left.span.start, right.span.end), kind: 'Binary', op, left, right };
		}
		return left;
	}

	private parseUnary(): Expr {
		const t = this.peek();
		if (t.kind === 'op' && ['!', '~', '++', '--', '+', '-'].includes(t.value)) {
			const op = this.next().value as import('./types').UnOp;
			const arg = this.parseUnary();
			return { span: spanFrom(t.span.start, arg.span.end), kind: 'Unary', op, argument: arg };
		}
		return this.parsePrimary();
	}

	private parsePrimary(): Expr {
		const t = this.next();
		if (t.kind === 'number') return this.parsePostfix({ span: t.span, kind: 'NumberLiteral', raw: t.value });
		if (t.kind === 'string') return this.parsePostfix({ span: t.span, kind: 'StringLiteral', value: this.unquote(t.value) });
		if (t.kind === 'punct' && t.value === '(') {
			// Special-case C-style cast syntax: (type)expr
			// Look ahead for a type keyword immediately followed by ')'
			const after = this.peek();
			if (after.kind === 'keyword' && isType(after.value)) {
				const after2 = this.lx.peek();
				if (after2.kind === 'punct' && after2.value === ')') {
					// Consume the type and closing ')', then parse the cast argument as a unary expression
					const tType = this.next();
					this.eat('punct', ')');
					const arg = this.parseUnary();
					return this.parsePostfix({ span: spanFrom(t.span.start, arg.span.end), kind: 'Cast', type: tType.value as Type, argument: arg } as Expr);
				}
			}
			const e = this.parseExpr(); const close = this.eat('punct', ')');
			// Unwrap redundant parentheses around complex expressions like Binary/Call/Member/etc
			// Keep Paren nodes around identifiers/literals to influence assignability checks.
			switch (e.kind) {
				case 'Binary':
				case 'Call':
				case 'Member':
				case 'ListLiteral':
				case 'VectorLiteral':
				case 'Cast': {
					const widened = { ...e, span: spanFrom(t.span.start, close.span.end) } as Expr;
					return this.parsePostfix(widened);
				}
				default:
					return this.parsePostfix({ span: spanFrom(t.span.start, close.span.end), kind: 'Paren', expression: e });
			}
		}
		if (t.kind === 'keyword' && isType(t.value) && this.maybe('punct', '(')) {
			const arg = this.parseExpr(); this.eat('punct', ')');
			return this.parsePostfix({ span: spanFrom(t.span.start, arg.span.end), kind: 'Cast', type: t.value as Type, argument: arg });
		}
		if (t.kind === 'punct' && t.value === '[') {
			// list literal [a, b, c]
			const elements: Expr[] = [];
			let guard = 0;
			while (!this.maybe('punct', ']')) {
				if (this.peek().kind === 'eof') { this.report(this.peek(), 'missing ] to close list literal', 'LSL000'); break; }
				if (++guard > 20000) { this.report(this.peek(), 'parser recovery limit in list literal', 'LSL000'); break; }
				const e = this.parseExpr(); elements.push(e); this.maybe('punct', ',');
			}
			return this.parsePostfix({ span: spanFrom(t.span.start, this.peek().span.end), kind: 'ListLiteral', elements });
		}
		if ((t.kind === 'punct' && t.value === '<') || (t.kind === 'op' && t.value === '<')) {
			// vector/rotation literal <x,y,z[,s]>
			// Parse components while stopping expression parsing at the closing '>' to avoid
			// misinterpreting it as a relational operator.
			const stopper = new Set<string>(['>']);
			const a = this.parseExpr(stopper); this.eat('punct', ',');
			const b = this.parseExpr(stopper); this.eat('punct', ',');
			const c = this.parseExpr(stopper);
			let d: Expr | null = null;
			if (this.maybe('punct', ',')) d = this.parseExpr(stopper);
			// accept either punct or op for '>' and capture it for span end
			const gt = this.maybe('punct', '>') || this.eat('op', '>');
			const elements = d ? [a, b, c, d] as [Expr, Expr, Expr, Expr] : [a, b, c] as [Expr, Expr, Expr];
			return this.parsePostfix({ span: spanFrom(t.span.start, gt.span.end), kind: 'VectorLiteral', elements });
		}
		if (t.kind === 'id' || (t.kind === 'keyword' && t.value === 'default')) {
			// identifier or default
			const expr: Expr = { span: t.span, kind: 'Identifier', name: t.value };
			return this.parsePostfix(expr);
		}
		throw this.err(t, `unexpected token ${t.kind} '${t.value}'`);
	}

	// Apply postfix operations (call, member access, postfix ++/--, and index error) to any base expression
	private parsePostfix(expr: Expr): Expr {
		for (; ;) {
			if (this.maybe('punct', '(')) {
				const args: Expr[] = [];
				let guard = 0;
				while (!this.maybe('punct', ')')) {
					// Prevent runaway EOF loops when ')' is missing
					if (this.peek().kind === 'eof') { this.report(this.peek(), 'missing ) to close call', 'LSL000'); break; }
					if (++guard > 20000) { this.report(this.peek(), 'parser recovery limit in call args', 'LSL000'); break; }
					const e = this.parseExpr(); args.push(e); this.maybe('punct', ',');
				}
				expr = { span: spanFrom(expr.span.start, this.peek().span.end), kind: 'Call', callee: expr, args };
				continue;
			}
			if (this.maybe('op', '.')) {
				const prop = this.eat('id').value;
				expr = { span: spanFrom(expr.span.start, this.peek().span.end), kind: 'Member', object: expr, property: prop };
				continue;
			}
			if (this.maybe('op', '++')) {
				expr = { span: spanFrom(expr.span.start, this.peek().span.end), kind: 'Unary', op: '++', argument: expr };
				continue;
			}
			if (this.maybe('op', '--')) {
				expr = { span: spanFrom(expr.span.start, this.peek().span.end), kind: 'Unary', op: '--', argument: expr };
				continue;
			}
			// unsupported indexing operator expr[...]
			if (this.maybe('punct', '[')) {
				while (!this.maybe('punct', ']') && this.peek().kind !== 'eof') { try { this.parseExpr(); } catch { this.next(); } this.maybe('punct', ','); }
				const fileForIdx = (expr as unknown as { file?: string }).file || this.peek().file || '<unknown>';
				this.report({ kind: 'punct', value: '[]', span: { start: expr.span.start, end: this.peek().span.end }, file: fileForIdx }, 'Indexing with [] is not supported', 'LSL000');
				expr = { ...expr, span: spanFrom(expr.span.start, this.peek().span.end) };
				continue;
			}
			break;
		}
		return expr;
	}

	private consumeLeadingComment(): string | undefined {
		if (!this.leadingComment) return undefined;
		const s = this.leadingComment.trim();
		this.leadingComment = '';
		return s.length ? s : undefined;
	}

	private unquote(str: string): string { if (str.length >= 2 && ((str[0] === '"' && str.at(-1) === '"') || (str[0] === '\'' && str.at(-1) === '\''))) return str.slice(1, -1); return str; }

	// True if position is at the start of a line (only spaces/tabs since previous newline)
	private atLineStart(pos: number): boolean {
		let i = pos - 1;
		while (i >= 0 && this.src[i] !== '\n') {
			if (this.src[i] !== ' ' && this.src[i] !== '\t') return false;
			i--;
		}
		return true;
	}
}

export type { Parser };
