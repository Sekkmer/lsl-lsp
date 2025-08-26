import { TextDocument } from 'vscode-languageserver-textdocument';
import { DiagnosticSeverity, Range } from 'vscode-languageserver/node';
import { Token } from './lexer';
import { Defs, DefFunction, normalizeType } from './defs';
import { PreprocResult } from './preproc';

export const LSL_DIAGCODES = {
	SYNTAX: 'LSL000',
	UNKNOWN_IDENTIFIER: 'LSL001',
	UNKNOWN_CONST: 'LSL002',
	INVALID_ASSIGN_LHS: 'LSL050',
	WRONG_ARITY: 'LSL010',
	WRONG_TYPE: 'LSL011',
	EVENT_OUTSIDE_STATE: 'LSL020',
	UNKNOWN_EVENT: 'LSL021',
	UNKNOWN_STATE: 'LSL030',
	MISSING_RETURN: 'LSL040',
	RETURN_IN_VOID: 'LSL041',
	RETURN_WRONG_TYPE: 'LSL042',
	DEAD_CODE: 'LSL052',
	UNUSED_VAR: 'LSL100',
	UNUSED_LOCAL: 'LSL101',
	UNUSED_PARAM: 'LSL102',
	UNDERSCORE_PARAM_USED: 'LSL103',
	SUSPICIOUS_ASSIGNMENT: 'LSL051',
	RESERVED_IDENTIFIER: 'LSL060',
	DUPLICATE_DECL: 'LSL070',
} as const;
export type DiagCode = typeof LSL_DIAGCODES[keyof typeof LSL_DIAGCODES];

export interface Diag { range: Range; message: string; severity?: DiagnosticSeverity; code: DiagCode; }
export interface SymbolRef { name: string; range: Range; }
export interface Decl { name: string; range: Range; kind: 'var' | 'func' | 'state' | 'event' | 'param'; type?: string; params?: { name: string; type?: string }[]; }
export interface Scope { parent?: Scope; vars: Map<string, Decl>; }
export interface Analysis {
	diagnostics: Diag[];
	decls: Decl[];
	refs: SymbolRef[];
	calls: { name: string; args: number; range: Range; argRanges: Range[] }[];
	states: Map<string, Decl>;
	functions: Map<string, Decl>;
	symbolAt(offset: number): Decl | null;
	refAt(offset: number): Decl | null;
}

function mkRange(doc: TextDocument, start: number, end: number): Range {
	return { start: doc.positionAt(start), end: doc.positionAt(end) };
}

