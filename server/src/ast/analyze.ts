import { TextDocument } from 'vscode-languageserver-textdocument';
import { DiagnosticSeverity, Range } from 'vscode-languageserver/node';
import type { Defs } from '../defs';
import type { PreprocResult } from '../preproc';
import { Script, Expr, Function as AstFunction, State as AstState, spanToRange, isType as isLslType, TYPES } from './index';
import { validateOperatorsFromAst } from '../op_validate_ast';
import type { SimpleType } from './infer';
import { inferExprTypeFromAst } from './infer';
import { normalizeType } from '../defs';
import { AssertNever } from '../utils';

// Reuse Analysis/Diag types from the parser module
import type { Analysis, Diag, Decl } from '../analysisTypes';
import { LSL_DIAGCODES } from '../analysisTypes';

type Scope = { parent?: Scope; vars: Map<string, Decl> };

export function analyzeAst(doc: TextDocument, script: Script, defs: Defs, pre: PreprocResult): Analysis {
	const diagnostics: Diag[] = [];
	const decls: Analysis['decls'] = [];
	const refs: Analysis['refs'] = [];
	const refTargets = new Map<number, Decl>();
	const calls: Analysis['calls'] = [];
	const states = new Map<string, Analysis['decls'][number]>();
	const functions = new Map<string, Analysis['decls'][number]>();
	const globalDecls: Decl[] = [];

	// Fallback: scan resolved include files directly when pre.includeSymbols lacks entries for them.
	// Extracts typed function headers, [const ]typed globals, and object-like macros.
	type FallbackSymbols = { functions: Map<string, { returns: SimpleType; params: SimpleType[] }>; globals: Set<string>; macros: Set<string> };
	const fallbackByFile = new Map<string, FallbackSymbols>();
	const fallbackFuncs = new Set<string>();
	const fallbackGlobals = new Set<string>();
	const fallbackMacros = new Set<string>();
	try {
		const fs = require('node:fs') as typeof import('node:fs');
		const knownTypes = new Set<string>([...TYPES, 'quaternion'].map(t => String(t)));
		const toSimple = (t: string): SimpleType => {
			const nt = normalizeType(t);
			return (knownTypes.has(nt) ? (nt as SimpleType) : 'any') as SimpleType;
		};
		for (const it of pre.includeTargets || []) {
			if (!it.resolved) continue;
			const already = pre.includeSymbols?.get(it.resolved);
			const needsFallback = !already || (already.functions.size === 0 && already.globals.size === 0 && already.macroObjs.size === 0 && already.macroFuncs.size === 0);
			if (!needsFallback) continue;
			try {
				const text = fs.readFileSync(it.resolved, 'utf8');
				const lines = text.split(/\r?\n/);
				const out: FallbackSymbols = { functions: new Map(), globals: new Set(), macros: new Set() };
				let braceDepth = 0;
				for (let i = 0; i < lines.length; i++) {
					let L = lines[i];
					// strip line comments to stabilize matching
					L = L.replace(/\/\/.*$/, '');
					// macros: object-like only
					{
						const m = /^\s*#\s*define\s+([A-Za-z_]\w*)(?!\s*\()\b/.exec(L);
						if (m) { const name = m[1]; out.macros.add(name); continue; }
					}
					if (braceDepth === 0) {
						// const/typed globals
						const g = /^\s*(?:const\s+)?([A-Za-z_]\w+)\s+([A-Za-z_]\w+)\s*(?:=|;)/.exec(L);
						if (g) {
							const t = normalizeType(g[1]);
							if (knownTypes.has(t)) out.globals.add(g[2]);
						}
						// typed function headers: <type> <name>(params) [;|{|EOL]
						const f = /^\s*([A-Za-z_]\w+)\s+([A-Za-z_]\w*)\s*\(([^)]*)\)\s*(?:[{;]|$)/.exec(L);
						if (f) {
							const ret = normalizeType(f[1]);
							if (knownTypes.has(ret)) {
								const name = f[2];
								const params: SimpleType[] = [];
								const raw = (f[3] || '').trim();
								if (raw.length > 0) {
									for (const piece of raw.split(',')) {
										const p = piece.trim().replace(/\s+/g, ' ');
										const parts = p.split(' ');
										params.push(toSimple(parts[0] || 'any'));
									}
								}
								out.functions.set(name, { returns: toSimple(ret), params });
							}
						}
					}
					// update brace depth
					for (let k = 0; k < L.length; k++) { const ch = L[k]; if (ch === '{') braceDepth++; else if (ch === '}') braceDepth = Math.max(0, braceDepth - 1); }
				}
				fallbackByFile.set(it.resolved, out);
				for (const n of out.functions.keys()) fallbackFuncs.add(n);
				for (const n of out.globals.values()) fallbackGlobals.add(n);
				for (const n of out.macros.values()) fallbackMacros.add(n);
			} catch { /* ignore single include errors */ }
		}
	} catch { /* fs not available (e.g., browser) */ }

	// Track identifier usage within the current function/event body for unused diagnostics
	type UsageContext = {
		usedParamNames: Set<string>;
		usedLocalNames: Set<string>;
		paramDecls: Decl[];
		localDecls: Decl[];
	};
	const usageStack: UsageContext[] = [];

	// Helper: reserved identifiers are 'event' plus any keyword or type in defs
	const isReserved = (defs: Defs | null | undefined, name: string): boolean => {
		if (!defs) return false;
		if (name === 'event') return true;
		return defs.keywords.has(name) || defs.types.has(name);
	};

	// Convert AST diagnostics into LSP diagnostics (these are also surfaced by the server separately)
	for (const d of script.diagnostics || []) {
		diagnostics.push({
			code: (d.code as any) || LSL_DIAGCODES.SYNTAX,
			message: d.message,
			range: spanToRange(doc, d.span),
			severity: d.severity === 'warning' ? DiagnosticSeverity.Warning : d.severity === 'info' ? DiagnosticSeverity.Information : DiagnosticSeverity.Error,
		});
	}

	// Build decls for globals, functions, and states/events
	const globalScope: Scope = { vars: new Map() };

	// Helper: find the identifier range for a given name inside a node's span
	// If headerOnly is true, search only up to the first '{' to avoid matching inside bodies
	function findNameRangeInSpan(name: string, span: { start: number; end: number }, headerOnly = false): Range {
		const fullRange = spanToRange(doc, span as any);
		const startOff = doc.offsetAt(fullRange.start);
		const endOff = doc.offsetAt(fullRange.end);
		let slice = doc.getText().slice(startOff, endOff);
		if (headerOnly) {
			const braceIdx = slice.indexOf('{');
			if (braceIdx >= 0) slice = slice.slice(0, braceIdx);
		}
		// word-boundary match for the identifier
		const re = new RegExp(`\\b${name.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&')}\\b`);
		const m = re.exec(slice);
		if (m) {
			const s = startOff + (m.index as number);
			return { start: doc.positionAt(s), end: doc.positionAt(s + name.length) };
		}
		// Fallback to the full span if not found
		return fullRange;
	}

	// Type scopes provide scoped SimpleType lookups for operator/type validation
	type TypeScope = { parent?: TypeScope; types: Map<string, SimpleType>; view: Map<string, SimpleType> };
	const pushTypeScope = (parent?: TypeScope): TypeScope => ({ parent, types: new Map(), view: new Map(parent ? parent.view : undefined) });
	const addType = (ts: TypeScope, name: string, type: string | undefined) => {
		const nt = type ? normalizeType(type) : 'any';
		const simple: SimpleType = isLslType(nt) ? (nt as SimpleType) : 'any';
		ts.types.set(name, simple);
		ts.view.set(name, simple);
	};

	// Globals
	for (const [name, g] of script.globals) {
		// Reserved identifier check for global variables
		if (isReserved(defs, name)) {
			diagnostics.push({
				code: LSL_DIAGCODES.RESERVED_IDENTIFIER,
				message: `"${name}" is reserved and cannot be used as an identifier`,
				range: spanToRange(doc, g.span),
				severity: DiagnosticSeverity.Error,
			});
		}
		const d: Decl = { name, range: findNameRangeInSpan(name, g.span, true), kind: 'var', type: g.varType };
		decls.push(d);
		globalDecls.push(d);
		globalScope.vars.set(name, d);
	}
	// Global type scope seeded with globals
	const globalTypeScope: TypeScope = pushTypeScope();
	for (const [name, g] of script.globals) addType(globalTypeScope, name, g.varType);
	// Functions
	for (const [name, f] of script.functions) {
		// Reserved identifier check for function names
		if (isReserved(defs, name)) {
			diagnostics.push({
				code: LSL_DIAGCODES.RESERVED_IDENTIFIER,
				message: `"${name}" is reserved and cannot be used as an identifier`,
				range: spanToRange(doc, f.span),
				severity: DiagnosticSeverity.Error,
			});
		}
		const d: Decl = { name, range: findNameRangeInSpan(name, f.span, true), kind: 'func', type: (f.returnType as any) ?? undefined, params: [] };
		// Enrich with full/header/body ranges
		try {
			const fullR = spanToRange(doc, f.span);
			const fullText = doc.getText().slice(doc.offsetAt(fullR.start), doc.offsetAt(fullR.end));
			const braceIdx = fullText.indexOf('{');
			const headerEndOff = braceIdx >= 0 ? (doc.offsetAt(fullR.start) + braceIdx) : doc.offsetAt(fullR.start);
			const headerRange = { start: fullR.start, end: doc.positionAt(headerEndOff) };
			const bodyRange = braceIdx >= 0 ? { start: doc.positionAt(headerEndOff), end: fullR.end } : undefined;
			d.fullRange = fullR; d.headerRange = headerRange; d.bodyRange = bodyRange;
		} catch { /* ignore */ }
		// Parameter decls are tracked for scope during walk
		for (const [pname, ptype] of f.parameters) d.params!.push({ name: pname, type: ptype });
		decls.push(d); functions.set(name, d);
	}
	// States + events
	for (const [name, st] of script.states) {
		const d: Decl = { name, range: findNameRangeInSpan(name, st.span, true), kind: 'state' };
		// Enrich with ranges for the state block
		try {
			const fullR = spanToRange(doc, st.span);
			const fullText = doc.getText().slice(doc.offsetAt(fullR.start), doc.offsetAt(fullR.end));
			const braceIdx = fullText.indexOf('{');
			const headerEndOff = braceIdx >= 0 ? (doc.offsetAt(fullR.start) + braceIdx) : doc.offsetAt(fullR.start);
			const headerRange = { start: fullR.start, end: doc.positionAt(headerEndOff) };
			const bodyRange = braceIdx >= 0 ? { start: doc.positionAt(headerEndOff), end: fullR.end } : undefined;
			d.fullRange = fullR; d.headerRange = headerRange; d.bodyRange = bodyRange;
		} catch { /* ignore */ }
		decls.push(d); states.set(name, d);
		for (const ev of st.events) {
			const evDecl: Decl = { name: ev.name, range: findNameRangeInSpan(ev.name, ev.span, true), kind: 'event', params: [...ev.parameters].map(([n, t]) => ({ name: n, type: t })) } as any;
			// Ranges for event declaration
			try {
				const fullR = spanToRange(doc, ev.span);
				const fullText = doc.getText().slice(doc.offsetAt(fullR.start), doc.offsetAt(fullR.end));
				const braceIdx = fullText.indexOf('{');
				const headerEndOff = braceIdx >= 0 ? (doc.offsetAt(fullR.start) + braceIdx) : doc.offsetAt(fullR.start);
				const headerRange = { start: fullR.start, end: doc.positionAt(headerEndOff) };
				const bodyRange = braceIdx >= 0 ? { start: doc.positionAt(headerEndOff), end: fullR.end } : undefined;
				(evDecl as any).fullRange = fullR; (evDecl as any).headerRange = headerRange; (evDecl as any).bodyRange = bodyRange;
			} catch { /* ignore */ }
			decls.push(evDecl);
		}
	}

	// Events declared outside any state are not captured in script.states; detect by a simple text scan fallback
	// Heuristic tightened to reduce false positives in header-like include files.
	// - Skip this check for files that look like headers (path contains "/include/" or common include guards like #pragma once / #ifndef INCLUDE_)
	// - Match only real event handler definitions: "eventName(type name, ...) {" (no return type before), not mere prototypes/macros
	if (script.states.size === 0) {
		const text: string = (doc as any).getText ? (doc as any).getText() : '';
		const uri: string = (doc as any).uri || '';
		const startsWithPreproc = /^[\s\r\n]*#/.test(text);
		const headerLike = /\/include\//.test(uri)
			|| /^[ \t]*#pragma\s+once/m.test(text)
			|| /^[ \t]*#ifndef\s+INCLUDE_/m.test(text)
			|| startsWithPreproc; // common include guards or header-style first line
		if (!headerLike) {
			// Require: start-of-line identifier (event name), parameter list with typed params (type + name), then an opening brace
			// This avoids matching function definitions (which have a return type before the name) and avoids simple macros.
			// Build the type alternation from central TYPES list
			const typeRe = `(?:${TYPES.join('|')})`;
			const paramRe = `${typeRe}\\s+[A-Za-z_][A-Za-z0-9_]*`;
			const sigRe = new RegExp(`^[\\t ]*[A-Za-z_][A-Za-z0-9_]*\\s*\\(\\s*${paramRe}(?:\\s*,\\s*${paramRe})*\\s*\\)\\s*\\{`, 'm');
			if (sigRe.test(text)) {
				diagnostics.push({
					code: LSL_DIAGCODES.EVENT_OUTSIDE_STATE,
					message: 'Event must be declared inside a state',
					range: { start: doc.positionAt(0), end: doc.positionAt(Math.min(1, text.length)) },
					severity: DiagnosticSeverity.Error,
				});
			}
		}
	}

	// Walk bodies to collect refs/calls and local decls
	// We'll validate operators with scoped type information using TypeScope

	function addRef(name: string, range: Range, scope: Scope) {
		refs.push({ name, range });
		// Resolve to nearest declaration in scope chain and record mapping
		const decl = resolveInScope(name, scope);
		if (decl) {
			const off = doc.offsetAt(range.start);
			refTargets.set(off, decl);
			// Bump usage in the current usage context if applicable
			const top = usageStack[usageStack.length - 1];
			if (top) {
				if (decl.kind === 'param') top.usedParamNames.add(decl.name);
				else if (decl.kind === 'var') top.usedLocalNames.add(decl.name);
			}
		}
	}

	function resolveInScope(name: string, scope: Scope | undefined): Decl | null {
		let s: Scope | undefined = scope;
		while (s) {
			const d = s.vars.get(name);
			if (d) return d;
			s = s.parent;
		}
		// Fallback: global function or state names
		if (functions.has(name)) return functions.get(name)!;
		if (states.has(name)) return states.get(name)!;
		return null;
	}

	function walkExpr(e: Expr | null, scope: Scope, typeScope: TypeScope) {
		if (!e) return;
		switch (e.kind) {
			case 'StringLiteral':
			case 'NumberLiteral': {
				// literals don't contribute refs
				break;
			}
			case 'ErrorExpr': {
				// nothing to do
				break;
			}
			case 'Identifier': {
				// record ref; unknown identifier diagnostics if not known symbol/keyword/const/type
				addRef(e.name, spanToRange(doc, e.span), scope);
				const known = resolveInScope(e.name, scope)
					|| defs.consts.has(e.name)
					|| defs.types.has(e.name)
					|| defs.keywords.has(e.name)
					|| defs.funcs.has(e.name)
					|| (pre.includeSymbols && Array.from(pre.includeSymbols.values()).some(s =>
						s.functions.has(e.name) || s.globals.has(e.name) || s.macroObjs.has(e.name) || s.macroFuncs.has(e.name)
					))
					|| fallbackFuncs.has(e.name)
					|| fallbackGlobals.has(e.name)
					|| fallbackMacros.has(e.name);
				if (!known) {
					diagnostics.push({
						code: LSL_DIAGCODES.UNKNOWN_IDENTIFIER,
						message: `Unknown identifier ${e.name}`,
						range: spanToRange(doc, e.span),
						severity: DiagnosticSeverity.Error,
					});
				}
				break;
			}
			case 'Call': {
				// record call for callee id
				if (e.callee.kind === 'Identifier') {
					const start = spanToRange(doc, e.callee.span).start;
					const end = spanToRange(doc, e.span).end;
					// Very rough arg range split: use argument spans
					const argRanges = e.args.map(a => spanToRange(doc, a.span));
					const calleeName = e.callee.name;
					calls.push({ name: calleeName, args: e.args.length, range: { start, end }, argRanges });
					addRef(calleeName, spanToRange(doc, e.callee.span), scope);
					// Unknown callee identifier check (builtin/defs or includeSymbols or local function)
					const known = resolveInScope(calleeName, scope)
						|| defs.funcs.has(calleeName)
						|| (pre.includeSymbols && Array.from(pre.includeSymbols.values()).some(s => s.functions.has(calleeName) || s.macroFuncs.has(calleeName)))
						|| fallbackFuncs.has(calleeName)
						|| defs.consts.has(calleeName) // tolerate accidental const call as known id for better downstream type error
						|| defs.types.has(calleeName)	 // likewise for types
						|| defs.keywords.has(calleeName);
					if (!known) {
						diagnostics.push({
							code: LSL_DIAGCODES.UNKNOWN_IDENTIFIER,
							message: `Unknown identifier ${calleeName}`,
							range: spanToRange(doc, e.callee.span),
							severity: DiagnosticSeverity.Error,
						});
					}
				} else {
					walkExpr(e.callee, scope, typeScope);
				}
				e.args.forEach(a => walkExpr(a, scope, typeScope));
				break;
			}
			case 'Binary': walkExpr(e.left, scope, typeScope); walkExpr(e.right, scope, typeScope); break;
			case 'Unary': walkExpr(e.argument, scope, typeScope); break;
			case 'Member': walkExpr(e.object, scope, typeScope); break;
			case 'Cast': walkExpr(e.argument, scope, typeScope); break;
			case 'ListLiteral': e.elements.forEach((x: Expr) => walkExpr(x, scope, typeScope)); break;
			case 'VectorLiteral': e.elements.forEach((x: Expr) => walkExpr(x, scope, typeScope)); break;
			case 'Paren': walkExpr(e.expression, scope, typeScope); break;
			default:
				AssertNever(e as never, 'Unhandled Expr kind in analyzeAst.walkExpr');
				break;
		}
	}

	function pushScope(s: Scope): Scope { return { parent: s, vars: new Map() }; }

	function visitFunction(fn: AstFunction) {
		const scope = pushScope(globalScope);
		const ts = pushTypeScope(globalTypeScope);
		const returnType = (fn.returnType ?? 'void') as string;
		// Set up usage tracking for this function body
		const ctx: UsageContext = { usedParamNames: new Set(), usedLocalNames: new Set(), paramDecls: [], localDecls: [] };
		usageStack.push(ctx);
		for (const [pname, ptype] of fn.parameters) {
			// Reserved identifier check for parameter names
			if (isReserved(defs, pname)) {
				diagnostics.push({
					code: LSL_DIAGCODES.RESERVED_IDENTIFIER,
					message: `"${pname}" is reserved and cannot be used as an identifier`,
					range: spanToRange(doc, fn.span),
					severity: DiagnosticSeverity.Error,
				});
			}
			// Parameter declaration: find the identifier inside the function header before the opening brace
			const span = spanToRange(doc, fn.span);
			const full = doc.getText().slice(doc.offsetAt(span.start), doc.offsetAt(span.end));
			const headerOnly = (() => { const b = full.indexOf('{'); return b >= 0 ? full.slice(0, b) : full; })();
			const m = new RegExp(`\\b${pname}\\b`).exec(headerOnly);
			const startOff = m ? (doc.offsetAt(span.start) + (m.index as number)) : doc.offsetAt(span.start);
			const d: Decl = { name: pname, range: { start: doc.positionAt(startOff), end: doc.positionAt(startOff + pname.length) }, kind: 'param', type: ptype };
			decls.push(d);
			scope.vars.set(pname, d);
			addType(ts, pname, ptype);
			ctx.paramDecls.push(d);
		}
		// Collect returns and compute simple all-paths-return for top-level body
		const returns: { expr?: Expr; span: { start: number; end: number } }[] = [];
		function scanReturns(stmt: any) {
			if (!stmt) return;
			switch (stmt.kind) {
				case 'ReturnStmt': returns.push({ expr: stmt.expression, span: stmt.span }); break;
				case 'BlockStmt': for (const s of stmt.statements) scanReturns(s); break;
				case 'IfStmt': scanReturns(stmt.then); if (stmt.else) scanReturns(stmt.else); break;
				case 'WhileStmt': scanReturns(stmt.body); break;
				case 'DoWhileStmt': scanReturns(stmt.body); break;
				case 'ForStmt': scanReturns(stmt.body); break;
				default: break;
			}
		}
		// helper: does this statement guarantee a return along all paths?
		function allPathsReturn(stmt: any): boolean {
			if (!stmt) return false;
			switch (stmt.kind) {
				case 'ReturnStmt': return true;
				case 'BlockStmt': {
					if (stmt.statements.length === 0) return false;
					const last = stmt.statements[stmt.statements.length - 1];
					return allPathsReturn(last);
				}
				case 'IfStmt': {
					if (!stmt.else) return false;
					return allPathsReturn(stmt.then) && allPathsReturn(stmt.else);
				}
				case 'WhileStmt':
				case 'DoWhileStmt':
				case 'ForStmt':
					// loops don't guarantee a return without analysis; assume false
					return false;
				default: return false;
			}
		}
		// Empty function body check (LSL025)
		if (fn.body && fn.body.kind === 'BlockStmt' && fn.body.statements.length === 0) {
			diagnostics.push({ code: LSL_DIAGCODES.EMPTY_FUNCTION_BODY, message: 'Empty function body is not allowed', range: spanToRange(doc, fn.span), severity: DiagnosticSeverity.Error });
		}
		visitStmt(fn.body, scope, ts);
		scanReturns(fn.body);
		if (returnType === 'void') {
			for (const r of returns) {
				if (r.expr) {
					diagnostics.push({ code: LSL_DIAGCODES.RETURN_IN_VOID, message: 'Returning a value in a void function', range: spanToRange(doc, r.span as any), severity: DiagnosticSeverity.Warning });
				}
			}
		} else {
			for (const r of returns) {
				const t = r.expr ? normalizeType(inferTypeOf(r.expr, ts)) : 'void';
				if (r.expr && !typesCompatible((returnType as any), t)) {
					diagnostics.push({ code: LSL_DIAGCODES.RETURN_WRONG_TYPE, message: `Function ${fn.name} returns ${returnType} but returning ${t}`, range: spanToRange(doc, r.span as any), severity: DiagnosticSeverity.Error });
				}
			}
			const guaranteed = allPathsReturn(fn.body);
			if (!guaranteed) {
				diagnostics.push({ code: LSL_DIAGCODES.MISSING_RETURN, message: `Missing return in function ${fn.name} returning ${returnType}` , range: spanToRange(doc, fn.span), severity: DiagnosticSeverity.Error });
			}
		}
		// After analyzing the function body, emit unused diagnostics for params and locals
		// Honor block-based suppression that overlaps the function body (even if param decl is outside the block span)
		const dd = pre.diagDirectives;
		const bodyStartOffset = doc.offsetAt(spanToRange(doc, fn.body.span).start);
		const bodyEndOffset = doc.offsetAt(spanToRange(doc, fn.body.span).end);
		const blockSuppresses = (code: string) => !!dd && dd.blocks.some(b => b.end >= bodyStartOffset && b.start <= bodyEndOffset && (!b.codes || b.codes.has(code)));
		for (const pd of ctx.paramDecls) {
			const isUnderscore = pd.name.startsWith('_');
			const used = ctx.usedParamNames.has(pd.name);
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
				if (blockSuppresses(LSL_DIAGCODES.UNUSED_PARAM)) { /* suppressed within function-body block */ }
				else {
					diagnostics.push({ code: LSL_DIAGCODES.UNUSED_PARAM, message: `Unused parameter "${pd.name}"`, range: pd.range, severity: DiagnosticSeverity.Hint });
				}
			}
		}
		for (const ld of ctx.localDecls) {
			if (!ctx.usedLocalNames.has(ld.name)) {
				if (blockSuppresses(LSL_DIAGCODES.UNUSED_LOCAL)) { /* suppressed within function-body block */ }
				else diagnostics.push({ code: LSL_DIAGCODES.UNUSED_LOCAL, message: `Unused local variable "${ld.name}"`, range: ld.range, severity: DiagnosticSeverity.Hint });
			}
		}
		usageStack.pop();
	}

	function inferTypeOf(e: Expr, typeScope: any): string {
		// Use direct import to work in both test and build environments
		return inferExprTypeFromAst(e, typeScope.view) as string;
	}

	function typesCompatible(expected: string, got: string): boolean {
		const e = normalizeType(expected); const g = normalizeType(got);
		if (e === g) return true;
		if ((e === 'integer' && g === 'float') || (e === 'float' && g === 'integer')) return true;
		if (g === 'any') return true;
		return false;
	}

	function visitState(st: AstState) {
		const scope = pushScope(globalScope);
		const tsState = pushTypeScope(globalTypeScope);
		// Duplicate event names within the same state
		const evNames = new Set<string>();
		for (const ev of st.events) {
			if (evNames.has(ev.name)) {
				diagnostics.push({ code: LSL_DIAGCODES.DUPLICATE_DECL, message: `Duplicate declaration of event ${ev.name}`, range: spanToRange(doc, ev.span), severity: DiagnosticSeverity.Error });
			} else evNames.add(ev.name);
			const evScope = pushScope(scope);
			const tsEvent = pushTypeScope(tsState);
			const ctx: UsageContext = { usedParamNames: new Set(), usedLocalNames: new Set(), paramDecls: [], localDecls: [] };
			usageStack.push(ctx);
			// Strict event validations against defs
			const evDef = defs.events.get(ev.name);
			if (!evDef) {
				diagnostics.push({
					code: LSL_DIAGCODES.UNKNOWN_EVENT,
					message: `Unknown event ${ev.name}`,
					range: spanToRange(doc, ev.span),
					severity: DiagnosticSeverity.Error,
				});
			} else {
				const actualParams = [...ev.parameters];
				const expectedParams = evDef.params || [];
				if (actualParams.length !== expectedParams.length) {
					diagnostics.push({
						code: LSL_DIAGCODES.WRONG_ARITY,
						message: `Event ${ev.name} expects ${expectedParams.length} parameter(s), got ${actualParams.length}`,
						range: spanToRange(doc, ev.span),
						severity: DiagnosticSeverity.Error,
					});
				} else {
					for (let i = 0; i < expectedParams.length; i++) {
						const [_pname, ptype] = actualParams[i]!;
						const expType = normalizeType(expectedParams[i]!.type);
						const gotType = normalizeType(ptype);
						if (expType !== gotType) {
							diagnostics.push({
								code: LSL_DIAGCODES.WRONG_TYPE,
								message: `Event ${ev.name} parameter ${i + 1} expects ${expType}, got ${gotType}`,
								range: spanToRange(doc, ev.span),
								severity: DiagnosticSeverity.Error,
							});
						}
					}
				}
			}
			for (const [pname, ptype] of ev.parameters) {
				// Reserved identifier check for event parameter names
				if (isReserved(defs, pname)) {
					diagnostics.push({
						code: LSL_DIAGCODES.RESERVED_IDENTIFIER,
						message: `"${pname}" is reserved and cannot be used as an identifier`,
						range: spanToRange(doc, ev.span),
						severity: DiagnosticSeverity.Error,
					});
				}
				// Parameter declaration: find the identifier inside the event header before the opening brace
				const span = spanToRange(doc, ev.span);
				const full = doc.getText().slice(doc.offsetAt(span.start), doc.offsetAt(span.end));
				const headerOnly = (() => { const b = full.indexOf('{'); return b >= 0 ? full.slice(0, b) : full; })();
				const m = new RegExp(`\\b${pname}\\b`).exec(headerOnly);
				const startOff = m ? (doc.offsetAt(span.start) + (m.index as number)) : doc.offsetAt(span.start);
				const d: Decl = { name: pname, range: { start: doc.positionAt(startOff), end: doc.positionAt(startOff + pname.length) }, kind: 'param', type: ptype };
				evScope.vars.set(pname, d);
				decls.push(d);
				addType(tsEvent, pname, ptype);
				ctx.paramDecls.push(d);
			}
			// Empty event body check (LSL024)
			if (ev.body && ev.body.kind === 'BlockStmt' && ev.body.statements.length === 0) {
				diagnostics.push({ code: LSL_DIAGCODES.EMPTY_EVENT_BODY, message: 'Empty event body is not allowed', range: spanToRange(doc, ev.span), severity: DiagnosticSeverity.Error });
			}
			visitStmt(ev.body, evScope, tsEvent);
			// Emit unused diagnostics for this event
			// Honor block-based suppression that overlaps the event body
			const dd = pre.diagDirectives;
			const bodyStartOffset = doc.offsetAt(spanToRange(doc, ev.body.span).start);
			const bodyEndOffset = doc.offsetAt(spanToRange(doc, ev.body.span).end);
			const blockSuppresses = (code: string) => !!dd && dd.blocks.some(b => b.end >= bodyStartOffset && b.start <= bodyEndOffset && (!b.codes || b.codes.has(code)));
			for (const pd of ctx.paramDecls) {
				const isUnderscore = pd.name.startsWith('_');
				const used = ctx.usedParamNames.has(pd.name);
				if (isUnderscore) {
					if (used) {
						diagnostics.push({ code: LSL_DIAGCODES.UNDERSCORE_PARAM_USED, message: `Parameter "${pd.name}" is underscore-prefixed but is used`, range: pd.range, severity: DiagnosticSeverity.Warning });
					}
				} else if (!used) {
					if (blockSuppresses(LSL_DIAGCODES.UNUSED_PARAM)) { /* suppressed within event-body block */ }
					else diagnostics.push({ code: LSL_DIAGCODES.UNUSED_PARAM, message: `Unused parameter "${pd.name}"`, range: pd.range, severity: DiagnosticSeverity.Hint });
				}
			}
			for (const ld of ctx.localDecls) {
				if (!ctx.usedLocalNames.has(ld.name)) {
					if (blockSuppresses(LSL_DIAGCODES.UNUSED_LOCAL)) { /* suppressed within event-body block */ }
					else diagnostics.push({ code: LSL_DIAGCODES.UNUSED_LOCAL, message: `Unused local variable "${ld.name}"`, range: ld.range, severity: DiagnosticSeverity.Hint });
				}
			}
			usageStack.pop();
		}
	}

	function validateExpr(expr: Expr | null, typeScope: TypeScope) {
		if (!expr) return;
		validateOperatorsFromAst(doc, [expr], diagnostics, typeScope.view, functionReturnTypes, callSignatures);
	}

	function visitStmt(stmt: any, scope: Scope, typeScope: TypeScope) {
		if (!stmt) return;
		switch (stmt.kind) {
			case 'BlockStmt': {
				// Dead code detection within a block: if a terminating stmt is followed by another stmt on the same line
				// Also detect duplicate local declarations in the same block
				const localNames = new Set<string>();
				for (let i = 0; i < stmt.statements.length; i++) {
					const s = stmt.statements[i];
					visitStmt(s, scope, typeScope);
					if (s && s.kind === 'VarDecl') {
						if (localNames.has(s.name)) {
							diagnostics.push({ code: LSL_DIAGCODES.DUPLICATE_DECL, message: `Duplicate declaration of ${s.name}`, range: spanToRange(doc, s.span), severity: DiagnosticSeverity.Error });
						} else localNames.add(s.name);
					}
					const isTerm = s && (s.kind === 'ReturnStmt' || s.kind === 'StateChangeStmt' || s.kind === 'JumpStmt');
					if (!isTerm) continue;
					const next = stmt.statements[i + 1];
					if (!next) continue;
					// same line?
					const sEnd = spanToRange(doc, s.span).end;
					const nStart = spanToRange(doc, next.span).start;
					if (sEnd.line === nStart.line) {
						diagnostics.push({ code: LSL_DIAGCODES.DEAD_CODE, message: 'Unreachable code after terminating statement on the same line', range: { start: sEnd, end: nStart }, severity: DiagnosticSeverity.Warning });
					}
				}
				break;
			}
			case 'ExprStmt': walkExpr(stmt.expression, scope, typeScope); validateExpr(stmt.expression, typeScope); break;
			case 'EmptyStmt': break;
			case 'ErrorStmt': break;
			case 'LabelStmt': break;
			case 'JumpStmt': walkExpr(stmt.target, scope, typeScope); validateExpr(stmt.target, typeScope); break;
			case 'VarDecl': {
				const name = stmt.name; const type = stmt.varType;
				// Reserved identifier check for local variable names
				if (isReserved(defs, name)) {
					diagnostics.push({
						code: LSL_DIAGCODES.RESERVED_IDENTIFIER,
						message: `"${name}" is reserved and cannot be used as an identifier`,
						range: spanToRange(doc, stmt.span),
						severity: DiagnosticSeverity.Error,
					});
				}
				const d: Decl = { name, range: findNameRangeInSpan(name, stmt.span, false), kind: 'var', type };
				scope.vars.set(name, d);
				decls.push(d);
				// Track local decl for unused checks when inside a body
				const top = usageStack[usageStack.length - 1];
				if (top) top.localDecls.push(d);
				if (stmt.initializer) { walkExpr(stmt.initializer, scope, typeScope); validateExpr(stmt.initializer, typeScope); }
				addType(typeScope, name, type);
				break;
			}
			case 'ReturnStmt': walkExpr(stmt.expression || null, scope, typeScope); validateExpr(stmt.expression || null, typeScope); break;
			case 'IfStmt': {
				walkExpr(stmt.condition, scope, typeScope);
				// Validate condition with suspicious-assignment flag; other expressions validated normally
				validateOperatorsFromAst(doc, [stmt.condition], diagnostics, typeScope.view, functionReturnTypes, callSignatures, { flagSuspiciousAssignment: true });
				visitStmt(stmt.then, scope, typeScope);
				if (stmt.else) visitStmt(stmt.else, scope, typeScope);
				break;
			}
			case 'WhileStmt': {
				walkExpr(stmt.condition, scope, typeScope);
				validateOperatorsFromAst(doc, [stmt.condition], diagnostics, typeScope.view, functionReturnTypes, callSignatures, { flagSuspiciousAssignment: true });
				visitStmt(stmt.body, scope, typeScope);
				break;
			}
			case 'DoWhileStmt': {
				visitStmt(stmt.body, scope, typeScope);
				walkExpr(stmt.condition, scope, typeScope);
				validateOperatorsFromAst(doc, [stmt.condition], diagnostics, typeScope.view, functionReturnTypes, callSignatures, { flagSuspiciousAssignment: true });
				break;
			}
			case 'ForStmt': {
				walkExpr(stmt.init, scope, typeScope); validateExpr(stmt.init, typeScope);
				walkExpr(stmt.condition, scope, typeScope);
				validateOperatorsFromAst(doc, [stmt.condition], diagnostics, typeScope.view, functionReturnTypes, callSignatures, { flagSuspiciousAssignment: true });
				walkExpr(stmt.update, scope, typeScope); validateExpr(stmt.update, typeScope);
				visitStmt(stmt.body, scope, typeScope);
				break;
			}
			case 'StateChangeStmt': {
				// Only allowed inside event handlers; not in functions or global scope
				// Detect: if there is no event scope ancestor, then it's illegal
				const inEvent = isWithinEventScope(scope);
				if (!inEvent) {
					diagnostics.push({ code: LSL_DIAGCODES.ILLEGAL_STATE_CHANGE, message: 'State change statements are only allowed inside event handlers', range: spanToRange(doc, stmt.span), severity: DiagnosticSeverity.Error });
				}
				// Unknown state target
				if (!states.has(stmt.state) && stmt.state !== 'default') {
					diagnostics.push({ code: LSL_DIAGCODES.UNKNOWN_STATE, message: `Unknown state ${stmt.state}`, range: spanToRange(doc, stmt.span), severity: DiagnosticSeverity.Error });
				}
				break;
			}
			default:
				AssertNever(stmt as never, 'Unhandled Stmt kind in analyzeAst.visitStmt');
				break;
		}
		// After handling the statement, emit empty-structure diagnostics for if/else with empty bodies
		if (stmt.kind === 'IfStmt') {
			const thenIsEmptyStmt = stmt.then && stmt.then.kind === 'EmptyStmt';
			const thenEmptyBlock = stmt.then && stmt.then.kind === 'BlockStmt' && stmt.then.statements.length === 0;
			if (thenIsEmptyStmt || thenEmptyBlock) diagnostics.push({ code: LSL_DIAGCODES.EMPTY_IF_BODY, message: 'Empty if-body is not allowed', range: spanToRange(doc, stmt.then.span), severity: DiagnosticSeverity.Error });
			if (stmt.else) {
				const elseIsEmptyStmt = stmt.else && stmt.else.kind === 'EmptyStmt';
				const elseEmptyBlock = stmt.else && stmt.else.kind === 'BlockStmt' && stmt.else.statements.length === 0;
				if (elseIsEmptyStmt || elseEmptyBlock) diagnostics.push({ code: LSL_DIAGCODES.EMPTY_ELSE_BODY, message: 'Empty else-body is not allowed', range: spanToRange(doc, stmt.else.span), severity: DiagnosticSeverity.Error });
			}
		}
		// Dead code detection: if next statement starts on same line after a terminating stmt (return/state-change/jump)
		const term = (s: any) => s && (s.kind === 'ReturnStmt' || s.kind === 'StateChangeStmt' || s.kind === 'JumpStmt');
		if (term(stmt)) {
			// We don't have direct access to following tokens here; approximate by comparing end line of this stmt to start line of next sibling within a containing block.
			// This check is best-effort: actual parser already slices spans including semicolons, so next sibling starting on same line can be detected at block visit.
		}
	}

	// Override BlockStmt visiting to emit DEAD_CODE when two consecutive statements share a line and the first is terminating.
	const _visitStmt = visitStmt; // not used; staying inline in switch

	function isWithinEventScope(scope: Scope): boolean {
		// Heuristic: event parameters are declared as kind 'param' inside visitState; if any param exists in current scope but not in parent function scope, we're in event
		let s: Scope | undefined = scope;
		while (s && s !== globalScope) {
			// If there exists a variable that came from an event parameter marker, consider true; fallback to functions map not present
			// We don't tag scope type explicitly; approximate by existence of any decl named like known event params in this scope
			if (s !== globalScope && s.vars.size > 0) {
				for (const d of s.vars.values()) { if (d.kind === 'param') return true; }
			}
			s = s.parent;
		}
		return false;
	}

	// Build functionReturnTypes and callSignatures from defs (and include symbols if available)
	const functionReturnTypes = new Map<string, SimpleType>();
	const callSignatures = new Map<string, SimpleType[][]>();
	const toSimpleType = (type: string): SimpleType => {
		const nt = normalizeType(type);
		if (nt === 'void') return 'void';
		return isLslType(nt) ? (nt as SimpleType) : 'any';
	};
	for (const [name, overloads] of defs.funcs) {
		for (const f of overloads) {
			if (f && f.returns) {
				functionReturnTypes.set(name, toSimpleType(f.returns));
			}
			const params = (f.params || []).map(p => toSimpleType(p.type || 'any'));
			const prev = callSignatures.get(name) || []; prev.push(params); callSignatures.set(name, prev);
		}
	}

	// Add user-defined function signatures from the script itself
	for (const [name, f] of script.functions) {
		const params = [...f.parameters].map(([, t]) => toSimpleType(t));
		const prev = callSignatures.get(name) || [];
		prev.push(params);
		callSignatures.set(name, prev);
		// Return type
		const r = toSimpleType((f.returnType as any) || 'void');
		functionReturnTypes.set(name, r);
		// no separate void set needed; we record 'void' in functionReturnTypes
	}
	// Include-provided functions
	if (pre.includeSymbols && pre.includeSymbols.size > 0) {
		// Build quick lookup for local script-level declarations
		const localFuncNames = new Set<string>([...script.functions.keys()]);
		const localGlobalNames = new Set<string>([...script.globals.keys()]);
		// Helper to map an include file path to this doc's include directive range
		const rangeForIncludeFile = (file: string): Range => {
			const hit = (pre.includeTargets || []).find(it => it.resolved === file) || (pre.includeTargets || [])[0];
			if (hit) return { start: doc.positionAt(hit.start), end: doc.positionAt(hit.end) };
			// Fallback to start of document if no include directive was recorded (shouldn't happen)
			return { start: doc.positionAt(0), end: doc.positionAt(0) };
		};
		for (const [file, info] of pre.includeSymbols.entries()) {
			for (const [name, fn] of info.functions) {
				// If this function already exists in built-in defs or is defined in the current script,
				// report a duplicate declaration error at the include site and do not import the signature.
				if (defs.funcs.has(name) || localFuncNames.has(name)) {
					const where = rangeForIncludeFile((info as any).file || '');
					diagnostics.push({
						code: LSL_DIAGCODES.DUPLICATE_DECL,
						message: `Duplicate declaration of function ${name} from include` + (defs.funcs.has(name) ? ' (conflicts with built-in)' : ' (conflicts with local function)'),
						range: where,
						severity: DiagnosticSeverity.Error,
					});
					// Do not add this include signature to callSignatures
					continue;
				}
				if (!functionReturnTypes.has(name)) functionReturnTypes.set(name, toSimpleType(fn.returns));
				const params = (fn.params || []).map(p => toSimpleType(p.type || 'any'));
				const prev = callSignatures.get(name) || []; prev.push(params); callSignatures.set(name, prev);
			}
			// Detect duplicate globals from includes conflicting with script globals or built-in constants/types
			for (const [gname] of info.globals) {
				if (localGlobalNames.has(gname) || defs.consts.has(gname) || defs.types.has(gname) || defs.keywords.has(gname)) {
					const where = rangeForIncludeFile(file);
					diagnostics.push({
						code: LSL_DIAGCODES.DUPLICATE_DECL,
						message: `Duplicate declaration of global ${gname} from include`,
						range: where,
						severity: DiagnosticSeverity.Error,
					});
				}
			}
			// Detect duplicate states from includes conflicting with locally-declared states
			if (info.states && info.states.size > 0) {
				for (const stName of info.states) {
					if (states.has(stName)) {
						const where = rangeForIncludeFile(file);
						diagnostics.push({
							code: LSL_DIAGCODES.DUPLICATE_DECL,
							message: `Duplicate declaration of state ${stName} from include`,
							range: where,
							severity: DiagnosticSeverity.Error,
						});
					}
				}
			}
		}
	}

	// Fallback: augment callSignatures/return types with functions discovered directly in include files
	for (const sym of fallbackByFile.values()) {
		for (const [name, meta] of sym.functions) {
			if (!callSignatures.has(name)) callSignatures.set(name, [meta.params]);
			else { const prev = callSignatures.get(name)!; prev.push(meta.params); }
			if (!functionReturnTypes.has(name)) functionReturnTypes.set(name, meta.returns);
		}
	}

	// Validate global initializers with global scope types
	for (const [, g] of script.globals) {
		if (g.initializer) {
			// Walk the initializer to record refs and surface UNKNOWN_IDENTIFIER, then validate operators/types
			walkExpr(g.initializer as any, globalScope, globalTypeScope);
			validateOperatorsFromAst(doc, [g.initializer], diagnostics, globalTypeScope.view, functionReturnTypes, callSignatures);
		}
	}

	// Walk functions and states once, validating expressions inline
	for (const [, f] of script.functions) visitFunction(f);
	for (const [, s] of script.states) visitState(s);

	// Unused globals: globals that are never referenced anywhere
	if (globalDecls.length > 0) {
		// Build a set of used names from refs mapped to decls
		const usedDecls = new Set<Decl>();
		for (const [off, d] of refTargets) { void off; usedDecls.add(d); }
		for (const gd of globalDecls) {
			if (!usedDecls.has(gd)) {
				diagnostics.push({ code: LSL_DIAGCODES.UNUSED_VAR, message: `Unused variable ${gd.name}`, range: gd.range, severity: DiagnosticSeverity.Hint });
			}
		}
	}

	// Apply diagnostic suppression directives
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

	// Helper to prefer the smallest matching declaration at a position, with ranking by kind
	function pickBestDeclAt(offset: number): Decl | null {
		let best: Decl | null = null;
		let bestSize = Number.MAX_SAFE_INTEGER;
		const rank = (k: Decl['kind']) => k === 'param' ? 1 : k === 'var' ? 2 : k === 'event' ? 3 : k === 'func' ? 4 : 5;
		for (const d of decls) {
			const s = doc.offsetAt(d.range.start), e = doc.offsetAt(d.range.end);
			if (offset >= s && offset <= e) {
				const size = e - s;
				if (size < bestSize || (size === bestSize && best && rank(d.kind) < rank(best.kind))) {
					best = d; bestSize = size;
				}
			}
		}
		return best;
	}

	return {
		diagnostics: finalDiagnostics,
		decls,
		refs,
		calls,
		states,
		functions,
		symbolAt(offset: number) {
			return pickBestDeclAt(offset);
		},
		refAt(offset: number) {
			if (refTargets.has(offset)) return refTargets.get(offset)!;
			return null;
		}
	};
}
