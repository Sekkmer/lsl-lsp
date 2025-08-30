/*
	New AST parser for LSL that builds server/src/ast structures and resolves macros.
	It uses the preprocessor to get macro tables and disabled ranges, then tokenizes
	the active code, attaches leading comments as `comment` on decl nodes.
*/
import { TextDocument } from 'vscode-languageserver-textdocument';
import type { Expr, Stmt, Script, Function as FnNode, State, Event, Type, Span, Diagnostic } from './index';
import { isType, spanFrom } from './index';
import { Lexer, type Token, type MacroTables } from './lexer';
import { preprocess } from '../preproc';

type ParseOptions = {
	macros?: Record<string, any>;
	includePaths?: string[];
};

export function parseScriptFromText(text: string, uri = 'file:///memory.lsl', opts?: ParseOptions): Script {
	// Run preprocessor to collect macros and disabled ranges
	const doc = TextDocument.create(uri, 'lsl', 0, text);
	const pre = preprocess(doc, opts?.macros ?? {}, opts?.includePaths ?? [], {} as any);
	const macros: MacroTables = { obj: pre.macros, fn: pre.funcMacros };
	// Derive a basename for __FILE__
	const basename = (() => {
		try { const u = new URL(uri); return u.pathname.split('/').pop() || 'memory.lsl'; }
		catch { return uri.split('/').pop() || 'memory.lsl'; }
	})();
	const lx = new Lexer(text, { macros, disabled: pre.disabledRanges, filename: basename });
	const P = new Parser(lx, text);
	return P.parseScript();
}

class Parser {
	private readonly lx: Lexer;
	private readonly src: string;
	private look: Token | null = null;
	// comment buffer for leading doc comments
	private leadingComment = '';
	private diagnostics: Diagnostic[] = [];

	constructor(lx: Lexer, src: string) { this.lx = lx; this.src = src; }

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
						this.report(t as any, 'Unterminated block comment', 'LSL000');
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
		this.report(t, `expected ${value ? `'${value}'` : kind ?? 'token'}`);
		return { kind: (kind ?? t.kind) as any, value: (value ?? '') as any, span: { start: pos, end: pos } } as Token;
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
		return this.eat('id');
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