export function parseAndAnalyze(doc: TextDocument, tokens: Token[], defs: Defs, pre: PreprocResult): Analysis {
	const diagnostics: Diag[] = [];
	const decls: Decl[] = [];
	const refs: SymbolRef[] = [];
	// Map identifier usage start offset -> resolved declaration for scope-aware consumers
	const refTargets = new Map<number, Decl>();
	const calls: { name: string; args: number; range: Range; argRanges: Range[] }[] = [];
	const states = new Map<string, Decl>();
	const functions = new Map<string, Decl>();

	const globalScope: Scope = { vars: new Map() };
	let scope: Scope = globalScope;

	// Track current block depth within a function/event body for shadowing checks
	// Track simple block depth only for ancillary heuristics; scopes are managed via pushScope/popScope on '{' '}'
	let currentBlockDepth = -1; // -1 outside any function/event body, 0 at top of body, >0 for nested blocks

	// Very light state machine
	let i = 0;
	let inState: string | null = null;
	let currentStateEvents: Set<string> | null = null;
	let stmtStartIndex = 0; // index of the first token of the current statement

	function peek(k = 0): Token | undefined { return tokens[i + k]; }
	function eat(): Token | undefined { return tokens[i++]; }
	function isType(tok?: Token) { return tok && tok.kind === 'id' && defs.types.has(tok.value); }
	function isId(tok?: Token) { return tok && tok.kind === 'id'; }
	function isKeyword(name: string) { return defs.keywords.has(name); }
	function isKnownNonVar(name: string) {
		// Known non-variable symbols: constants, keywords, types, macros, or globals/functions from includes.
		if (defs.consts.has(name) || defs.keywords.has(name) || defs.types.has(name) || Object.prototype.hasOwnProperty.call(pre.macros, name)) return true;
		// Check include-derived symbols
		if (pre.includeSymbols && pre.includeSymbols.size > 0) {
			for (const info of pre.includeSymbols.values()) {
				if (info.functions.has(name) || info.globals.has(name)) return true;
			}
		}
		return false;
	}

	function isReservedName(name: string): boolean {
		// LSL reserved identifiers that cannot be used as variable/function/parameter names
		// - language keywords (if, else, state, default, return, etc.)
		// - primitive types (integer, float, string, key, vector, rotation, list, void)
		// - explicit extras like 'event'
		if (name === 'event') return true;
		if (defs.keywords.has(name)) return true;
		if (defs.types.has(name)) return true;
		return false;
	}
	// (removed) skipToNextStatement – previous generic skipper no longer needed; we handle cases inline

	// Analyze identifiers and vector/rotation member access within [startIdx, endIdx)
	function analyzeIdUsesInRange(startIdx: number, endIdx: number, usedLocalOrParamNames?: Set<string>) {
		for (let k = startIdx; k < endIdx; k++) {
			const b = tokens[k];
			if (!b) continue;
			// Ignore function calls; they'll be collected elsewhere by the main scanner when appropriate
			if (b.kind === 'id' && tokens[k + 1]?.value !== '(') {
				// Member identifiers following a dot: validate against base type when possible
				const prevTok = tokens[k - 1];
				if (prevTok && prevTok.value === '.') {
					const baseTok = tokens[k - 2];
					const mem = b.value;
					if (baseTok && baseTok.kind === 'id') {
						const baseDecl = lookup(baseTok.value);
						if (baseDecl && (baseDecl.type === 'vector' || baseDecl.type === 'rotation')) {
							const ok = baseDecl.type === 'vector'
								? (mem === 'x' || mem === 'y' || mem === 'z')
								: (mem === 'x' || mem === 'y' || mem === 'z' || mem === 's');
							if (!ok) {
								diagnostics.push({
									code: LSL_DIAGCODES.UNKNOWN_IDENTIFIER,
									message: `Unknown member ".${mem}" for ${baseDecl.type}`,
									range: mkRange(doc, b.start, b.end),
									severity: DiagnosticSeverity.Warning
								});
							}
							continue; // handled member token
						}
					}
					// Unknown base or non-vector/rotation base: treat as generic unknown identifier if not known non-var
					if (!isKnownNonVar(b.value)) {
						const found = lookup(b.value);
						if (found) {
							refs.push({ name: b.value, range: mkRange(doc, b.start, b.end) });
							refTargets.set(b.start, found);
							if (usedLocalOrParamNames && (found.kind === 'param' || found.kind === 'var')) usedLocalOrParamNames.add(found.name);
						} else {
							diagnostics.push({ code: LSL_DIAGCODES.UNKNOWN_IDENTIFIER, message: `Unknown identifier "${b.value}"`, range: mkRange(doc, b.start, b.end), severity: DiagnosticSeverity.Warning });
						}
					}
					continue;
				}
				const found = lookup(b.value);
				if (found) {
					refs.push({ name: b.value, range: mkRange(doc, b.start, b.end) });
					refTargets.set(b.start, found);
					if (usedLocalOrParamNames && (found.kind === 'param' || found.kind === 'var')) usedLocalOrParamNames.add(found.name);
				} else if (!isKnownNonVar(b.value)) {
					diagnostics.push({ code: LSL_DIAGCODES.UNKNOWN_IDENTIFIER, message: `Unknown identifier "${b.value}"`, range: mkRange(doc, b.start, b.end), severity: DiagnosticSeverity.Warning });
				}
			}
		}
	}

	function declareVar(typeTok: Token, nameTok: Token) {
		// Forbid reserved identifiers
		if (isReservedName(nameTok.value)) {
			diagnostics.push({
				code: LSL_DIAGCODES.RESERVED_IDENTIFIER,
				message: `"${nameTok.value}" is reserved and cannot be used as an identifier`,
				range: mkRange(doc, nameTok.start, nameTok.end),
				severity: DiagnosticSeverity.Error
			});
		}
		// Duplicate detection strictly within the same lexical scope
		if (scope.vars.has(nameTok.value)) {
			diagnostics.push({
				code: LSL_DIAGCODES.DUPLICATE_DECL,
				message: `"${nameTok.value}" is already declared in this scope`,
				range: mkRange(doc, nameTok.start, nameTok.end),
				severity: DiagnosticSeverity.Error
			});
		}
		const d: Decl = { name: nameTok.value, range: mkRange(doc, nameTok.start, nameTok.end), kind: 'var', type: normalizeType(typeTok.value) };
		scope.vars.set(d.name, d); decls.push(d);
		return d;
	}

	function pushScope() { scope = { parent: scope, vars: new Map() }; }
	function popScope() { if (scope.parent) scope = scope.parent; }

	function lookup(name: string): Decl | undefined {
		let s: Scope | undefined = scope;
		while (s) {
			const v = s.vars.get(name);
			if (v) return v;
			s = s.parent;
		}
		return undefined;
	}

	while (i < tokens.length) {
		const t = peek(); if (!t) break;

		// State declaration: state foo { ... } or default { ... }
		if (t.kind === 'id' && t.value === 'state') {
			const kw = eat()!;
			const nameTok = peek();
			if (isId(nameTok)) {
				eat();
				const brace = peek();
				if (brace?.value === '{') {
					eat();
					const d: Decl = { name: nameTok!.value, range: mkRange(doc, nameTok!.start, nameTok!.end), kind: 'state' };
					states.set(d.name, d); decls.push(d);
					inState = d.name;
					currentStateEvents = new Set<string>();
					pushScope();
				} else {
					diagnostics.push({ code: LSL_DIAGCODES.SYNTAX, message: 'Expected "{" after state name', range: mkRange(doc, nameTok!.end, nameTok!.end), severity: DiagnosticSeverity.Error });
				}
			} else {
				diagnostics.push({ code: LSL_DIAGCODES.SYNTAX, message: 'Expected state name', range: mkRange(doc, kw.end, kw.end), severity: DiagnosticSeverity.Error });
			}
			continue;
		}
		// default { ... } shorthand
		if (t.kind === 'id' && t.value === 'default' && peek(1)?.value === '{') {
			eat(); // default
			eat(); // {
			const d: Decl = { name: 'default', range: mkRange(doc, t.start, t.end), kind: 'state' };
			states.set(d.name, d); decls.push(d);
			inState = d.name;
			currentStateEvents = new Set<string>();
			pushScope();
			continue;
		}
		if (t.value === '}' && inState) {
			eat(); popScope(); inState = null; currentStateEvents = null; continue;
		}

		// Function declaration: <type> <name> ( ... ) { ... }
		if (isType(t) && isId(peek(1)) && peek(2)?.value === '(') {
			const ret = eat()!; const nameTok = eat()!; eat(); // (
			if (isReservedName(nameTok.value)) {
				diagnostics.push({
					code: LSL_DIAGCODES.RESERVED_IDENTIFIER,
					message: `"${nameTok.value}" is reserved and cannot be used as an identifier`,
					range: mkRange(doc, nameTok.start, nameTok.end),
					severity: DiagnosticSeverity.Error
				});
			}
			const fnDecl: Decl = { name: nameTok.value, range: mkRange(doc, nameTok.start, nameTok.end), kind: 'func', type: normalizeType(ret.value), params: [] };
			if (functions.has(fnDecl.name)) {
				diagnostics.push({
					code: LSL_DIAGCODES.DUPLICATE_DECL,
					message: `Function "${fnDecl.name}" is already declared`,
					range: fnDecl.range,
					severity: DiagnosticSeverity.Error
				});
			}
			functions.set(fnDecl.name, fnDecl); decls.push(fnDecl);

			// params
			pushScope();
			const paramDecls: Decl[] = [];
			while (i < tokens.length && peek()!.value !== ')') {
				const tt = peek(); if (!tt) break;
				if (isType(tt) && isId(peek(1))) {
					const pType = eat()!; const pName = eat()!;
					if (isReservedName(pName.value)) {
						diagnostics.push({
							code: LSL_DIAGCODES.RESERVED_IDENTIFIER,
							message: `"${pName.value}" is reserved and cannot be used as an identifier`,
							range: mkRange(doc, pName.start, pName.end),
							severity: DiagnosticSeverity.Error
						});
					}
					const p: Decl = { name: pName.value, range: mkRange(doc, pName.start, pName.end), kind: 'param', type: normalizeType(pType.value) } as Decl & { blockDepth?: number };
					// Duplicate parameter name check within the function scope
					if (scope.vars.has(p.name)) {
						diagnostics.push({
							code: LSL_DIAGCODES.DUPLICATE_DECL,
							message: `Parameter "${p.name}" is already declared`,
							range: p.range,
							severity: DiagnosticSeverity.Error
						});
					}
					(p as any).blockDepth = -1; // parameters live at function-level before any block
					scope.vars.set(p.name, p); decls.push(p);
					paramDecls.push(p);
					// also record on function decl
					fnDecl.params!.push({ name: p.name, type: p.type });
					if (peek()?.value === ',') eat();
				} else {
					diagnostics.push({ code: LSL_DIAGCODES.SYNTAX, message: 'Bad parameter list', range: mkRange(doc, tt!.start, tt!.end), severity: DiagnosticSeverity.Error });
					break;
				}
			}
			if (peek()?.value === ')') eat();
			if (peek()?.value === '{') {
				const bodyOpenIndex = i; // current token is '{'
				eat();
				currentBlockDepth = 0; // enter function body
				// Create scopes for params+locals already active; nested blocks will push further scopes
				// Walk body with brace depth tracking and record returns
				let depth = 1;
				let _sawReturn = false; // kept for potential future use
				let lastTokenBeforeClose: Token | null = null;
				const localDecls: Decl[] = [];
				const usedLocalOrParamNames = new Set<string>();
				while (i < tokens.length && depth > 0) {
					const b = peek()!;
					if (b.value === '{') { eat(); depth++; currentBlockDepth++; pushScope(); continue; }
					if (b.value === '}') { lastTokenBeforeClose = b; eat(); if (depth > 1) { currentBlockDepth = Math.max(0, currentBlockDepth - 1); popScope(); } depth--; continue; }
					// for-loop header: disallow declarations in initializer (LSL does not allow them)
					if (b.kind === 'id' && b.value === 'for' && peek(1)?.value === '(') {
						// consume 'for' and '('
						eat(); eat();
						const headerStart = i;
						let pd = 1; // paren depth
						let j = i; // scan from current i
						let sawInit = false;
						while (j < tokens.length && pd > 0) {
							const tk = tokens[j];
							if (tk.value === '(') { pd++; j++; continue; }
							if (tk.value === ')') { pd--; j++; continue; }
							if (pd === 1 && !sawInit) {
								// Check first clause until the first ';'
								if (tk.value === ';') { sawInit = true; j++; continue; }
								if (isType(tk) && tokens[j + 1]?.kind === 'id') {
									const nameTok = tokens[j + 1]!;
									diagnostics.push({
										code: LSL_DIAGCODES.SYNTAX,
										message: 'Variable declarations are not allowed in for-loop initializer; declare the variable before the loop',
										range: mkRange(doc, nameTok.start, nameTok.end),
										severity: DiagnosticSeverity.Error
									});
									// advance past the type and name
									j += 2; continue;
								}
							}
							j++;
						}
						// Record identifier uses within for-header to avoid false "unused" and track refs
						analyzeIdUsesInRange(headerStart, j, usedLocalOrParamNames);
						// position main scanner after the for-header ')'
						i = j; continue;
					}
					// return statements
					if (b.kind === 'id' && b.value === 'return') {
						const rTok = eat()!; // 'return'
						// capture until ';' or a closing brace '}' (to catch missing semicolon before block end)
						let startOff: number | null = null;
						let endOff: number | null = null;
						let k = i;
						let foundSemi = false;
						let sawCloseBrace = false;
						while (k < tokens.length) {
							const tk = tokens[k++];
							if (tk.value === ';') { foundSemi = true; break; }
							if (tk.value === '}') { sawCloseBrace = true; k--; break; }
							if (startOff === null) startOff = tk.start;
							endOff = tk.end;
						}
						// advance parser appropriately
						if (foundSemi) {
							i = k; // positioned after ';'
							// DEAD CODE: any tokens on same line after this semicolon are unreachable
							const semiTok = tokens[k - 1]!;
							const textAll = doc.getText();
							const lineEndIdx = (() => { const nl = textAll.indexOf('\n', semiTok.end); return nl === -1 ? textAll.length : nl; })();
							const nextTok = tokens[i];
							if (nextTok && nextTok.start < lineEndIdx) {
								diagnostics.push({
									code: LSL_DIAGCODES.DEAD_CODE,
									message: 'Unreachable code after terminating statement',
									range: { start: doc.positionAt(nextTok.start), end: doc.positionAt(lineEndIdx) },
									severity: DiagnosticSeverity.Warning
								});
							}
						} else if (sawCloseBrace) {
							// leave the '}' to be processed by the loop
							i = k; // k currently points at the '}' (since we decremented)
						} else {
							// EOF – recover at end
							i = k;
						}
						_sawReturn = true;
						if (!foundSemi) {
							// Missing semicolon after return statement
							const at = (endOff ?? rTok.end);
							diagnostics.push({
								code: LSL_DIAGCODES.SYNTAX,
								message: 'Missing semicolon after return statement',
								range: mkRange(doc, at, at),
								severity: DiagnosticSeverity.Error
							});
							// Do not attempt further type checks on this malformed return
							continue;
						}
						if (startOff === null || endOff === null) {
							// 'return;' with no expression
							// For non-void functions, this is missing return value
							if (fnDecl.type && fnDecl.type !== 'void') {
								diagnostics.push({
									code: LSL_DIAGCODES.MISSING_RETURN,
									message: `Function "${fnDecl.name}" must return ${fnDecl.type}`,
									range: mkRange(doc, rTok.start, rTok.end),
									severity: DiagnosticSeverity.Error
								});
							}
						} else {
							// record identifier uses within return expression and flag unknowns
							for (let m = 0; m < tokens.length; m++) {
								const tk = tokens[m];
								if (tk.start >= startOff && tk.end <= endOff && tk.kind === 'id') {
									// skip function calls
									const next = tokens[m + 1];
									if (next?.value === '(') continue;
									const found = lookup(tk.value);
									if (found) {
										refs.push({ name: tk.value, range: mkRange(doc, tk.start, tk.end) });
										if (found.kind === 'param' || found.kind === 'var') usedLocalOrParamNames.add(found.name);
									} else if (!isKnownNonVar(tk.value)) {
										diagnostics.push({
											code: LSL_DIAGCODES.UNKNOWN_IDENTIFIER,
											message: `Unknown identifier "${tk.value}"`,
											range: mkRange(doc, tk.start, tk.end),
											severity: DiagnosticSeverity.Warning
										});
									}
								}
							}
							// 'return <expr> ;'
							if (!fnDecl.type || fnDecl.type === 'void') {
								// returning a value in void function is a warning
								diagnostics.push({
									code: LSL_DIAGCODES.RETURN_IN_VOID,
									message: `Function "${fnDecl.name}" is void and should not return a value`,
									range: mkRange(doc, startOff, endOff),
									severity: DiagnosticSeverity.Warning
								});
							} else {
								const rType = inferExprType(doc, tokens, mkRange(doc, startOff, endOff));
								if (!typeMatches(fnDecl.type, rType)) {
									diagnostics.push({
										code: LSL_DIAGCODES.RETURN_WRONG_TYPE,
										message: `Function "${fnDecl.name}" returns ${fnDecl.type}, got ${rType}`,
										range: mkRange(doc, startOff, endOff),
										severity: DiagnosticSeverity.Error
									});
								}
							}
							// state transition statements inside state bodies: `state <id>;` -> dead code if more on same line
							const bb = peek()!;
							if (bb.kind === 'id' && bb.value === 'state' && isId(peek(1)) && peek(2)?.value === ';') {
								const _sTok = eat()!; const _nameTok2 = eat()!; const semi = eat()!; // consume
								const textAll = doc.getText();
								const lineEndIdx = (() => { const nl = textAll.indexOf('\n', semi.end); return nl === -1 ? textAll.length : nl; })();
								const nextTok = peek();
								if (nextTok && nextTok.start < lineEndIdx) {
									diagnostics.push({ code: LSL_DIAGCODES.DEAD_CODE, message: 'Unreachable code after terminating statement', range: { start: doc.positionAt(nextTok.start), end: doc.positionAt(lineEndIdx) }, severity: DiagnosticSeverity.Warning });
								}
								continue;
							}
							// jump statements: `jump <label>;` -> dead code if more on same line
							const bb2 = peek()!;
							if (bb2.kind === 'id' && bb2.value === 'jump' && isId(peek(1)) && peek(2)?.value === ';') {
								const _jTok = eat()!; const _lbl = eat()!; const semi = eat()!;
								const textAll = doc.getText();
								const lineEndIdx = (() => { const nl = textAll.indexOf('\n', semi.end); return nl === -1 ? textAll.length : nl; })();
								const nextTok = peek();
								if (nextTok && nextTok.start < lineEndIdx) {
									diagnostics.push({ code: LSL_DIAGCODES.DEAD_CODE, message: 'Unreachable code after terminating statement', range: { start: doc.positionAt(nextTok.start), end: doc.positionAt(lineEndIdx) }, severity: DiagnosticSeverity.Warning });
								}
								continue;
							}
						}
						continue;
					}
					// state change statements: state <id> ;
					if (b.kind === 'id' && b.value === 'state' && isId(peek(1)) && peek(2)?.value === ';') {
						eat(); const sName = eat()!; // 'state' and name
						refs.push({ name: sName.value, range: mkRange(doc, sName.start, sName.end) });
						if (sName.value !== 'default' && !states.has(sName.value)) {
							diagnostics.push({ code: LSL_DIAGCODES.UNKNOWN_STATE, message: `Unknown state "${sName.value}"`, range: mkRange(doc, sName.start, sName.end), severity: DiagnosticSeverity.Error });
						}
						if (peek()?.value === ';') eat();
						continue;
					}
					// find locals: <type> <id> ; or =
					if (isType(b) && isId(peek(1)) && [';', '='].includes(peek(2)?.value || '')) {
						const vt = eat()!; const vn = eat()!;
						const d = declareVar(vt, vn);
						localDecls.push(d);
						// skip initializer until end of statement if present
					}
					// calls: id '(' — exclude keywords and type-casts like integer(...)
					if (isId(b) && peek(1)?.value === '(' && !isKeyword(b.value) && !defs.types.has(b.value)) {
						// Treat function call identifier as a reference (for goto-definition)
						refs.push({ name: b.value, range: mkRange(doc, b.start, b.end) });
						collectCall(doc, tokens, i, defs, diagnostics, calls);
					}
					// identifier uses (e.g., reading globals)
					if (isId(b) && peek(1)?.value !== '(') {
						// Member identifiers following a dot: validate against base type
						const prevTok = tokens[i - 1];
						if (prevTok && prevTok.value === '.') {
							const baseTok = tokens[i - 2];
							const mem = b.value;
							// If we can resolve the base identifier, validate members for vector/rotation
							if (baseTok && baseTok.kind === 'id') {
								const baseDecl = lookup(baseTok.value);
								if (baseDecl && (baseDecl.type === 'vector' || baseDecl.type === 'rotation')) {
									const ok = baseDecl.type === 'vector'
										? (mem === 'x' || mem === 'y' || mem === 'z')
										: (mem === 'x' || mem === 'y' || mem === 'z' || mem === 's');
									if (!ok) {
										diagnostics.push({
											code: LSL_DIAGCODES.UNKNOWN_IDENTIFIER,
											message: `Unknown member ".${mem}" for ${baseDecl.type}`,
											range: mkRange(doc, b.start, b.end),
											severity: DiagnosticSeverity.Warning
										});
									}
									// consume member token and continue
									i++; continue;
								}
							}
							// Unknown base or non-vector/rotation: treat member as unknown identifier
							diagnostics.push({
								code: LSL_DIAGCODES.UNKNOWN_IDENTIFIER,
								message: `Unknown identifier "${b.value}"`,
								range: mkRange(doc, b.start, b.end),
								severity: DiagnosticSeverity.Warning
							});
							i++; continue;
						}
						const found = lookup(b.value);
						if (found) {
							refs.push({ name: b.value, range: mkRange(doc, b.start, b.end) });
							refTargets.set(b.start, found);
							if (found.kind === 'param' || found.kind === 'var') {
								usedLocalOrParamNames.add(found.name);
							}
						} else if (!isKnownNonVar(b.value)) {
							diagnostics.push({
								code: LSL_DIAGCODES.UNKNOWN_IDENTIFIER,
								message: `Unknown identifier "${b.value}"`,
								range: mkRange(doc, b.start, b.end),
								severity: DiagnosticSeverity.Warning
							});
						}
					}
					i++;
				}
				// Unused locals/params and underscore param usage
				for (const pd of paramDecls) {
					const isUnderscore = pd.name.startsWith('_');
					const used = usedLocalOrParamNames.has(pd.name);
					if (isUnderscore) {
						if (used) {
							diagnostics.push({
								code: LSL_DIAGCODES.UNDERSCORE_PARAM_USED,
								message: `Parameter "${pd.name}" is underscore-prefixed but is used`,
								range: pd.range,
								severity: DiagnosticSeverity.Warning
							});
						}
					} else if (!used) {
						// Honor block-based suppression that overlaps the function body
						const dd = pre.diagDirectives;
						const bodyStart = tokens[bodyOpenIndex].start;
						const bodyEnd = (lastTokenBeforeClose ?? nameTok).end;
						const suppressed = !!dd && dd.blocks.some(b => b.end >= bodyStart && b.start <= bodyEnd && (!b.codes || b.codes.has(LSL_DIAGCODES.UNUSED_PARAM)));
						if (!suppressed) {
							diagnostics.push({
								code: LSL_DIAGCODES.UNUSED_PARAM,
								message: `Unused parameter "${pd.name}"`,
								range: pd.range,
								severity: DiagnosticSeverity.Hint
							});
						}
					}
				}
				for (const ld of localDecls) {
					if (!usedLocalOrParamNames.has(ld.name)) {
						// Honor block-based suppression that overlaps the function body
						const dd = pre.diagDirectives;
						const bodyStart = tokens[bodyOpenIndex].start;
						const bodyEnd = (lastTokenBeforeClose ?? nameTok).end;
						const suppressed = !!dd && dd.blocks.some(b => b.end >= bodyStart && b.start <= bodyEnd && (!b.codes || b.codes.has(LSL_DIAGCODES.UNUSED_LOCAL)));
						if (!suppressed) {
							diagnostics.push({
								code: LSL_DIAGCODES.UNUSED_LOCAL,
								message: `Unused local variable "${ld.name}"`,
								range: ld.range,
								severity: DiagnosticSeverity.Hint
							});
						}
					}
				}
				popScope();
				currentBlockDepth = -1; // exit function body
				// Use control-flow heuristic: if/else blocks with braces both returning implies function returns on all paths
				if (fnDecl.type && fnDecl.type !== 'void') {
					const always = blockAlwaysReturns(tokens, bodyOpenIndex);
					if (!always) {
						const at = lastTokenBeforeClose ?? nameTok;
						diagnostics.push({
							code: LSL_DIAGCODES.MISSING_RETURN,
							message: `Function "${fnDecl.name}" must return ${fnDecl.type}`,
							range: mkRange(doc, at.start, at.end),
							severity: DiagnosticSeverity.Error
						});
					}
				}
			} else {
				diagnostics.push({ code: LSL_DIAGCODES.SYNTAX, message: 'Expected "{" after function declaration', range: mkRange(doc, nameTok.end, nameTok.end), severity: DiagnosticSeverity.Error });
			}
			continue;
		}

		// Optional-void function declaration: <name> ( ... ) { ... }
		// Do NOT treat this as a function when we're inside a state block; there, bareName '(' is an event handler.
		if (isId(t) && !inState && !defs.events.has(t.value) && peek(1)?.value === '(') {
			// Lookahead to see if this is a declaration followed by a body
			let j = i + 2; // skip name and '('
			let parenDepth = 1;
			while (j < tokens.length && parenDepth > 0) {
				const tt = tokens[j++];
				if (tt.value === '(') parenDepth++;
				else if (tt.value === ')') parenDepth--;
			}
			if (parenDepth === 0 && tokens[j]?.value === '{') {
				const nameTok = eat()!; eat(); // (
				const fnDecl: Decl = { name: nameTok.value, range: mkRange(doc, nameTok.start, nameTok.end), kind: 'func', type: 'void', params: [] };
				if (functions.has(fnDecl.name)) {
					diagnostics.push({
						code: LSL_DIAGCODES.DUPLICATE_DECL,
						message: `Function "${fnDecl.name}" is already declared`,
						range: fnDecl.range,
						severity: DiagnosticSeverity.Error
					});
				}
				functions.set(fnDecl.name, fnDecl); decls.push(fnDecl);
				// params
				pushScope();
				const paramDecls: Decl[] = [];
				while (i < tokens.length && peek()!.value !== ')') {
					const tt = peek(); if (!tt) break;
					if (isType(tt) && isId(peek(1))) {
						const pType = eat()!; const pName = eat()!;
						const p: Decl = { name: pName.value, range: mkRange(doc, pName.start, pName.end), kind: 'param', type: pType.value } as Decl & { blockDepth?: number };
						if (scope.vars.has(p.name)) {
							diagnostics.push({ code: LSL_DIAGCODES.DUPLICATE_DECL, message: `Parameter "${p.name}" is already declared`, range: p.range, severity: DiagnosticSeverity.Error });
						}
						(p as any).blockDepth = -1;
						scope.vars.set(p.name, p); decls.push(p);
						paramDecls.push(p);
						fnDecl.params!.push({ name: p.name, type: p.type });
						if (peek()?.value === ',') eat();
					} else { break; }
				}
				if (peek()?.value === ')') eat();
				if (peek()?.value === '{') {
					// current token is '{'
					eat();
					currentBlockDepth = 0; // enter void function body
					const bodyStartOffset = tokens[i - 1].start; // '{'
					let depth = 1;
					let _sawReturn = false;
					let lastTokenBeforeClose2: Token | null = null;
					const localDecls: Decl[] = [];
					const usedLocalOrParamNames = new Set<string>();
					while (i < tokens.length && depth > 0) {
						const b = peek()!;
						if (b.value === '{') { eat(); depth++; currentBlockDepth++; pushScope(); continue; }
						if (b.value === '}') { lastTokenBeforeClose2 = b; eat(); if (depth > 1) { currentBlockDepth = Math.max(0, currentBlockDepth - 1); popScope(); } depth--; continue; }
						// for-loop header: disallow declarations in initializer
						if (b.kind === 'id' && b.value === 'for' && peek(1)?.value === '(') {
							eat(); eat();
							let pd = 1; let j = i; let sawInit = false;
							while (j < tokens.length && pd > 0) {
								const tk = tokens[j];
								if (tk.value === '(') { pd++; j++; continue; }
								if (tk.value === ')') { pd--; j++; continue; }
								if (pd === 1 && !sawInit) {
									if (tk.value === ';') { sawInit = true; j++; continue; }
									if (isType(tk) && tokens[j + 1]?.kind === 'id') {
										const nameTok = tokens[j + 1]!;
										diagnostics.push({ code: LSL_DIAGCODES.SYNTAX, message: 'Variable declarations are not allowed in for-loop initializer; declare the variable before the loop', range: mkRange(doc, nameTok.start, nameTok.end), severity: DiagnosticSeverity.Error });
										j += 2; continue;
									}
								}
								j++;
							}
							i = j; continue;
						}
						// return statements
						if (b.kind === 'id' && b.value === 'return') {
							const rTok = eat()!; // 'return'
							let startOff: number | null = null;
							let endOff: number | null = null;
							let k = i;
							let foundSemi = false;
							let sawCloseBrace = false;
							while (k < tokens.length) {
								const tk = tokens[k++];
								if (tk.value === ';') { foundSemi = true; break; }
								if (tk.value === '}') { sawCloseBrace = true; k--; break; }
								if (startOff === null) startOff = tk.start;
								endOff = tk.end;
							}
							if (foundSemi) {
								i = k;
								// DEAD CODE after return; check same-line tokens
								const semiTok = tokens[k - 1]!;
								const textAll = doc.getText();
								const lineEndIdx = (() => { const nl = textAll.indexOf('\n', semiTok.end); return nl === -1 ? textAll.length : nl; })();
								const nextTok = tokens[i];
								if (nextTok && nextTok.start < lineEndIdx) {
									diagnostics.push({ code: LSL_DIAGCODES.DEAD_CODE, message: 'Unreachable code after terminating statement', range: { start: doc.positionAt(nextTok.start), end: doc.positionAt(lineEndIdx) }, severity: DiagnosticSeverity.Warning });
								}
							} else if (sawCloseBrace) {
								i = k; // let '}' be handled by loop
							} else {
								i = k;
							}
							_sawReturn = true;
							if (!foundSemi) {
								const at = (endOff ?? rTok.end);
								diagnostics.push({
									code: LSL_DIAGCODES.SYNTAX,
									message: 'Missing semicolon after return statement',
									range: mkRange(doc, at, at),
									severity: DiagnosticSeverity.Error
								});
								continue;
							}
							if (startOff === null || endOff === null) {
								// 'return;' with no expression should be fine for void functions, but warn for explicitly void we already are in
								// nothing to do for void here
							} else {
								// record identifier uses within return expression
								for (let m = 0; m < tokens.length; m++) {
									const tk = tokens[m];
									if (tk.start >= startOff && tk.end <= endOff && tk.kind === 'id') {
										const next = tokens[m + 1];
										if (next?.value === '(') continue;
										const found = lookup(tk.value);
										if (found) {
											refs.push({ name: tk.value, range: mkRange(doc, tk.start, tk.end) });
											if (found.kind === 'param' || found.kind === 'var') usedLocalOrParamNames.add(found.name);
										}
									}
								}
								// returning value in void function
								diagnostics.push({
									code: LSL_DIAGCODES.RETURN_IN_VOID,
									message: `Function "${fnDecl.name}" is void and should not return a value`,
									range: mkRange(doc, startOff, endOff),
									severity: DiagnosticSeverity.Warning
								});
							}
							continue;
						}
						if (b.kind === 'id' && b.value === 'state' && isId(peek(1)) && peek(2)?.value === ';') {
							eat(); const sName = eat()!;
							refs.push({ name: sName.value, range: mkRange(doc, sName.start, sName.end) });
							if (sName.value !== 'default' && !states.has(sName.value)) {
								diagnostics.push({ code: LSL_DIAGCODES.UNKNOWN_STATE, message: `Unknown state "${sName.value}"`, range: mkRange(doc, sName.start, sName.end), severity: DiagnosticSeverity.Error });
							}
							if (peek()?.value === ';') eat();
							continue;
						}
						if (isType(b) && isId(peek(1)) && [';', '='].includes(peek(2)?.value || '')) {
							const vt = eat()!; const vn = eat()!; const d = declareVar(vt, vn); localDecls.push(d);
						}
						if (isId(b) && peek(1)?.value === '(' && !isKeyword(b.value) && !defs.types.has(b.value)) {
							// Treat function call identifier as a reference (for goto-definition)
							refs.push({ name: b.value, range: mkRange(doc, b.start, b.end) });
							collectCall(doc, tokens, i, defs, diagnostics, calls);
						}
						if (isId(b) && peek(1)?.value !== '(') {
							const found = lookup(b.value);
							if (found) {
								refs.push({ name: b.value, range: mkRange(doc, b.start, b.end) });
								refTargets.set(b.start, found);
								if (found.kind === 'param' || found.kind === 'var') usedLocalOrParamNames.add(found.name);
							} else if (!isKnownNonVar(b.value)) {
								diagnostics.push({ code: LSL_DIAGCODES.UNKNOWN_IDENTIFIER, message: `Unknown identifier "${b.value}"`, range: mkRange(doc, b.start, b.end), severity: DiagnosticSeverity.Warning });
							}
						}
						i++;
					}
					// Unused locals/params and underscore param usage
					for (const pd of paramDecls) {
						const isUnderscore = pd.name.startsWith('_');
						const used = usedLocalOrParamNames.has(pd.name);
						if (isUnderscore) {
							if (used) {
								diagnostics.push({
									code: LSL_DIAGCODES.UNDERSCORE_PARAM_USED,
									message: `Parameter "${pd.name}" is underscore-prefixed but is used`,
									range: pd.range,
									severity: DiagnosticSeverity.Warning
								});
							}
						} else if (!used) {
							// Honor block-based suppression that overlaps the function body
							const dd = pre.diagDirectives;
							const bodyEnd = (lastTokenBeforeClose2 ?? nameTok).end;
							const suppressed = !!dd && dd.blocks.some(b => b.end >= bodyStartOffset && b.start <= bodyEnd && (!b.codes || b.codes.has(LSL_DIAGCODES.UNUSED_PARAM)));
							if (!suppressed) {
								diagnostics.push({
									code: LSL_DIAGCODES.UNUSED_PARAM,
									message: `Unused parameter "${pd.name}"`,
									range: pd.range,
									severity: DiagnosticSeverity.Hint
								});
							}
						}
					}
					for (const ld of localDecls) {
						if (!usedLocalOrParamNames.has(ld.name)) {
							// Honor block-based suppression that overlaps the function body
							const dd = pre.diagDirectives;
							const bodyEnd = (lastTokenBeforeClose2 ?? nameTok).end;
							const suppressed = !!dd && dd.blocks.some(b => b.end >= bodyStartOffset && b.start <= bodyEnd && (!b.codes || b.codes.has(LSL_DIAGCODES.UNUSED_LOCAL)));
							if (!suppressed) {
								diagnostics.push({
									code: LSL_DIAGCODES.UNUSED_LOCAL,
									message: `Unused local variable "${ld.name}"`,
									range: ld.range,
									severity: DiagnosticSeverity.Hint
								});
							}
						}
					}
					popScope();
					currentBlockDepth = -1; // exit void function body
					// void functions don't need return; just close
				}
				continue;
			}
		}

		// Event handler: <eventName> ( ... ) { ... } — only valid inside state; enforce known events/params
		// 1) Guard: unknown event inside a state should not cause an infinite loop. Report and skip its form.
		if (inState && isId(t) && peek(1)?.value === '(' && !defs.events.has(t.value) && !defs.funcs.has(t.value)) {
			const evtName = t.value;
			diagnostics.push({ code: LSL_DIAGCODES.UNKNOWN_EVENT, message: `Unknown event "${evtName}"`, range: mkRange(doc, t.start, t.end), severity: DiagnosticSeverity.Error });
			// Skip over parameter list to the matching ')' and optional body '{...}' to make progress
			let j = i + 1; // at '('
			let pd = 0;
			if (tokens[j]?.value === '(') { pd = 1; j++; }
			while (j < tokens.length && pd > 0) {
				const tk = tokens[j++];
				if (tk.value === '(') pd++;
				else if (tk.value === ')') pd--;
			}
			// Position main scanner after ')'
			i = j;
			// If there's a body, skip it as well
			if (tokens[i]?.value === '{') {
				let bd = 1; i++;
				while (i < tokens.length && bd > 0) {
					const tk = tokens[i++];
					if (tk.value === '{') bd++;
					else if (tk.value === '}') bd--;
				}
			}
			continue;
		}
		// 2) Known event: parse and validate
		if (isId(t) && defs.events.has(t.value) && peek(1)?.value === '(') {
			const evtName = t.value;
			if (!inState) {
				diagnostics.push({ code: LSL_DIAGCODES.EVENT_OUTSIDE_STATE, message: `Event "${evtName}" must be inside a state`, range: mkRange(doc, t.start, t.end), severity: DiagnosticSeverity.Error });
			}
			// Duplicate event in the same state
			if (inState && currentStateEvents) {
				if (currentStateEvents.has(evtName)) {
					diagnostics.push({ code: LSL_DIAGCODES.DUPLICATE_DECL, message: `Event "${evtName}" is already declared in state "${inState}"`, range: mkRange(doc, t.start, t.end), severity: DiagnosticSeverity.Error });
				} else {
					currentStateEvents.add(evtName);
				}
			}
			const evtTok = eat()!; eat(); // (
			pushScope();
			const _evt = defs.events.get(evtTok.value)!;
			// record event declaration for analysis
			const evDecl: Decl = { name: evtTok.value, range: mkRange(doc, evtTok.start, evtTok.end), kind: 'event', params: _evt.params.map(p => ({ name: p.name, type: p.type })) };
			decls.push(evDecl);
			// parse params
			const params: string[] = [];
			const paramDecls: Decl[] = [];
			while (i < tokens.length && peek()!.value !== ')') {
				if (isType(peek()) && isId(peek(1))) {
					const pType = eat()!; const pName = eat()!;
					const d: Decl = { name: pName.value, range: mkRange(doc, pName.start, pName.end), kind: 'param', type: pType.value };
					scope.vars.set(d.name, d); decls.push(d); params.push(pType.value); paramDecls.push(d);
					if (peek()?.value === ',') eat();
				} else { break; }
			}
			// Enforce exact arity and parameter types against defs
			if (params.length !== _evt.params.length) {
				diagnostics.push({ code: LSL_DIAGCODES.WRONG_ARITY, message: `Event "${_evt.name}" expects ${_evt.params.length} parameter(s)`, range: mkRange(doc, evtTok.start, evtTok.end), severity: DiagnosticSeverity.Error });
			} else {
				for (let k = 0; k < params.length; k++) {
					const expected = normalizeType(_evt.params[k]!.type);
					const got = normalizeType(params[k]!);
					if (expected !== got) {
						diagnostics.push({ code: LSL_DIAGCODES.WRONG_TYPE, message: `Parameter ${k + 1} of event "${_evt.name}" must be ${_evt.params[k]!.type}`, range: paramDecls[k]!.range, severity: DiagnosticSeverity.Error });
					}
				}
			}
			if (peek()?.value === ')') eat();
			if (peek()?.value === '{') {
				eat();
				currentBlockDepth = 0; // enter event body
				let depth = 1;
				const localDecls: Decl[] = [];
				const usedLocalOrParamNames = new Set<string>();
				while (i < tokens.length && depth > 0) {
					const b = peek()!;
					if (b.value === '{') { eat(); depth++; currentBlockDepth++; pushScope(); continue; }
					if (b.value === '}') { eat(); if (depth > 1) { currentBlockDepth = Math.max(0, currentBlockDepth - 1); popScope(); } depth--; continue; }
					// state transition on a single line
					if (b.kind === 'id' && b.value === 'state' && isId(peek(1)) && peek(2)?.value === ';') {
						const _sTok = eat()!; const _nm = eat()!; const semi = eat()!;
						const textAll = doc.getText();
						const lineEndIdx = (() => { const nl = textAll.indexOf('\n', semi.end); return nl === -1 ? textAll.length : nl; })();
						const nextTok = peek();
						if (nextTok && nextTok.start < lineEndIdx) {
							diagnostics.push({ code: LSL_DIAGCODES.DEAD_CODE, message: 'Unreachable code after terminating statement', range: { start: doc.positionAt(nextTok.start), end: doc.positionAt(lineEndIdx) }, severity: DiagnosticSeverity.Warning });
						}
						continue;
					}
					// jump on a single line
					if (b.kind === 'id' && b.value === 'jump' && isId(peek(1)) && peek(2)?.value === ';') {
						const _jTok = eat()!; const _lbl = eat()!; const semi = eat()!;
						const textAll = doc.getText();
						const lineEndIdx = (() => { const nl = textAll.indexOf('\n', semi.end); return nl === -1 ? textAll.length : nl; })();
						const nextTok = peek();
						if (nextTok && nextTok.start < lineEndIdx) {
							diagnostics.push({ code: LSL_DIAGCODES.DEAD_CODE, message: 'Unreachable code after terminating statement', range: { start: doc.positionAt(nextTok.start), end: doc.positionAt(lineEndIdx) }, severity: DiagnosticSeverity.Warning });
						}
						continue;
					}
					// for-loop header: disallow declarations in initializer
					if (b.kind === 'id' && b.value === 'for' && peek(1)?.value === '(') {
						eat(); eat();
						let pd = 1; let j = i; let sawInit = false;
						while (j < tokens.length && pd > 0) {
							const tk = tokens[j];
							if (tk.value === '(') { pd++; j++; continue; }
							if (tk.value === ')') { pd--; j++; continue; }
							if (pd === 1 && !sawInit) {
								if (tk.value === ';') { sawInit = true; j++; continue; }
								if (isType(tk) && tokens[j + 1]?.kind === 'id') {
									const nameTok = tokens[j + 1]!;
									diagnostics.push({ code: LSL_DIAGCODES.SYNTAX, message: 'Variable declarations are not allowed in for-loop initializer; declare the variable before the loop', range: mkRange(doc, nameTok.start, nameTok.end), severity: DiagnosticSeverity.Error });
									j += 2; continue;
								}
							}
							j++;
						}
						i = j; continue;
					}
					if (isType(b) && isId(peek(1)) && [';', '='].includes(peek(2)?.value || '')) {
						const vt = eat()!; const vn = eat()!;
						const d = declareVar(vt, vn);
						localDecls.push(d);
					}
					if (isId(b) && peek(1)?.value === '(' && !isKeyword(b.value) && !defs.types.has(b.value)) {
						// Treat function call identifier as a reference (for goto-definition)
						refs.push({ name: b.value, range: mkRange(doc, b.start, b.end) });
						collectCall(doc, tokens, i, defs, diagnostics, calls);
					}
					// identifier uses inside event body (e.g., referencing globals)
					if (isId(b) && peek(1)?.value !== '(') {
						const found = lookup(b.value);
						if (found) {
							refs.push({ name: b.value, range: mkRange(doc, b.start, b.end) });
							refTargets.set(b.start, found);
							if (found.kind === 'param' || found.kind === 'var') usedLocalOrParamNames.add(found.name);
						} else if (!isKnownNonVar(b.value)) {
							diagnostics.push({
								code: LSL_DIAGCODES.UNKNOWN_IDENTIFIER,
								message: `Unknown identifier "${b.value}"`,
								range: mkRange(doc, b.start, b.end),
								severity: DiagnosticSeverity.Warning
							});
						}
					}
					i++;
				}
				// Unused locals/params and underscore param usage
				for (const pd of paramDecls) {
					const isUnderscore = pd.name.startsWith('_');
					const used = usedLocalOrParamNames.has(pd.name);
					if (isUnderscore) {
						if (used) {
							diagnostics.push({
								code: LSL_DIAGCODES.UNDERSCORE_PARAM_USED,
								message: `Parameter "${pd.name}" is underscore-prefixed but is used`,
								range: pd.range,
								severity: DiagnosticSeverity.Warning
							});
						}
					} else if (!used) {
						// Event bodies: keep default behavior (no special block suppression)
						diagnostics.push({
							code: LSL_DIAGCODES.UNUSED_PARAM,
							message: `Unused parameter "${pd.name}"`,
							range: pd.range,
							severity: DiagnosticSeverity.Hint
						});
					}
				}
				for (const ld of localDecls) {
					if (!usedLocalOrParamNames.has(ld.name)) {
						// Event bodies: keep default behavior
						diagnostics.push({
							code: LSL_DIAGCODES.UNUSED_LOCAL,
							message: `Unused local variable "${ld.name}"`,
							range: ld.range,
							severity: DiagnosticSeverity.Hint
						});
					}
				}
			}
			popScope();
			currentBlockDepth = -1; // exit event body
			continue;
		}

		// Global variable
		if (isType(t) && isId(peek(1)) && [';', '='].includes(peek(2)?.value || '')) {
			const tt = eat()!; const nameTok = eat()!;
			if (isReservedName(nameTok.value)) {
				diagnostics.push({
					code: LSL_DIAGCODES.RESERVED_IDENTIFIER,
					message: `"${nameTok.value}" is reserved and cannot be used as an identifier`,
					range: mkRange(doc, nameTok.start, nameTok.end),
					severity: DiagnosticSeverity.Error
				});
			}
			const decl: Decl = { name: nameTok.value, range: mkRange(doc, nameTok.start, nameTok.end), kind: 'var', type: tt.value };
			if (globalScope.vars.has(nameTok.value)) {
				diagnostics.push({
					code: LSL_DIAGCODES.DUPLICATE_DECL,
					message: `Global variable "${nameTok.value}" is already declared`,
					range: mkRange(doc, nameTok.start, nameTok.end),
					severity: DiagnosticSeverity.Error
				});
			}
			globalScope.vars.set(nameTok.value, decl);
			decls.push(decl);
			if (peek()?.value === '=') {
				// Analyze initializer expression up to ';'
				eat(); // '='
				const initStart = i;
				let j = i;
				while (j < tokens.length && tokens[j].value !== ';' && tokens[j].value !== '}') j++;
				analyzeIdUsesInRange(initStart, j);
				i = j;
				if (peek()?.value === ';') eat();
			} else {
				if (peek()?.value === ';') eat();
			}
			continue;
		}

		// Fallback: state change statement anywhere: state <id>;
		if (t.kind === 'id' && t.value === 'state' && isId(peek(1)) && peek(2)?.value === ';') {
			eat(); const sName = eat()!; // consume 'state' and name
			refs.push({ name: sName.value, range: mkRange(doc, sName.start, sName.end) });
			if (sName.value !== 'default' && !states.has(sName.value)) {
				diagnostics.push({ code: LSL_DIAGCODES.UNKNOWN_STATE, message: `Unknown state "${sName.value}"`, range: mkRange(doc, sName.start, sName.end), severity: DiagnosticSeverity.Error });
			}
			if (peek()?.value === ';') eat();
			continue;
		}

		// Track identifier uses to compute "unused" later
		if (isId(t)) {
			const d = lookup(t.value);
			if (d) { refs.push({ name: t.value, range: mkRange(doc, t.start, t.end) }); refTargets.set(t.start, d); }
			else {
				// Unknown identifier or constant? Check defs and macros
				if (isKnownNonVar(t.value)) {
					// ok; not a variable
				} else if (defs.funcs.has(t.value) && peek(1)?.value === '(') {
					// will be validated by call collector
				} else {
					// likely unknown identifier; don't flag if part of #...
					// The lexer emits 'pp' for entire preprocessor lines; so here it's safe.
					// Also: suppress unknown identifier for state transition statements: `state <id>;`
					const prevTok = tokens[i - 1];
					const nextTok = peek(1);
					const isStateTransition = prevTok && prevTok.kind === 'id' && prevTok.value === 'state' && nextTok && nextTok.value === ';';
					if (!isStateTransition) {
						diagnostics.push({
							code: LSL_DIAGCODES.UNKNOWN_IDENTIFIER,
							message: `Unknown identifier "${t.value}"`,
							range: mkRange(doc, t.start, t.end),
							severity: DiagnosticSeverity.Warning
						});
					}
				}
			}
		}

		// Dead code after return/state/jump on the same line: when we reach a semicolon
		const tok = peek();
		if (tok && tok.value === ';') {
			// Does this statement include one of the terminating keywords?
			let hasTerminator = false;
			for (let k = stmtStartIndex; k <= i; k++) {
				const tt = tokens[k];
				if (!tt) continue;
				if (tt.kind === 'id' && (tt.value === 'return' || tt.value === 'state' || tt.value === 'jump')) {
					hasTerminator = true; break;
				}
			}
			if (hasTerminator) {
				// Find end-of-line
				const text = doc.getText();
				const lineEndIdx = (() => {
					const nl = text.indexOf('\n', tok.end);
					return nl === -1 ? text.length : nl;
				})();
				const nextTok = tokens[i + 1];
				if (nextTok && nextTok.start < lineEndIdx) {
					// Report from nextTok start to end of line
					diagnostics.push({
						code: LSL_DIAGCODES.DEAD_CODE,
						message: 'Unreachable code after terminating statement',
						range: { start: doc.positionAt(nextTok.start), end: doc.positionAt(lineEndIdx) },
						severity: DiagnosticSeverity.Warning
					});
				}
			}
			// Next statement begins after this semicolon
			stmtStartIndex = i + 1;
		}

		i++;
	}

	// Validate call arities and unknown constants used as bare id
	for (const c of calls) {
		// Skip validation for user-defined functions declared in this document
		let userFn = functions.get(c.name);
		// Be order-independent: also scan decls for any function with this name
		if (!userFn) {
			const anyDecl = decls.find(d => d.kind === 'func' && d.name === c.name);
			if (anyDecl) userFn = anyDecl;
		}
		const overloads = defs.funcs.get(c.name);
		// Consider include-provided functions (from headers) as known for diagnostics
		let includeSig: { params: { type: string }[] } | null = null;
		if (!userFn && (!overloads || overloads.length === 0) && pre.includeSymbols && pre.includeSymbols.size > 0) {
			for (const info of pre.includeSymbols.values()) {
				const f = info.functions.get(c.name);
				if (f) { includeSig = { params: f.params.map(p => ({ type: p.type })) }; break; }
			}
		}
		if (!userFn && (!overloads || overloads.length === 0) && !includeSig) {
			// Skip unknown diagnostics for macro-like calls (function-style macros)
			if (Object.prototype.hasOwnProperty.call(pre.macros, c.name)) continue;
			diagnostics.push({
				code: LSL_DIAGCODES.UNKNOWN_IDENTIFIER,
				message: `Unknown function "${c.name}"`,
				range: c.range,
				severity: DiagnosticSeverity.Error
			});
			continue;
		}
		const arityOk = userFn
			? (c.args >= (userFn.params?.length ?? 0) && c.args <= (userFn.params?.length ?? 0))
			: (overloads ? overloads.some(fn => arityMatches(fn, c.args)) : (includeSig ? c.args === (includeSig.params?.length ?? 0) : true));
		if (!arityOk) {
			// Report arity errors for defs/user or include signature when available
			if ((userFn || overloads) || (!userFn && !overloads && includeSig)) {
				diagnostics.push({
					code: LSL_DIAGCODES.WRONG_ARITY,
					message: `Function "${c.name}" called with ${c.args} argument(s)`,
					range: c.range,
					severity: DiagnosticSeverity.Error
				});
			}
		}
		// Simple type checking when we have arg ranges and either userFn or a single matching overload by arity
		const candidates: { params: { type: string }[] }[] = [];
		if (userFn) {
			candidates.push({ params: (userFn.params ?? []).map(p => ({ type: p.type ?? 'any' })) });
		} else if (overloads) {
			for (const fn of overloads) {
				if (arityMatches(fn, c.args)) candidates.push({ params: fn.params.map(p => ({ type: p.type })) });
			}
		} else if (includeSig) {
			candidates.push(includeSig);
		}
		if (candidates.length > 0 && c.argRanges.length > 0) {
			const argTypes = c.argRanges.map(r => inferExprType(doc, tokens, r));
			let matched = false;
			for (const cand of candidates) {
				let ok = true;
				for (let k = 0; k < Math.min(cand.params.length, argTypes.length); k++) {
					if (!typeMatches(cand.params[k].type, argTypes[k])) { ok = false; break; }
				}
				if (ok) { matched = true; break; }
			}
			if (!matched) {
				// Report first mismatched arg
				for (let k = 0; k < Math.min(candidates[0].params.length, argTypes.length); k++) {
					if (!typeMatches(candidates[0].params[k].type, argTypes[k])) {
						diagnostics.push({
							code: LSL_DIAGCODES.WRONG_TYPE,
							message: `Argument ${k+1} of "${c.name}" expects ${candidates[0].params[k].type}, got ${argTypes[k]}`,
							range: c.argRanges[k],
							severity: DiagnosticSeverity.Error
						});
						break;
					}
				}
			}
		}
	}

	// Unused variable diagnostics (simple heuristic)
	for (const [name, d] of globalScope.vars) {
		if (d.kind === 'var' && !refs.some(r => r.name === name)) {
			// Do not report for reserved identifiers to avoid noise
			if (isReservedName(name)) continue;
			diagnostics.push({
				code: LSL_DIAGCODES.UNUSED_VAR,
				message: `Unused global variable "${name}"`,
				range: d.range,
				severity: DiagnosticSeverity.Hint
			});
		}
	}

	// Final pass: ensure any `state <id>;` statements refer to declared states
	for (let k = 0; k + 2 < tokens.length; k++) {
		const t0 = tokens[k], t1 = tokens[k + 1], t2 = tokens[k + 2];
		if (t0.kind === 'id' && t0.value === 'state' && t1?.kind === 'id' && t2?.value === ';') {
			// Check if we already recorded a ref at this exact span to avoid duplicate diags
			const r = mkRange(doc, t1.start, t1.end);
			if (!refs.some(x => doc.offsetAt(x.range.start) === t1.start && doc.offsetAt(x.range.end) === t1.end)) {
				refs.push({ name: t1.value, range: r });
			}
			if (t1.value !== 'default' && !states.has(t1.value)) {
				if (!diagnostics.some(d => d.code === LSL_DIAGCODES.UNKNOWN_STATE && doc.offsetAt(d.range.start) === t1.start)) {
					diagnostics.push({ code: LSL_DIAGCODES.UNKNOWN_STATE, message: `Unknown state "${t1.value}"`, range: r, severity: DiagnosticSeverity.Error });
				}
			}
			k += 2;
		}
	}

	// Operator/type sanity checks (conservative, low-noise): include symbol type map for better inference
	const symbolTypes = new Map<string, string>();
	for (const d of decls) {
		if ((d.kind === 'var' || d.kind === 'param') && d.type) {
			// last declaration wins
			symbolTypes.set(d.name, d.type);
		}
	}
	validateOperators(doc, tokens, diagnostics, symbolTypes);
	validateSuspiciousAssignments(doc, tokens, diagnostics);
	validateAssignmentLHS(doc, tokens, diagnostics);
	// Apply diagnostic suppression based on preprocessor directives
	const dd = pre.diagDirectives;
	let finalDiagnostics = diagnostics;
	if (dd && (dd.disableLine.size > 0 || dd.disableNextLine.size > 0 || dd.blocks.length > 0)) {
		finalDiagnostics = diagnostics.filter(d => {
			const startOff = doc.offsetAt(d.range.start);
			const lineNo = doc.positionAt(startOff).line + 1; // 1-based
			const hasCode = (set: Set<string> | null) => !set || set.has(d.code);
			const s1 = dd.disableLine.get(lineNo); if (s1 && hasCode(s1)) return false;
			const s2 = dd.disableNextLine.get(lineNo); if (s2 && hasCode(s2)) return false;
			for (const b of dd.blocks) {
				if (startOff >= b.start && startOff <= b.end && hasCode(b.codes)) return false;
			}
			return true;
		});
	}
	// Note: you can collect function/event locals similarly by tracking scopes array

	return {
		diagnostics: finalDiagnostics, decls, refs, calls, states, functions,
		symbolAt(offset: number) {
			for (const d of decls) {
				const s = doc.offsetAt(d.range.start);
				const e = doc.offsetAt(d.range.end);
				if (offset >= s && offset <= e) return d;
			}
			return null;
		},
		refAt(offset: number) { return refTargets.get(offset) || null; }
	};
}

