import { TextDocument } from 'vscode-languageserver-textdocument';
import { DiagnosticSeverity, Range } from 'vscode-languageserver/node';
import type { Defs } from '../defs';
import type { PreprocResult } from '../core/preproc';
import { Script, Expr, Function as AstFunction, State as AstState, spanToRange, isType as isLslType, Stmt } from './index';
import { validateOperatorsFromAst } from '../op_validate_ast';
import type { SimpleType } from './infer';
import { inferExprTypeFromAst } from './infer';
import { normalizeType } from '../defs';
import { AssertNever } from '../utils';
import type { Analysis, Diag, Decl } from '../analysisTypes';
import { LSL_DIAGCODES } from '../analysisTypes';
import type { DiagCode } from '../analysisTypes';
import { isKeyword } from './lexer';
import { Token } from '../core/tokens';

// Scope now carries a lightweight kind tag to distinguish event/function contexts
type Scope = { parent?: Scope; vars: Map<string, Decl>; kind?: 'event' | 'func' | 'state' | 'global' | 'block' };

export function analyzeAst(doc: TextDocument, script: Script, defs: Defs, pre: PreprocResult): Analysis {
	const diagnostics: Diag[] = [];
	// Merge parser diagnostics (previously only available on Script) into analysis diagnostics so
	// downstream tests that inspect analysis.diagnostics see syntax/duplicate/state errors emitted
	// during parsing (e.g. LSL070 duplicate globals/functions, LSL022 illegal state decls, missing
	// semicolons, unterminated comments). Earlier refactor unified preprocessing+parsing but dropped
	// this merge causing multiple diagnostics-based tests to fail. We map parser spans to Ranges here.
	try {
		if (script.diagnostics && script.diagnostics.length) {
			for (const pd of script.diagnostics) {
				const range = spanToRange(doc, pd.span);
				// Map parser severity strings (if any) to LSP DiagnosticSeverity; default to Error.
				let severity: DiagnosticSeverity = DiagnosticSeverity.Error;
				if (pd.severity === 'warning') severity = DiagnosticSeverity.Warning;
				else if (pd.severity === 'info') severity = DiagnosticSeverity.Information;
				// Coerce parser code (string) into known DiagCode union; fallback to SYNTAX.
				const allCodes = LSL_DIAGCODES as Record<string, string>;
				const values: string[] = Object.values(allCodes);
				const code = (pd.code && values.includes(pd.code)) ? pd.code as typeof values[number] : LSL_DIAGCODES.SYNTAX;
				// Only push if not already present (avoid double-reporting in rare cases where analyzer re-emits)
				if (!diagnostics.some(d => d.code === code && d.range.start.line === range.start.line && d.range.start.character === range.start.character && d.message === pd.message)) {
					const diagCode = code as DiagCode;
					diagnostics.push({ code: diagCode, message: pd.message, range, severity });
				}
			}
		}
	} catch { /* best effort merge; ignore errors */ }
	const decls: Analysis['decls'] = [];
	const refs: Analysis['refs'] = [];
	const refTargets = new Map<number, Decl>();
	const calls: Analysis['calls'] = [];
	// Populated after collecting top-level declarations
	const states = new Map<string, Analysis['decls'][number]>();
	const functions = new Map<string, Analysis['decls'][number]>();
	const globalDecls: Decl[] = [];

	// Collect names of parameters used by function-like macros so we can avoid
	// flagging them as unknown identifiers if any leak into the token stream.
	// This is a pragmatic safeguard for SDKs that use leading-underscore macro
	// parameters (e.g. _section) and for imperfect tooling paths.
	const macroParamNames = new Set<string>();
	try {
		const src = pre.funcMacros || {} as Record<string, string>;
		for (const body of Object.values(src)) {
			if (typeof body !== 'string') continue;
			const open = body.indexOf('(');
			const close = body.indexOf(')');
			if (open >= 0 && close > open) {
				const paramsRaw = body.slice(open + 1, close);
				for (const p of paramsRaw.split(',')) {
					const name = p.trim();
					// Ignore varargs tokens and empty entries
					if (!name || name === '...' || name === '__VA_ARGS__') continue;
					// Keep only identifier-like names
					if (/^[A-Za-z_]\w*$/.test(name)) macroParamNames.add(name);
				}
			}
		}
	} catch { /* ignore */ }

	// ---------------- Missing helper structures (reconstructed after accidental file corruption) ----------------
	// Type scope used by operator/type validation helpers
	type TypeScope = { parent?: TypeScope; view: Map<string, SimpleType> };
	function pushTypeScope(parent?: TypeScope): TypeScope { return { parent, view: new Map<string, SimpleType>() }; }
	function addType(scope: TypeScope, name: string, type: string) { scope.view.set(name, normalizeType(type) as SimpleType); }
	// Global (file) scope for variables/functions/states
	const globalScope: Scope = { vars: new Map(), kind: 'global' };
	const globalTypeScope: TypeScope = pushTypeScope();
	// Fallback symbol sets (used when scanning expanded tokens for include-provided decls)
	const fallbackFuncs = new Set<string>();
	const fallbackGlobals = new Set<string>();
	const fallbackMacros = new Set<string>();
	const mustUseFunctions = new Set<string>();
	for (const [name, overloads] of defs.funcs) {
		if (overloads && overloads.some(f => f?.mustUse)) {
			mustUseFunctions.add(name);
		}
	}
	const isMustUseFunction = (name: string): boolean => mustUseFunctions.has(name);
	// Usage tracking for unused param/local diagnostics
	type UsageContext = { usedParamNames: Set<string>; usedLocalNames: Set<string>; paramDecls: Decl[]; localDecls: Decl[] };
	const usageStack: UsageContext[] = [];
	// Reserved identifiers: anything colliding with builtin keywords/types/funcs/events/consts
	function isReserved(defs: Defs, name: string): boolean {
		try { if (process.env.LSL_DEBUG_RESERVED) console.log('[isReserved-debug]', name); } catch {/*ignore*/}
		// NOTE: The identifier "event" is not itself an event handler name present in defs.events;
		// it is nevertheless a reserved word in LSL and must be disallowed as a user identifier.
		// Older logic special-cased this; during refactor the special-case was dropped causing
		// tests expecting a reserved diagnostic for a variable named "event" to fail. We restore it here.
		return isKeyword(name) || defs.funcs.has(name) || defs.events.has(name) || defs.consts.has(name);
	}
	// Find the name occurrence range within a span; if preferHeader is true, only search before '{'
	function findNameRangeInSpan(name: string, span: { start: number; end: number }, preferHeader: boolean): Range {
		const r = spanToRange(doc, span);
		try {
			let slice = doc.getText().slice(doc.offsetAt(r.start), doc.offsetAt(r.end));
			if (preferHeader) {
				const b = slice.indexOf('{');
				if (b >= 0) slice = slice.slice(0, b);
			}
			const re = new RegExp(`\\b${name.replace(/[-\\^$*+?.()|[\]{}]/g, '\\$&')}\\b`);
			const m = re.exec(slice);
			if (m) {
				const startOff = doc.offsetAt(r.start) + m.index;
				return { start: doc.positionAt(startOff), end: doc.positionAt(startOff + name.length) };
			}
		} catch { /* ignore */ }
		return { start: r.start, end: r.start }; // fallback
	}
	// Track label declarations within the current function/event body (for validating jump targets)
	let currentLabels: Set<string> | null = null;
	function collectLabels(stmt: Stmt | null): Set<string> {
		const labels = new Set<string>();
		function visit(s: Stmt | null) {
			if (!s) return;
			switch (s.kind) {
				case 'BlockStmt': for (const ch of s.statements) visit(ch); break;
				case 'IfStmt': visit(s.then); if (s.else) visit(s.else); break;
				case 'WhileStmt': visit(s.body); break;
				case 'DoWhileStmt': visit(s.body); break;
				case 'ForStmt': visit(s.body); break;
				case 'LabelStmt': labels.add(s.name); break;
				default: break;
			}
		}
		visit(stmt);
		return labels;
	}

	// Events declared outside any state are not captured in script.states; detect by a simple text scan fallback
	// Heuristic tightened to reduce false positives in header-like include files.
	// - Skip this check for files that look like headers (path contains "/include/" or common include guards like #pragma once / #ifndef INCLUDE_)
	// - Match only real event handler definitions: "eventName(type name, ...) {" (no return type before), not mere prototypes/macros
	if (script.states.size === 0) {
		const text: string = doc.getText ? doc.getText() : '';
		const uri: string = doc.uri || '';
		const startsWithPreproc = /^[\s\r\n]*#/.test(text);
		const headerLike = /\/include\//.test(uri)
			|| /^[ \t]*#pragma\s+once/m.test(text)
			|| /^[ \t]*#ifndef\s+INCLUDE_/m.test(text)
			|| startsWithPreproc; // common include guards or header-style first line
		if (!headerLike) {
			// Only consider actual LSL event names at start-of-line
			const eventNames = Array.from(defs.events.keys());
			if (eventNames.length > 0) {
				const namesRe = eventNames.map(n => n.replace(/[-\\^$*+?.()|[\]{}]/g, '\\$&')).join('|');
				const sigRe = new RegExp(`^[\\t ]*(?:${namesRe})\\s*\\(`, 'm');
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

	function walkExpr(e: Expr | null, scope: Scope, typeScope: TypeScope, valueUsed = true) {
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
					|| isKeyword(e.name)
					|| defs.funcs.has(e.name)
					|| (pre.macros && Object.prototype.hasOwnProperty.call(pre.macros, e.name))
					|| (pre.funcMacros && Object.prototype.hasOwnProperty.call(pre.funcMacros, e.name))
					|| fallbackFuncs.has(e.name)
					|| fallbackGlobals.has(e.name)
					|| fallbackMacros.has(e.name)
					// Accept lowercase booleans as known identifiers (treated as constants) to reduce noise
					|| e.name === 'true' || e.name === 'false'
					// Suppress diagnostics for identifiers that match macro parameter names
					|| macroParamNames.has(e.name);
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
					if (!valueUsed && isMustUseFunction(calleeName)) {
						diagnostics.push({
							code: LSL_DIAGCODES.MUST_USE_RESULT,
							message: `Result of ${calleeName}() must be used`,
							range: spanToRange(doc, e.span),
							severity: DiagnosticSeverity.Warning,
						});
					}
					calls.push({ name: calleeName, args: e.args.length, range: { start, end }, argRanges });
					addRef(calleeName, spanToRange(doc, e.callee.span), scope);
					const known = resolveInScope(calleeName, scope)
						|| defs.funcs.has(calleeName)
						|| (pre.funcMacros && Object.prototype.hasOwnProperty.call(pre.funcMacros, calleeName))
						|| (pre.macros && Object.prototype.hasOwnProperty.call(pre.macros, calleeName))
						|| fallbackFuncs.has(calleeName)
						|| defs.consts.has(calleeName) // tolerate accidental const call as known id for better downstream type error
						|| isKeyword(calleeName);
					if (!known) {
						diagnostics.push({
							code: LSL_DIAGCODES.UNKNOWN_IDENTIFIER,
							message: `Unknown identifier ${calleeName}`,
							range: spanToRange(doc, e.callee.span),
							severity: DiagnosticSeverity.Error,
						});
					}
				} else {
					walkExpr(e.callee, scope, typeScope, true);
				}
				e.args.forEach(a => walkExpr(a, scope, typeScope, true));
				break;
			}
			case 'Binary': walkExpr(e.left, scope, typeScope, true); walkExpr(e.right, scope, typeScope, true); break;
			case 'Unary': walkExpr(e.argument, scope, typeScope, true); break;
			case 'Member': walkExpr(e.object, scope, typeScope, true); break;
			case 'Cast': walkExpr(e.argument, scope, typeScope, valueUsed); break;
			case 'ListLiteral': e.elements.forEach((x: Expr) => walkExpr(x, scope, typeScope, true)); break;
			case 'VectorLiteral': e.elements.forEach((x: Expr) => walkExpr(x, scope, typeScope, true)); break;
			case 'Paren': walkExpr(e.expression, scope, typeScope, valueUsed); break;
			default:
				AssertNever(e as never, 'Unhandled Expr kind in analyzeAst.walkExpr');
				break;
		}
	}

	function pushScope(s: Scope, kind?: Scope['kind']): Scope { return { parent: s, vars: new Map(), kind }; }

	function visitFunction(fn: AstFunction) {
		const scope = pushScope(globalScope, 'func');
		const ts = pushTypeScope(globalTypeScope);
		const returnType = (fn.returnType ?? 'void') as string;
		// Collect all labels in this function body so jump targets can be validated without unknown-identifier noise
		const savedLabels = currentLabels;
		currentLabels = collectLabels(fn.body);
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
		function scanReturns(stmt: Stmt) {
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
		function allPathsReturn(stmt: Stmt): boolean {
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
				case 'WhileStmt': {
					const b = stmt.body;
					if (b && b.kind === 'BlockStmt' && b.statements.length > 0) {
						const last = b.statements[b.statements.length - 1];
						if (last && last.kind === 'ReturnStmt') return true;
					}
					return false;
				}
				case 'DoWhileStmt': {
					const b = stmt.body;
					if (b && b.kind === 'BlockStmt' && b.statements.length > 0) {
						const last = b.statements[b.statements.length - 1];
						if (last && last.kind === 'ReturnStmt') return true;
					}
					return false;
				}
				case 'ForStmt': {
					const fb = stmt.body;
					if (fb && fb.kind === 'BlockStmt' && fb.statements.length > 0) {
						const last = fb.statements[fb.statements.length - 1];
						if (last && last.kind === 'ReturnStmt') return true;
					}
					return false;
				}
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
					diagnostics.push({ code: LSL_DIAGCODES.RETURN_IN_VOID, message: 'Returning a value in a void function', range: spanToRange(doc, r.span), severity: DiagnosticSeverity.Warning });
				}
			}
		} else {
			for (const r of returns) {
				const t = r.expr ? normalizeType(inferTypeOf(r.expr, ts)) : 'void';
				if (r.expr && !typesCompatible(returnType, t)) {
					diagnostics.push({ code: LSL_DIAGCODES.RETURN_WRONG_TYPE, message: `Function ${fn.name} returns ${returnType} but returning ${t}`, range: spanToRange(doc, r.span), severity: DiagnosticSeverity.Error });
				}
			}
			const guaranteed = allPathsReturn(fn.body);
			if (!guaranteed) {
				diagnostics.push({ code: LSL_DIAGCODES.MISSING_RETURN, message: `Missing return in function ${fn.name} returning ${returnType}`, range: spanToRange(doc, fn.span), severity: DiagnosticSeverity.Error });
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
		currentLabels = savedLabels;
	}

	type TypeScopeView = { view: Map<string, SimpleType> | ReadonlyMap<string, SimpleType> };
	function inferTypeOf(e: Expr, typeScope: TypeScopeView): string {
		// Use direct import to work in both test and build environments
		const v = typeScope.view as Map<string, SimpleType>;
		return inferExprTypeFromAst(e, v) as string;
	}

	function typesCompatible(expected: string, got: string): boolean {
		const e = normalizeType(expected); const g = normalizeType(got);
		if (e === g) return true;
		if ((e === 'integer' && g === 'float') || (e === 'float' && g === 'integer')) return true;
		if (g === 'any') return true;
		return false;
	}

	function visitState(st: AstState) {
		const scope = pushScope(globalScope, 'state');
		const tsState = pushTypeScope(globalTypeScope);
		// Duplicate event names within the same state
		const evNames = new Set<string>();
		for (const ev of st.events) {
			if (evNames.has(ev.name)) {
				diagnostics.push({ code: LSL_DIAGCODES.DUPLICATE_DECL, message: `Duplicate declaration of event ${ev.name}`, range: spanToRange(doc, ev.span), severity: DiagnosticSeverity.Error });
			} else evNames.add(ev.name);
			const evScope = pushScope(scope, 'event');
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
			// Collect labels for this event body
			const savedLabels = currentLabels;
			currentLabels = collectLabels(ev.body);
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
			currentLabels = savedLabels;
		}
	}

	function validateExpr(expr: Expr | null, typeScope: TypeScope) {
		if (!expr) return;
		validateOperatorsFromAst(doc, [expr], diagnostics, typeScope.view, functionReturnTypes, callSignatures);
	}

	function visitStmt(stmt: Stmt | null, scope: Scope, typeScope: TypeScope) {
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
			case 'ExprStmt': walkExpr(stmt.expression, scope, typeScope, false); validateExpr(stmt.expression, typeScope); break;
			case 'EmptyStmt': break;
			case 'ErrorStmt': break;
			case 'LabelStmt': break;
			case 'JumpStmt': {
				// Validate jump target against collected labels within the same function/event body.
				const t = stmt.target;
				if (t && t.kind === 'Identifier') {
					const name = t.name;
					// If label is not known in current body, flag unknown identifier; otherwise, do nothing.
					if (!currentLabels || !currentLabels.has(name)) {
						diagnostics.push({ code: LSL_DIAGCODES.UNKNOWN_IDENTIFIER, message: `Unknown identifier ${name}`, range: spanToRange(doc, t.span), severity: DiagnosticSeverity.Error });
					}
				}
				// Do not walk/validate the target as an expression to avoid spurious identifier diagnostics.
				break;
			}
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
				if (stmt.init) { walkExpr(stmt.init, scope, typeScope, false); validateExpr(stmt.init, typeScope); }
				if (stmt.condition) {
					walkExpr(stmt.condition, scope, typeScope);
					validateOperatorsFromAst(doc, [stmt.condition], diagnostics, typeScope.view, functionReturnTypes, callSignatures, { flagSuspiciousAssignment: true });
				}
				if (stmt.update) { walkExpr(stmt.update, scope, typeScope, false); validateExpr(stmt.update, typeScope); }
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
		const term = (s: Stmt | null) => s && (s.kind === 'ReturnStmt' || s.kind === 'StateChangeStmt' || s.kind === 'JumpStmt');
		if (term(stmt)) {
			// We don't have direct access to following tokens here; approximate by comparing end line of this stmt to start line of next sibling within a containing block.
			// This check is best-effort: actual parser already slices spans including semicolons, so next sibling starting on same line can be detected at block visit.
		}
	}

	// Override BlockStmt visiting to emit DEAD_CODE when two consecutive statements share a line and the first is terminating.
	const _visitStmt = visitStmt; // not used; staying inline in switch

	function isWithinEventScope(scope: Scope): boolean {
		// Walk up scope chain and look for an explicitly tagged 'event' scope
		let s: Scope | undefined = scope;
		while (s) {
			if (s.kind === 'event') return true;
			if (!s.parent) break;
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
		const r = toSimpleType(f.returnType || 'void');
		functionReturnTypes.set(name, r);
		// no separate void set needed; we record 'void' in functionReturnTypes
	}

	// Validate global initializers with global scope types
	for (const [, g] of script.globals) {
		// Create a declaration entry for each user global (was previously missing)
		const name = g.name;
		// TEMP DEBUG: log global name for reserved identifier investigation
		try { if (process.env.LSL_DEBUG_RESERVED) console.log('[analyze-debug] global', name); } catch { /* ignore */ }
		// Reserved identifier check for global variable names
		if (isReserved(defs, name)) {
			diagnostics.push({
				code: LSL_DIAGCODES.RESERVED_IDENTIFIER,
				message: `"${name}" is reserved and cannot be used as an identifier`,
				range: spanToRange(doc, g.span),
				severity: DiagnosticSeverity.Error,
			});
		}
		const range = findNameRangeInSpan(name, g.span, false);
		const d: Decl = { name, range, kind: 'var', type: g.varType };
		decls.push(d);
		globalDecls.push(d);
		globalScope.vars.set(name, d);
		addType(globalTypeScope, name, g.varType);
		if (g.initializer) {
			walkExpr(g.initializer, globalScope, globalTypeScope);
			validateOperatorsFromAst(doc, [g.initializer], diagnostics, globalTypeScope.view, functionReturnTypes, callSignatures);
		}
	}

	// Collect function/state/event declarations up-front so later analysis (refs, state-change validity) can resolve them.
	// Functions
	for (const [, f] of script.functions) {
		const name = f.name;
		if (isReserved(defs, name)) {
			diagnostics.push({
				code: LSL_DIAGCODES.RESERVED_IDENTIFIER,
				message: `"${name}" is reserved and cannot be used as an identifier`,
				range: spanToRange(doc, f.span),
				severity: DiagnosticSeverity.Error,
			});
		}
		const nameRange = findNameRangeInSpan(name, f.span, true);
		// Derive header/body ranges (best effort)
		const fullRange = spanToRange(doc, f.span);
		let headerRange = fullRange; let bodyRange = fullRange;
		try {
			const text = doc.getText().slice(doc.offsetAt(fullRange.start), doc.offsetAt(fullRange.end));
			const braceIdx = text.indexOf('{');
			if (braceIdx >= 0) {
				headerRange = { start: fullRange.start, end: doc.positionAt(doc.offsetAt(fullRange.start) + braceIdx) };
				const closeOff = doc.offsetAt(fullRange.end);
				bodyRange = { start: doc.positionAt(doc.offsetAt(fullRange.start) + braceIdx), end: fullRange.end };
				void closeOff; // silence unused var if not used
			}
		} catch { /* ignore header/body extraction errors */ }
		const params = [...f.parameters].map(([pname, ptype]) => ({ name: pname, type: ptype }));
		const d: Decl = { name, range: nameRange, kind: 'func', type: f.returnType || 'void', params, fullRange, headerRange, bodyRange };
		decls.push(d);
		functions.set(name, d);
		globalScope.vars.set(name, d); // allow forward reference resolution within file
	}

	// States + events
	for (const [, st] of script.states) {
		const sName = st.name;
		const sRange = findNameRangeInSpan(sName, st.span, true);
		const sFull = spanToRange(doc, st.span);
		let sHeader = sFull; let sBody = sFull;
		try {
			const text = doc.getText().slice(doc.offsetAt(sFull.start), doc.offsetAt(sFull.end));
			const braceIdx = text.indexOf('{');
			if (braceIdx >= 0) {
				sHeader = { start: sFull.start, end: doc.positionAt(doc.offsetAt(sFull.start) + braceIdx) };
				sBody = { start: sHeader.end, end: sFull.end };
			}
		} catch { /* ignore */ }
		const sd: Decl = { name: sName, range: sRange, kind: 'state', fullRange: sFull, headerRange: sHeader, bodyRange: sBody };
		decls.push(sd);
		states.set(sName, sd);
		// Events within the state
		for (const ev of st.events) {
			const eName = ev.name;
			const eRange = findNameRangeInSpan(eName, ev.span, true);
			const eFull = spanToRange(doc, ev.span);
			let eHeader = eFull; let eBody = eFull;
			try {
				const text = doc.getText().slice(doc.offsetAt(eFull.start), doc.offsetAt(eFull.end));
				const braceIdx = text.indexOf('{');
				if (braceIdx >= 0) {
					eHeader = { start: eFull.start, end: doc.positionAt(doc.offsetAt(eFull.start) + braceIdx) };
					eBody = { start: eHeader.end, end: eFull.end };
				}
			} catch { /* ignore */ }
			const params = [...ev.parameters].map(([pname, ptype]) => ({ name: pname, type: ptype }));
			const ed: Decl = { name: eName, range: eRange, kind: 'event', params, fullRange: eFull, headerRange: eHeader, bodyRange: eBody };
			decls.push(ed);
		}
	}

	// Walk functions and states once, validating expressions inline
	// BEFORE walking functions we may need to synthesize declarations coming from included headers
	// that the parser ignored (e.g. function prototypes and global variable declarations ending with ';').
	// Map include file -> range of its #include directive in root doc for better diagnostic ranges.
	const includeRangeByFile = new Map<string, { start: ReturnType<typeof doc.positionAt>; end: ReturnType<typeof doc.positionAt> }>();
	try {
		const targets = pre.includeTargets as undefined | { start: number; end: number; file: string; resolved: string | null }[];
		if (targets) for (const t of targets) { const r = { start: doc.positionAt(t.start), end: doc.positionAt(t.end) }; if (t.resolved) includeRangeByFile.set(t.resolved, r); includeRangeByFile.set(t.file, r); }
	} catch { /* ignore */ }

	try {
		const expandedEarly = pre.expandedTokens as unknown as Token[] | undefined;
		if (expandedEarly && expandedEarly.length) {
			let primaryFsPath: string | undefined; try { const u = (doc.uri.startsWith('file://') ? require('vscode-uri').URI.parse(doc.uri).fsPath : undefined); primaryFsPath = u; } catch { /* ignore */ }
			// Current declared names
			const declaredFuncNames = new Set<string>(); for (const d of decls) if (d.kind === 'func') declaredFuncNames.add(d.name);
			const declaredVarNames = new Set<string>(); for (const d of decls) if (d.kind === 'var') declaredVarNames.add(d.name);
			// Builtin functions so we don't synthesize decls for them
			const builtinFuncNames = new Set<string>(); for (const [name] of defs.funcs) builtinFuncNames.add(name);
			// Simple pattern scan
			for (let i = 0; i < expandedEarly.length; i++) {
				const t = expandedEarly[i]!;
				const anyT = t as Token & { originFile?: string; file?: string };
				const origin = anyT.originFile || anyT.file;
				if (!origin || (primaryFsPath && origin === primaryFsPath)) {
					continue; // only includes
				}
				// Ignore tokens originating from includes that are clearly within a state body when scanning prototypes/globals
				if (t.kind === 'keyword' && t.value === 'state') { // skip ahead to matching closing brace to avoid noise
					let depthBr = 0; let k = i + 1; let entered = false;
					while (k < expandedEarly.length) {
						const tk = expandedEarly[k]!;
						if ((tk.kind === 'punct' || tk.kind === 'op') && tk.value === '{') { depthBr++; entered = true; }
						else if ((tk.kind === 'punct' || tk.kind === 'op') && tk.value === '}') { depthBr--; if (entered && depthBr <= 0) { i = k; break; } }
						if (tk.kind === 'eof') break; k++;
					}
					continue;
				}
				// Function prototype: (<type keyword|id>) <id> '(' ... ')' ';'
				if ((t.kind === 'keyword' || t.kind === 'id')) {
					const nameTok = expandedEarly[i + 1];
					const lparen = expandedEarly[i + 2];
					if (nameTok && nameTok.kind === 'id' && lparen && (lparen.kind === 'punct' || lparen.kind === 'op') && lparen.value === '(') {
						let j = i + 3; let depth = 1; let foundClose = -1;
						while (j < expandedEarly.length) {
							const tk = expandedEarly[j]!;
							if ((tk.kind === 'punct' || tk.kind === 'op') && tk.value === '(') depth++;
							else if ((tk.kind === 'punct' || tk.kind === 'op') && tk.value === ')') { depth--; if (depth === 0) { foundClose = j; break; } }
							if (tk.kind === 'eof') break; j++;
						}
						if (foundClose > 0) {
							const semi = expandedEarly[foundClose + 1];
							if (semi && (semi.kind === 'punct' || semi.kind === 'op') && semi.value === ';') {
								const fname = nameTok.value;
								if (!declaredFuncNames.has(fname) && !builtinFuncNames.has(fname)) {
									const incRange = includeRangeByFile.get(origin) || { start: doc.positionAt(0), end: doc.positionAt(0) };
									const d: Decl = { name: fname, kind: 'func', range: incRange, type: t.value, params: [] };
									decls.push(d); functions.set(fname, d); declaredFuncNames.add(fname);
								}
							}
							// advance to after ';' if present
							if (semi && semi.value === ';') { i = foundClose + 1; continue; }
						}
					}
				}
				// Global variable: <type> <id> ';' not followed by '(' (avoid misreading function without params but w/ body later)
				if ((t.kind === 'keyword' || t.kind === 'id')) {
					const nameTok = expandedEarly[i + 1];
					const semi = expandedEarly[i + 2];
					if (nameTok && nameTok.kind === 'id' && semi && (semi.kind === 'punct' || semi.kind === 'op') && semi.value === ';' ) {
						if (!declaredVarNames.has(nameTok.value)) {
							const incRange = includeRangeByFile.get(origin) || { start: doc.positionAt(0), end: doc.positionAt(0) };
							const d: Decl = { name: nameTok.value, kind: 'var', range: incRange, type: t.value };
							decls.push(d); globalDecls.push(d); declaredVarNames.add(nameTok.value);
						}
						i = i + 2; continue; // jump past var decl
					}
				}
			}
		}
	} catch { /* ignore synthetic decl errors */ }

	for (const [, f] of script.functions) visitFunction(f);
	for (const [, s] of script.states) visitState(s);

	// After building declarations from the (expanded) AST, perform cross-include duplicate detection.
	// Because we now fully expand includes into pre.expandedTokens, header declarations surface as part
	// of the parsed script unless they were only forward declarations (e.g. prototypes) filtered out by the parser.
	// We replicate the legacy behaviour: if an included header redeclares a built-in function or state name
	// that is also declared in the main script, emit a duplicate diagnostic pointing at the included declaration.
	try {
		// Access expandedTokens produced by preprocessForAst (available when using new parser path)
		const expanded = pre.expandedTokens as unknown as Token[] | undefined;
		if (expanded && expanded.length) {
			// Build a quick index of builtin function names for fast membership checks
			const builtinFuncNames = new Set<string>();
			for (const [name] of defs.funcs) builtinFuncNames.add(name);
			// Existing declared user functions and states (from this script body)
			const userFuncNames = new Set<string>();
			for (const d of decls) if (d.kind === 'func') userFuncNames.add(d.name);
			const userStateNames = new Set<string>();
			for (const d of decls) if (d.kind === 'state') userStateNames.add(d.name);
			// Scan token stream for simple prototypes originating from include files:
			// pattern: <type-id> <id> '(' ... ')' ';'  (function prototype) OR 'state' <id> '{'
			// We only care when originFile differs from primary doc (heuristic: token has originFile and
			// that path is different from current file path resolved from doc.uri) and the name clashes.
			let primaryFsPath: string | undefined;
			try { const u = (doc.uri.startsWith('file://') ? require('vscode-uri').URI.parse(doc.uri).fsPath : undefined); primaryFsPath = u; } catch { /* ignore */ }
			const toks = expanded as Token[];
			for (let i = 0; i < toks.length; i++) {
				const t = toks[i]!;
				const anyT = t as Token & { originFile?: string; file?: string };
				const origin = anyT.originFile || anyT.file;
				if (!origin || (primaryFsPath && origin === primaryFsPath)) continue; // only interested in included files
				// Detect state header: 'state' <id> '{'
				if ((t.kind === 'id' || t.kind === 'keyword') && t.value === 'state') {
					const nTok = toks[i + 1]; const brace = toks[i + 2];
					if (nTok && nTok.kind === 'id' && brace && (brace.kind === 'punct' || brace.kind === 'op') && brace.value === '{') {
						const name = nTok.value;
						if (userStateNames.has(name)) {
							const incRange = includeRangeByFile.get(origin);
							const range = incRange || { start: doc.positionAt(nTok.span.start), end: doc.positionAt(nTok.span.end) };
							diagnostics.push({ code: LSL_DIAGCODES.DUPLICATE_DECL, message: `Duplicate declaration of state ${name}`, range, severity: DiagnosticSeverity.Error });
						}
					}
					continue;
				}
				// Potential function prototype: id id '(' ... ')' ';' (allow any first id; parser may have skipped prototype)
				if (t.kind === 'id' || t.kind === 'keyword') {
					const nameTok = toks[i + 1];
					if (nameTok && nameTok.kind === 'id') {
						const lparen = toks[i + 2];
						if (lparen && (lparen.kind === 'punct' || lparen.kind === 'op') && lparen.value === '(') {
							let j = i + 3; let depth = 1; let foundClose = -1;
							while (j < toks.length) {
								const tk = toks[j]!;
								if ((tk.kind === 'punct' || tk.kind === 'op') && tk.value === '(') depth++;
								else if ((tk.kind === 'punct' || tk.kind === 'op') && tk.value === ')') { depth--; if (depth === 0) { foundClose = j; break; } }
								if (tk.kind === 'eof') break;
								j++;
							}
							if (foundClose > 0) {
								const semi = toks[foundClose + 1];
								if (semi && (semi.kind === 'punct' || semi.kind === 'op') && semi.value === ';') {
									const fname = nameTok.value;
									if (builtinFuncNames.has(fname) || userFuncNames.has(fname)) {
										const incRange = includeRangeByFile.get(origin);
										const range = incRange || { start: doc.positionAt(nameTok.span.start), end: doc.positionAt(nameTok.span.end) };
										diagnostics.push({ code: LSL_DIAGCODES.DUPLICATE_DECL, message: `Duplicate declaration of function ${fname}`, range, severity: DiagnosticSeverity.Error });
									}
									// Also synthesize missing global variable decls (defensive second pass) if pattern <type> <id> ';' and not already declared
								} else {
									// Non-prototype path: check for global var (handled earlier but safe)
									const after = toks[i + 2];
									if (after && (after.kind === 'punct' || after.kind === 'op') && after.value === ';' && !globalDecls.some(g => g.name === nameTok.value)) {
										const incRange = includeRangeByFile.get(origin) || { start: doc.positionAt(0), end: doc.positionAt(0) };
										const d: Decl = { name: nameTok.value, kind: 'var', range: incRange, type: t.value };
										decls.push(d); globalDecls.push(d);
									}
								}
							}
						}
					}
				}
			}
		}
	} catch { /* best effort; ignore errors in duplicate detection */ }

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
			const zeroBasedLine = doc.positionAt(startOff).line; // 0-based
			// In preprocessing we stored line numbers as 0-based when calling lineOf(); convert consistently here.
			const hasCode = (set: Set<string> | null) => !set || set.has(d.code);
			// disable-line: same physical line (maps stored with 0-based line index)
			const s1 = dd.disableLine.get(zeroBasedLine) || dd.disableLine.get(zeroBasedLine + 1); // tolerate previous storage style
			if (s1 && hasCode(s1)) return false;
			// disable-next-line: directive appears on previous line suppressing this one. Maps store directive line index.
			const sPrev = dd.disableNextLine.get(zeroBasedLine - 1);
			if (sPrev && hasCode(sPrev)) return false;
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