	parseScript(): Script {
		const start = this.peek().span.start;
		const functions = new Map<string, FnNode>();
		const states = new Map<string, State>();
		const globals = new Map<string, any>();
		while (this.peek().kind !== 'eof') {
			// skip any directives that may have been peeked
			if (this.peek().kind === 'directive') { this.look = null; this.lx.next(); continue; }
			// skip stray semicolons
			if (this.maybe('punct', ';')) continue;
			// Detect and report illegal global state-change statements: "state <id>;"
			if (this.peek().kind === 'keyword' && this.peek().value === 'state') {
				const tState = this.peek();
				const sc = this.looksLikeStateChangeAfter(tState.span.end);
				if (sc) {
					this.eat('keyword', 'state');
					if (this.peek().kind === 'keyword' && this.peek().value === 'default') { this.next(); }
					else { this.eat('id'); }
					this.maybe('punct', ';');
					this.report({ kind: 'id', value: '', span: { start: tState.span.start, end: sc.end } } as any, 'State change statements are only allowed inside event handlers', 'LSL023');
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
				let decl: any;
				try { decl = this.parseTopLevel(); }
				catch (e: any) { this.report(this.peek(), String(e.message || e)); this.syncTopLevel(); continue; }
				if ('varType' in decl) {
					// duplicate global variable
					if (globals.has(decl.name)) this.report({ kind: 'id', value: decl.name, span: decl.span } as any, 'Duplicate declaration', 'LSL070');
					globals.set(decl.name, decl);
				} else {
					// duplicate function
					if (functions.has(decl.name)) this.report({ kind: 'id', value: decl.name, span: decl.span } as any, 'Duplicate declaration', 'LSL070');
					functions.set(decl.name, decl);
				}
				continue;
			}
			// Implicit-void function: <id> '(' ... ')' '{' ... '}'
			if (nextTok.kind === 'id' && this.looksLikeImplicitFunctionDeclAfter(nextTok.span.end)) {
				const leading = this.consumeLeadingComment();
				const nameTok = this.eat('id');
				this.eat('punct', '(');
				const params = this.parseParamList();
				const body = this.parseBlock(/*inFunctionOrEvent*/ true);
				const span = spanFrom(nameTok.span.start, body.span.end);
				const node: FnNode = { span, kind: 'Function', name: nameTok.value, parameters: params, body, comment: leading, returnType: 'void' } as any;
				if (functions.has(node.name)) this.report({ kind: 'id', value: node.name, span } as any, 'Duplicate declaration', 'LSL070');
				functions.set(node.name, node);
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
		if (!(first.kind === 'keyword' && isType(first.value))) throw this.err(first, 'expected type');
		const varType = first.value as Type;
		const nameTok = this.eatNameToken();
		const name = nameTok.value;
		if (this.maybe('punct', '(')) {
			// function
			const params = this.parseParamList();
			const body = this.parseBlock(/*inFunctionOrEvent*/ true);
			const span = spanFrom(first.span.start, body.span.end);
			const node: FnNode = { span, kind: 'Function', name, parameters: params, body, comment: leading, returnType: varType } as any;
			return node;
		}
		// global var
		let initializer: Expr | undefined;
		if (this.maybe('op', '=')) { initializer = this.parseExpr(); }
		this.eat('punct', ';');
		const gv = { span: spanFrom(first.span.start, nameTok.span.end), kind: 'GlobalVar', varType, name, initializer, comment: leading } as const;
		return gv;
	}

	private parseParamList(): Map<string, Type> {
		// we are after '('
		const params = new Map<string, Type>();
		while (!this.maybe('punct', ')')) {
			const tType = this.next();
			if (!(tType.kind === 'keyword' && isType(tType.value))) throw this.err(tType, 'expected param type');
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
			const t = this.peek();
			if (t.kind === 'id') {
				const evNameTok = this.next();
				if (this.maybe('punct', '(')) {
					const params = this.parseParamList();
					const body = this.parseBlock(/*inFunctionOrEvent*/ true);
					const ev: Event = { span: spanFrom(evNameTok.span.start, body.span.end), kind: 'Event', name: evNameTok.value, parameters: params, body };
					events.push(ev);
					continue;
				} else {
					try { this.parseStmt(false); } catch { /* ignore; reported */ }
					continue;
				}
			}
			try { this.parseStmt(false); } catch { /* ignore; reported */ }
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
				const isStateDecl = look.value === 'state' && this.looksLikeStateDeclAfter(look.span.end);
				const isDefaultStateDecl = look.value === 'default' && this.looksLikeDefaultStateDeclAfter(look.span.end);
				const isFuncDecl = isType(look.value) && this.looksLikeFunctionDeclAfter(look.span.end);
				if (isStateDecl || isDefaultStateDecl) {
					if (inFunctionOrEvent) {
						if (this.atLineStart(look.span.start)) { this.report(look, 'missing } before next declaration', 'LSL000'); break; }
						if (isStateDecl) {
							const kw = this.eat('keyword', 'state');
							if (this.peek().kind === 'keyword' && this.peek().value === 'default') this.next(); else this.eat('id');
							const body = this.parseBlock(true);
							this.report({ kind: 'id', value: '', span: { start: kw.span.start, end: body.span.end } } as any, 'State declarations are only allowed at global scope', 'LSL022');
							statements.push({ span: spanFrom(kw.span.start, body.span.end), kind: 'ErrorStmt' } as Stmt);
							continue;
						} else if (isDefaultStateDecl) {
							const def = this.eat('keyword', 'default');
							const body = this.parseBlock(true);
							this.report({ kind: 'id', value: '', span: { start: def.span.start, end: body.span.end } } as any, 'State declarations are only allowed at global scope', 'LSL022');
							statements.push({ span: spanFrom(def.span.start, body.span.end), kind: 'ErrorStmt' } as Stmt);
							continue;
						}
					}
					this.report(look, 'missing } before next declaration', 'LSL000');
					break;
				}
				if (isFuncDecl) { this.report(look, 'missing } before next declaration', 'LSL000'); break; }
			}
			// tolerate EOF to avoid crashes
			if (this.peek().kind === 'eof') { this.report(this.peek(), 'missing } before end of file', 'LSL000'); break; }
			try { statements.push(this.parseStmt(inFunctionOrEvent)); }
			catch (e: any) { this.report(this.peek(), String(e.message || e), 'LSL000'); this.syncTo([';', '}']); if (this.maybe('punct', ';')) continue; if (this.maybe('punct', '}')) { rbraceEnd = this.peek().span.end; break; } continue; }
		}
		const end = rbraceEnd ?? this.peek().span.end;
		return { span: spanFrom(lbrace.span.start, end), kind: 'BlockStmt', statements };
	}

	// Heuristic: after a type keyword at pos, do we have an identifier followed by '(' (function decl)?
	private looksLikeFunctionDeclAfter(pos: number): boolean {
		let i = pos;
		// skip whitespace and comments
		while (i < this.src.length) {
			const ch = this.src[i]!;
			if (ch === ' ' || ch === '\t' || ch === '\r' || ch === '\n') { i++; continue; }
			if (ch === '/' && this.src[i + 1] === '/') { // line comment
				i += 2; while (i < this.src.length && this.src[i] !== '\n') i++; continue;
			}
			if (ch === '/' && this.src[i + 1] === '*') { // block comment
				i += 2; while (i < this.src.length && !(this.src[i] === '*' && this.src[i + 1] === '/')) i++; if (i < this.src.length) i += 2; continue;
			}
			break;
		}
		// identifier
		const startId = i;
		if (i < this.src.length && /[A-Za-z_]/.test(this.src[i]!)) {
			i++;
			while (i < this.src.length && /[A-Za-z0-9_]/.test(this.src[i]!)) i++;
		} else {
			return false;
		}
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
		// identifier or 'default'
		if (i < this.src.length && /[A-Za-z_]/.test(this.src[i]!)) {
			// read word
			let j = i + 1; while (j < this.src.length && /[A-Za-z0-9_]/.test(this.src[j]!)) j++;
			i = j;
		} else if (this.src.slice(i, i + 7) === 'default') {
			i += 7;
		} else {
			return false;
		}
		skipTrivia();
		return this.src[i] === '{';
	}

	private looksLikeDefaultStateDeclAfter(pos: number): boolean {
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
						this.report({ kind: 'id', value: '', span: { start: kw.span.start, end: body.span.end } } as any, 'State declarations are only allowed at global scope', 'LSL022');
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
						this.report({ kind: 'id', value: '', span: { start: def.span.start, end: body.span.end } } as any, 'State declarations are only allowed at global scope', 'LSL022');
						return { span: spanFrom(def.span.start, body.span.end), kind: 'ErrorStmt' } as Stmt;
					}
					break;
				}
			}
			// var decl inside block
			if (isType(t.value)) return this.parseVarDecl();
		}
		// label using '@Name;' form
		if (t.kind === 'punct' && t.value === '@') {
			const at = this.next();
			const nameTok = this.eat('id');
			const endTok = this.maybe('punct', ';') || this.maybe('punct', ':') || nameTok;
			return { span: spanFrom(at.span.start, endTok.span.end), kind: 'LabelStmt', name: nameTok.value } as Stmt;
		}
		// legacy label: Name:
		if (t.kind === 'id' || (t.kind === 'keyword' && t.value === 'default')) {
			// label: <id>:
			const t2 = this.lx.peek();
			if (t2.kind === 'punct' && t2.value === ':') {
				const name = this.next().value; this.eat('punct', ':');
				return { span: spanFrom(t.span.start, t2.span.end), kind: 'LabelStmt', name };
			}
		}
		// jump statement
		if (t.kind === 'keyword' && t.value === 'jump') {
			const kw = this.eat('keyword', 'jump');
			const target = this.eat('id');
			const semi = this.maybe('punct', ';');
			const end = semi ? semi.span.end : target.span.end;
			return { span: spanFrom(kw.span.start, end), kind: 'JumpStmt', target: { span: target.span, kind: 'Identifier', name: target.value } as Expr } as Stmt;
		}
		// expr;
		try {
			const expr = this.parseExpr();
			// Expect semicolon; if missing, point error at current cursor and recover
			const semi = this.maybe('punct', ';');
			if (!semi) {
				this.report(this.peek(), 'missing ; after statement', 'LSL000');
				// fabricate insertion: do not consume; let sync handle downstream
			}
			const end = semi ? semi.span.end : this.peek().span.end;
			return { span: spanFrom(expr.span.start, end), kind: 'ExprStmt', expression: expr };
		} catch (e: any) {
			this.report(this.peek(), String(e.message || e), 'LSL000');
			this.syncTo([';', '}']);
			this.maybe('punct', ';');
			return { span: t.span, kind: 'ErrorStmt' } as Stmt;
		}
	}

	private parseVarDecl(): Stmt {
		const tType = this.eat('keyword');
		if (!isType(tType.value)) throw this.err(tType, 'expected type');
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
		const init = this.parseExpr(); this.eat('punct', ';');
		const cond = this.parseExpr(); this.eat('punct', ';');
		const update = this.parseExpr(); this.eat('punct', ')');
		const body = this.parseStmtInner(inFunctionOrEvent);
		return { span: spanFrom(kw.span.start, body.span.end), kind: 'ForStmt', init, condition: cond, update, body };
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
			// Tailored message for semicolon test and better recovery
			this.report(this.peek(), 'Missing semicolon after return', 'LSL000');
			return { span: spanFrom(kw.span.start, expr.span.end), kind: 'ReturnStmt', expression: expr };
		}
		return { span: spanFrom(kw.span.start, semi.span.end), kind: 'ReturnStmt', expression: expr };
	}

	private parseExpr(stopOps?: Set<string>): Expr {
		try { return this.parseAssign(stopOps); }
		catch (e: any) { this.report(this.peek(), String(e.message || e)); return { span: this.peek().span, kind: 'ErrorExpr' } as Expr; }
	}

	private parseAssign(stopOps?: Set<string>): Expr {
		const left = this.parseBinary(1, stopOps);
		if (this.peek().kind === 'op' && ['=', '+=', '-=', '*=', '/=', '%='].includes(this.peek().value)) {
			const op = this.next().value as any;
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
			const op = this.next().value as any;
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
			const op = this.next().value as any;
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
					(e as any).span = spanFrom(t.span.start, close.span.end);
					return this.parsePostfix(e);
				}
				default:
					return this.parsePostfix({ span: spanFrom(t.span.start, close.span.end), kind: 'Paren', expression: e } as Expr);
			}
		}
		if (t.kind === 'keyword' && isType(t.value) && this.maybe('punct', '(')) {
			const arg = this.parseExpr(); this.eat('punct', ')');
			return this.parsePostfix({ span: spanFrom(t.span.start, arg.span.end), kind: 'Cast', type: t.value as Type, argument: arg });
		}
		if (t.kind === 'punct' && t.value === '[') {
			// list literal [a, b, c]
			const elements: Expr[] = [];
			while (!this.maybe('punct', ']')) { const e = this.parseExpr(); elements.push(e); this.maybe('punct', ','); }
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
				while (!this.maybe('punct', ')')) { const e = this.parseExpr(); args.push(e); this.maybe('punct', ','); }
				expr = { span: spanFrom(expr.span.start, this.peek().span.end), kind: 'Call', callee: expr, args } as any;
				continue;
			}
			if (this.maybe('op', '.')) {
				const prop = this.eat('id').value;
				expr = { span: spanFrom(expr.span.start, this.peek().span.end), kind: 'Member', object: expr, property: prop } as any;
				continue;
			}
			if (this.maybe('op', '++')) {
				expr = { span: spanFrom(expr.span.start, this.peek().span.end), kind: 'Unary', op: '++', argument: expr } as any;
				continue;
			}
			if (this.maybe('op', '--')) {
				expr = { span: spanFrom(expr.span.start, this.peek().span.end), kind: 'Unary', op: '--', argument: expr } as any;
				continue;
			}
			// unsupported indexing operator expr[...]
			if (this.maybe('punct', '[')) {
				while (!this.maybe('punct', ']') && this.peek().kind !== 'eof') { try { this.parseExpr(); } catch { this.next(); } this.maybe('punct', ','); }
				this.report({ kind: 'punct', value: '[]', span: { start: expr.span.start, end: this.peek().span.end } } as any, 'Indexing with [] is not supported', 'LSL000');
				expr = { ...expr, span: spanFrom(expr.span.start, this.peek().span.end) } as any;
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