// Guess a simple literal type around operator index.
type SimpleType = 'integer' | 'float' | 'string' | 'vector' | 'list' | 'rotation' | 'any';
function isTypeName(name: string): name is SimpleType {
	return name === 'integer' || name === 'float' || name === 'string' || name === 'vector' || name === 'list' || name === 'rotation';
}
function guessRightOperandType(tokens: Token[], idx: number, symbolTypes: Map<string, string>): { type: SimpleType; zero?: boolean } {
	let i = idx + 1;
	// Skip unary signs on literals
	while (i < tokens.length && (tokens[i].value === '+' || tokens[i].value === '-' )) { i++; break; }
	if (i >= tokens.length) return { type: 'any' };
	// If the right side starts with '(', skip to the matching ')' and infer from the inner expression's first token
	if (tokens[i].value === '(') {
		// Cast pattern: (type) expr
		const t1 = tokens[i + 1]; const t2 = tokens[i + 2];
		if (t1 && t1.kind === 'id' && isTypeName(normalizeType(t1.value)) && t2 && t2.value === ')') {
			return { type: normalizeType(t1.value) as SimpleType };
		}
		let pd = 1; let j = i + 1;
		// find first non-whitespace/punc meaningful token inside
		while (j < tokens.length && pd > 0) {
			const tk = tokens[j];
			if (tk.value === '(') { pd++; j++; continue; }
			if (tk.value === ')') { pd--; if (pd === 0) break; j++; continue; }
			// Use this inner token to guess
			if (pd === 1) {
				// Recurse heuristically by treating this as the right token
				// Simplify: if identifier, use symbol type; if num, decide; if vector/list/string literal openers, return those
				if (tk.kind === 'num') return { type: /\./.test(tk.value) ? 'float' : 'integer' };
				if (tk.kind === 'str') return { type: 'string' };
				if (tk.value === '<') return { type: 'vector' };
				if (tk.value === '[') return { type: 'list' };
				if (tk.kind === 'id') {
					const norm = normalizeType(tk.value);
					if (isTypeName(norm)) return { type: norm as SimpleType };
					const ty = symbolTypes.get(tk.value);
					if (isTypeName(normalizeType(ty || ''))) return { type: normalizeType(ty!) as SimpleType };
					return { type: 'any' };
				}
			}
			j++;
		}
		return { type: 'any' };
	}
	const t = tokens[i]; if (!t) return { type: 'any' };
	if (t.value === '<') return { type: 'vector' };
	if (t.value === '[') return { type: 'list' };
	if (t.kind === 'str') return { type: 'string' };
	if (t.kind === 'num') {
		const z = Number.parseFloat(t.value);
		return { type: /\./.test(t.value) ? 'float' : 'integer', zero: !Number.isNaN(z) && z === 0 };
	}
	if (t.kind === 'id') {
		const norm = normalizeType(t.value);
		if (isTypeName(norm)) return { type: norm };
		const ty = symbolTypes.get(t.value);
		if (ty) {
			const normTy = normalizeType(ty);
			if (isTypeName(normTy)) return { type: normTy as SimpleType };
		}
	}
	return { type: 'any' };
}
function guessLeftOperandType(tokens: Token[], idx: number, symbolTypes: Map<string, string>): SimpleType {
	let i = idx - 1;
	if (i < 0) return 'any';
	// Detect immediate cast applied to the left operand: (type) <operand>
	const prev1 = tokens[i - 1]; const prev2 = tokens[i - 2]; const prev3 = tokens[i - 3];
	if (prev1 && prev2 && prev3 && prev1.value === ')' && prev3.value === '(' && prev2.kind === 'id') {
		const norm = normalizeType(prev2.value);
		if (isTypeName(norm)) return norm as SimpleType;
	}
	// If we are at a closing bracket/paren/angle, jump to its opener
	const closeToOpen: Record<string,string> = { ')': '(', ']': '[', '>': '<' };
	if (tokens[i] && closeToOpen[tokens[i].value]) {
		const closer = tokens[i].value;
		const opener = closeToOpen[closer];
		let depth = 1; i--;
		while (i >= 0 && depth > 0) {
			const v = tokens[i].value;
			if (v === opener) depth--; else if (v === closer) depth++;
			i--;
		}
		i++; // now at opener
	}
	// If left side ends with ')', find the inner meaningful token and type it
	if (tokens[i] && tokens[i].value === '(') {
		// Move forward one to inspect inside
		let j = i + 1; let pd = 1;
		while (j < tokens.length && pd > 0) {
			const tk = tokens[j];
			if (tk.value === '(') { pd++; j++; continue; }
			if (tk.value === ')') { pd--; if (pd === 0) break; j++; continue; }
			if (pd === 1) {
				if (tk.kind === 'num') return /\./.test(tk.value) ? 'float' : 'integer';
				if (tk.kind === 'str') return 'string';
				if (tk.value === '<') return 'vector';
				if (tk.value === '[') return 'list';
				if (tk.kind === 'id') {
					const norm = normalizeType(tk.value);
					if (isTypeName(norm)) return norm as SimpleType;
					const ty = symbolTypes.get(tk.value);
					if (ty) {
						const normTy = normalizeType(ty);
						if (isTypeName(normTy)) return normTy as SimpleType;
					}
					return 'any';
				}
			}
			j++;
		}
		return 'any';
	}
	const t = tokens[i]; if (!t) return 'any';
	if (t.value === '<') return 'vector';
	if (t.value === '[') return 'list';
	if (t.kind === 'str') return 'string';
	if (t.kind === 'num') return /\./.test(t.value) ? 'float' : 'integer';
	if (t.kind === 'id') {
		const norm = normalizeType(t.value);
		if (isTypeName(norm)) return norm as SimpleType;
		const ty = symbolTypes.get(t.value);
		if (ty) {
			const normTy = normalizeType(ty);
			if (isTypeName(normTy)) return normTy as SimpleType;
		}
	}
	return 'any';
}

function validateOperators(doc: TextDocument, tokens: Token[], diagnostics: Diag[], symbolTypes: Map<string, string>) {
	for (let i = 0; i < tokens.length; i++) {
		const t = tokens[i];
		if (t.kind !== 'op') continue;
		// Skip logical operators '||' and '&&' entirely (both the first and second character tokens)
		if (
			(t.value === '|' && (tokens[i - 1]?.value === '|' || tokens[i + 1]?.value === '|')) ||
			(t.value === '&' && (tokens[i - 1]?.value === '&' || tokens[i + 1]?.value === '&'))
		) {
			continue;
		}
		// Merge two-char ops like <<, >> and then filter of interest
		let opVal = t.value;
		if ((opVal === '<' || opVal === '>') && tokens[i + 1]?.value === opVal) { opVal = opVal + opVal; }
		if (!['/', '%', '&', '|', '^', '<<', '>>', '+', '*'].includes(opVal)) continue;
		if (opVal.length === 2 && (opVal === '<<' || opVal === '>>')) { /* ok */ }
		else if (t.value === '<' || t.value === '>') { continue; } // treat as vector angle, not compare here

		// Determine simple operand types (literal-based)
		const lt = guessLeftOperandType(tokens, i, symbolTypes);
		// For two-character operators like '<<' and '>>', the right operand starts after two tokens
		const rightBaseIdx = i + ((opVal.length === 2) ? 1 : 0);
		const rinfo = guessRightOperandType(tokens, rightBaseIdx, symbolTypes);
		const rt = rinfo.type;

		// Division by zero
		if (opVal === '/' && rinfo.zero) {
			diagnostics.push({ code: LSL_DIAGCODES.WRONG_TYPE, message: 'Division by zero', range: mkRange(doc, t.start, t.end), severity: DiagnosticSeverity.Information });
			continue;
		}
		// Modulus by zero and allowed types
		if (opVal === '%') {
			if (rt === 'integer' && rinfo.zero) {
				diagnostics.push({ code: LSL_DIAGCODES.WRONG_TYPE, message: 'Modulus by zero', range: mkRange(doc, t.start, t.end), severity: DiagnosticSeverity.Information });
				continue;
			}
			const bothInt = lt === 'integer' && rt === 'integer';
			const bothVec = lt === 'vector' && rt === 'vector';
			const anyKnown = lt !== 'any' && rt !== 'any';
			if (anyKnown && !(bothInt || bothVec)) {
				diagnostics.push({ code: LSL_DIAGCODES.WRONG_TYPE, message: 'Operator % expects integer%integer or vector%vector', range: mkRange(doc, t.start, t.end), severity: DiagnosticSeverity.Information });
			}
			continue;
		}
		// Bitwise and shifts: integer-only when known
		if (opVal === '&' || opVal === '|' || opVal === '^' || opVal === '<<' || opVal === '>>') {
			if ((lt !== 'any' && lt !== 'integer') || (rt !== 'any' && rt !== 'integer')) {
				diagnostics.push({ code: LSL_DIAGCODES.WRONG_TYPE, message: `Operator ${opVal} expects integer operands`, range: mkRange(doc, t.start, t.end), severity: DiagnosticSeverity.Information });
			}
			continue;
		}
		// Addition: list concatenation if either list (ok), string+string ok, numeric combos ok, vector+vector ok, rotation+rotation ok; otherwise if both literals are known and mismatched, flag
		if (opVal === '+') {
			if (lt === 'list' || rt === 'list') continue; // list concatenation
			const numeric = (x: SimpleType) => x === 'integer' || x === 'float';
			if ((lt === 'string' && rt === 'string') || (numeric(lt) && numeric(rt)) || (lt === 'vector' && rt === 'vector') || (lt === 'rotation' && rt === 'rotation')) continue;
			if (lt !== 'any' && rt !== 'any') {
				diagnostics.push({ code: LSL_DIAGCODES.WRONG_TYPE, message: `Operator + type mismatch: ${lt} + ${rt}`, range: mkRange(doc, t.start, t.end), severity: DiagnosticSeverity.Information });
			}
			continue;
		}
		// Multiplication basic combos: vector*vector (dot) ok; rotation/vector combos are not validated here; if both known literals and invalid, flag minimal cases
		if (opVal === '*') {
			if (lt === 'vector' && rt === 'vector') continue; // dot product
			const numeric = (x: SimpleType) => x === 'integer' || x === 'float';
			if (numeric(lt) && numeric(rt)) continue;
			if (lt !== 'any' && rt !== 'any') {
				diagnostics.push({ code: LSL_DIAGCODES.WRONG_TYPE, message: `Operator * type mismatch: ${lt} * ${rt}`, range: mkRange(doc, t.start, t.end), severity: DiagnosticSeverity.Information });
			}
		}
	}
}

// Warn when we detect an assignment '=' inside an if(...) condition where '==' is likely intended.
// Heuristics:
// - Fires only for top-level '=' at parenDepth==1 in the condition span.
// - Ignores '==' '!=', '<=' '>=' and '=<', '=>', '<<=', '>>=', '&&=', '||=' etc. by requiring the token to be single '=' operator token with neighbors not '='.
// - Reports as Information to be low-noise.
function validateSuspiciousAssignments(doc: TextDocument, tokens: Token[], diagnostics: Diag[]) {
	for (let i = 0; i < tokens.length; i++) {
		const t = tokens[i];
		if (!(t.kind === 'id' && t.value === 'if' && tokens[i + 1]?.value === '(')) continue;
		// scan condition until matching ')'
		let j = i + 2; // first token inside '('
		let depth = 1;
		let bDepth = 0, cDepth = 0, vDepth = 0;
		while (j < tokens.length && depth > 0) {
			const tk = tokens[j];
			if (!tk) break;
			if (tk.value === '(') { depth++; j++; continue; }
			if (tk.value === ')') { depth--; j++; continue; }
			if (tk.value === '[') { bDepth++; j++; continue; }
			if (tk.value === ']') { if (bDepth>0) bDepth--; j++; continue; }
			if (tk.value === '{') { cDepth++; j++; continue; }
			if (tk.value === '}') { if (cDepth>0) cDepth--; j++; continue; }
			if (tk.value === '<') { vDepth++; j++; continue; }
			if (tk.value === '>') { if (vDepth>0) vDepth--; j++; continue; }
			// Only consider tokens at parenDepth==1 and not inside list/vector/braces
			if (depth === 1 && bDepth === 0 && cDepth === 0 && vDepth === 0 && tk.kind === 'op' && tk.value === '=') {
				const prev = tokens[j - 1]?.value || '';
				const next = tokens[j + 1]?.value || '';
				// If neighbors form '==', '!=', '<=', '>=' or '=>', '=<', skip
				if (prev === '=' || next === '=' || prev === '!' || prev === '<' || prev === '>' || next === '<' || next === '>') {
					j++; continue;
				}
				// Also skip common assignment within parentheses in constructs like (x = llGetSomething()) by requiring left to be an identifier or member and right a literal/identifier
				// But still warn; users can ignore or assign before the if.
				diagnostics.push({
					code: LSL_DIAGCODES.SUSPICIOUS_ASSIGNMENT,
					message: 'Suspicious assignment in condition: did you mean == ?',
					range: mkRange(doc, tk.start, tk.end),
					severity: DiagnosticSeverity.Information
				});
				// continue scanning to find more, but avoid spamming multiple warnings in same condition
				// Jump to end of this condition
				while (j < tokens.length && depth > 0) {
					const t2 = tokens[j++];
					if (t2.value === '(') depth++; else if (t2.value === ')') depth--;
				}
				break;
			}
			j++;
		}
	}
}

// Enforce: Left-hand side of assignment must be an lvalue (a variable or member like v.x), not a literal or call.
// Heuristics: detect simple '=' where neighbors aren't '=' '!' '<' '>' to avoid '==' '<=' etc.
// Determine LHS base token at same paren/bracket/brace/vector depth and check it isn't a literal or a call.
function validateAssignmentLHS(doc: TextDocument, tokens: Token[], diagnostics: Diag[]) {
	for (let i = 0; i < tokens.length; i++) {
		const t = tokens[i];
		if (!(t.kind === 'op' && t.value === '=')) continue;
		const prev = tokens[i - 1]?.value || '';
		const next = tokens[i + 1]?.value || '';
		// skip '==', '!=', '<=', '>=', '=>', '=<', '<<=', '>>='
		if (prev === '=' || next === '=' || prev === '!' || prev === '<' || prev === '>' || next === '<' || next === '>') continue;
		// Find LHS start token index at same depth
		let j = i - 1;
		let p = 0, b = 0, c = 0, v = 0; // () [] {} <>
		// Walk left to the first token that is separated by operators/semicolons/commas at zero depth
		while (j >= 0) {
			const tk = tokens[j];
			if (!tk) break;
			if (tk.value === ')') { p++; j--; continue; }
			if (tk.value === '(') { if (p>0) { p--; j--; continue; } }
			if (tk.value === ']') { b++; j--; continue; }
			if (tk.value === '[') { if (b>0) { b--; j--; continue; } }
			if (tk.value === '}') { c++; j--; continue; }
			if (tk.value === '{') { if (c>0) { c--; j--; continue; } }
			if (tk.value === '>') { v++; j--; continue; }
			if (tk.value === '<') { if (v>0) { v--; j--; continue; } }
			// At zero depth and we hit a separator, stop before it
			if (p === 0 && b === 0 && c === 0 && v === 0) {
				if (tk.kind === 'punc' && (tk.value === ';' || tk.value === ',')) { j++; break; }
				// For binary operators, stop after it
				if (tk.kind === 'op' && tk.value !== '.' && tk.value !== '_' ) { j++; break; }
			}
			j--;
		}
		if (j < 0) j = 0;
		// The LHS ends at i-1; we now determine if it's a valid lvalue.
		// Accept patterns: id, id . id, id [ ... ] (indexing), and parenthesized id/member.
		// We don't need full lvalue detection yet; handle obvious errors conservatively.
		// Quick checks for obvious non-lvalues: if token before '=' is a string/number literal or ')'
		const last = tokens[i - 1];
		let bad = false;
		if (!last) continue;
		if (last.kind === 'str' || last.kind === 'num') bad = true;
		else if (last.value === ')') {
			// Walk left to matching '('
			let d = 1; let k = i - 2; let openIdx = -1;
			while (k >= 0) {
				const v = tokens[k].value;
				if (v === ')') d++; else if (v === '(') { d--; if (d === 0) { openIdx = k; break; } }
				k--;
			}
			if (openIdx >= 1) {
				const beforeOpen = tokens[openIdx - 1];
				// If immediately before '(' is an id, treat as call result -> invalid LHS
				if (beforeOpen && beforeOpen.kind === 'id') bad = true;
			}
		}
		// Also if last token is ']' (indexing), allow: array[index] = ...
		if (last.value === ']') bad = false; // allow indexing writes
		if (bad) {
			diagnostics.push({
				code: LSL_DIAGCODES.INVALID_ASSIGN_LHS,
				message: 'Left-hand side of assignment must be a variable',
				range: mkRange(doc, t.start, t.end),
				severity: DiagnosticSeverity.Error
			});
		}
	}
}

function collectCall(
	doc: TextDocument,
	tokens: Token[],
	i: number,
	defs: Defs,
	diagnostics: Diag[],
	calls: { name: string; args: number; range: Range; argRanges: Range[] }[]
) {
	const nameTok = tokens[i];
	if (!nameTok) return;
	// count args by commas until matching ')'
	let j = i + 2; // skip name and '('
	let depth = 1; // paren depth
	let bDepth = 0; // bracket [] depth
	let cDepth = 0; // brace {} depth
	let vDepth = 0; // angle <> depth for vector/rotation literals
	let args = 0;
	let sawValue = false; // have we seen any non-delimiter tokens for current arg at depth 1?
	let argStartOff: number | null = null;
	const argRanges: Range[] = [];
	let lastTokAtDepth1: Token | null = null;
	while (j < tokens.length && depth > 0) {
		const t = tokens[j++];
		if (t.value === '(') { if (depth === 1) { sawValue = true; if (argStartOff === null) argStartOff = t.start; lastTokAtDepth1 = t; } depth++; continue; }
		if (t.value === ')') { depth--; continue; }
		// Track list/vector literals and blocks so inner commas don't count as arg separators
		if (t.value === '[') { if (depth === 1 && bDepth === 0) { sawValue = true; if (argStartOff === null) argStartOff = t.start; lastTokAtDepth1 = t; } bDepth++; continue; }
		if (t.value === ']') { if (bDepth > 0) bDepth--; continue; }
		if (t.value === '{') { if (depth === 1 && cDepth === 0) { sawValue = true; if (argStartOff === null) argStartOff = t.start; lastTokAtDepth1 = t; } cDepth++; continue; }
		if (t.value === '}') { if (cDepth > 0) cDepth--; continue; }
		// Vector/rotation literals: <a,b,c> or <a,b,c,d>
		if (t.value === '<') { if (depth === 1 && vDepth === 0) { sawValue = true; if (argStartOff === null) argStartOff = t.start; lastTokAtDepth1 = t; } vDepth++; continue; }
		if (t.value === '>') { if (vDepth > 0) vDepth--; continue; }
		if (depth === 1) {
			if (t.value === ',' && bDepth === 0 && cDepth === 0 && vDepth === 0) {
				// close current arg
				if (sawValue && argStartOff !== null) {
					const endOff = (lastTokAtDepth1 ?? tokens[j - 2])?.end ?? t.start;
					argRanges.push({ start: doc.positionAt(argStartOff), end: doc.positionAt(endOff) });
				}
				args++; sawValue = false; argStartOff = null; lastTokAtDepth1 = null; continue; }
			// Any non-delimiter token at depth 1 counts toward having a value
			if (t.kind !== 'punc' || (t.value !== ',' && t.value !== ')')) { sawValue = true; if (argStartOff === null) argStartOff = t.start; lastTokAtDepth1 = t; }
		}
	}
	// If there were any arguments (non-empty), args = commas+1
	const endTok = tokens[j - 1] || nameTok;
	const span = { start: doc.positionAt(nameTok.start), end: doc.positionAt(endTok.end) };
	if (sawValue && argStartOff !== null) {
		const endOff = (lastTokAtDepth1 ?? endTok).end;
		argRanges.push({ start: doc.positionAt(argStartOff), end: doc.positionAt(endOff) });
	}
	calls.push({ name: nameTok.value, args: args + (sawValue ? 1 : 0), range: span, argRanges });
}

function arityMatches(fn: DefFunction, args: number): boolean {
	const min = fn.params.filter(p => p.default === undefined).length;
	const max = fn.params.length;
	return args >= min && args <= max;
}

// Very small type inference for expressions inside an arg range
function inferExprType(doc: TextDocument, tokens: Token[], range: Range): string {
	const startOff = doc.offsetAt(range.start);
	const endOff = doc.offsetAt(range.end);
	// Find tokens in range
	const slice = tokens.filter(t => t.start >= startOff && t.end <= endOff);
	if (slice.length === 0) return 'any';
	// Simple cases by first token
	const t0 = slice[0];
	if (t0.kind === 'str') return 'string';
	if (t0.kind === 'num') {
		// Heuristic: numbers default to integer unless decimal point present
		return /\./.test(t0.value) ? 'float' : 'integer';
	}
	if (t0.value === '<') return 'vector';
	if (t0.value === '[') return 'list';
	if (t0.kind === 'id') {
		// Member access: <expr> . x|y|z|s -> float
		const prevTokIndex = tokens.findIndex(t => t.start === t0.start && t.end === t0.end) - 1;
		if (prevTokIndex >= 1 && tokens[prevTokIndex]?.value === '.') {
			const mem = t0.value;
			if (mem === 'x' || mem === 'y' || mem === 'z' || mem === 's') return 'float';
		}
		// Type keywords used as cast: integer(...)
		// If used as a literal constant (TRUE/FALSE), map to integer per LSL
		const v = t0.value;
		if (v === 'TRUE' || v === 'FALSE') return 'integer';
		// Common null key literal
		if (v === 'NULL_KEY') return 'key';
		// If looks like a string/list/vector constructor via cast, we could inspect next '(' but keep simple
		// Unknown id → any
		return 'any';
	}
	return 'any';
}

function typeMatches(expected: string, got: string): boolean {
	expected = normalizeType(expected);
	got = normalizeType(got);
	if (expected === 'any' || got === 'any') return true;
	if (expected === got) return true;
	// Weak coercions in LSL:
	// - integer can accept float literals (will truncate)
	if (expected === 'integer' && got === 'float') return true;
	// - float parameters commonly accept integer literals
	if (expected === 'float' && got === 'integer') return true;
	return false;
}

// Lightweight control-flow: does a block starting at tokens[openIndex]=="{" always return on all paths?
// Heuristic: returns true if we encounter an unconditional 'return;' at top-level or
// if we see an if (...) { ... } else { ... } where both sub-blocks always return.
function blockAlwaysReturns(tokens: Token[], openIndex: number): boolean {
	// tokens[openIndex] must be '{'
	if (tokens[openIndex]?.value !== '{') return false;
	let i = openIndex + 1;
	let depth = 1;
	while (i < tokens.length && depth > 0) {
		const t = tokens[i];
		if (!t) break;
		// Top-level inside this block only when depth === 1
		if (depth === 1 && t.kind === 'id' && t.value === 'return') {
			return true; // unconditional return at top-level
		}
		// Recognize if (...) { ... } else { ... } at top-level
		if (depth === 1 && t.kind === 'id' && t.value === 'if') {
			// scan condition to closing ')'
			i++; // consume 'if'
			if (tokens[i]?.value === '(') {
				let pd = 1; i++;
				while (i < tokens.length && pd > 0) {
					const c = tokens[i++];
					if (c.value === '(') pd++; else if (c.value === ')') pd--;
				}
				// expect then-block
				if (tokens[i]?.value === '{') {
					const thenOpen = i;
					// jump to end of then block
					let bd = 1; i++;
					while (i < tokens.length && bd > 0) {
						const c = tokens[i++];
						if (c.value === '{') bd++; else if (c.value === '}') bd--;
					}
					// optional else
					// skip whitespace/punc tokens until non-punc? Our lexer classifies keywords/ids/nums/str; others are punc by value
					// We can directly look for 'else' id
					let j = i;
					while (j < tokens.length && tokens[j].kind !== 'id' && tokens[j].value !== 'else' && tokens[j].value !== '{' && tokens[j].value !== '}') j++;
					if (tokens[j]?.kind === 'id' && tokens[j].value === 'else') {
						j++;
						if (tokens[j]?.value === '{') {
							const elseOpen = j;
							// Evaluate recursively: both then and else must always return
							const thenAlways = blockAlwaysReturns(tokens, thenOpen);
							const elseAlways = blockAlwaysReturns(tokens, elseOpen);
							if (thenAlways && elseAlways) return true;
							// continue scanning after else block end
							let ed = 1; j++;
							while (j < tokens.length && ed > 0) {
								const c = tokens[j++];
								if (c.value === '{') ed++; else if (c.value === '}') ed--;
							}
							i = j; continue;
						}
					}
					// if without else: cannot guarantee return on all paths; continue scanning
					continue;
				}
			}
		}
		// brace tracking
		if (t.value === '{') { depth++; }
		else if (t.value === '}') { depth--; }
		i++;
	}
	return false;
}
