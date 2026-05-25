import type { TextDocument } from '../protocol';
import { DiagnosticSeverity, fileUriToPath, type Range } from '../protocol';
import type { Defs } from '../defs';
import type { PreprocResult } from '../core/preproc';
import { Script, Expr, Function as AstFunction, State as AstState, spanToRange, isType as isLslType, Stmt, Type } from './types';
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
import { Env, evalExpr, type EvalOptions } from './eval';
import type { Value } from './runtime';
import { isAssignmentCompatible } from './compat';
import { keyValueFromString, NULL_KEY_VALUE } from './key';

// Scope now carries a lightweight kind tag to distinguish event/function contexts
type Scope = { parent?: Scope; vars: Map<string, Decl>; kind?: 'event' | 'func' | 'state' | 'global' | 'block' };

function maskCommentsAndStrings(text: string): string {
	let out = '';
	let inBlock = false;
	let inLine = false;
	let quote: string | null = null;
	for (let i = 0; i < text.length; i++) {
		const ch = text[i]!;
		const next = text[i + 1];
		if (inLine) {
			if (ch === '\n') {
				inLine = false;
				out += ch;
			} else {
				out += ' ';
			}
			continue;
		}
		if (inBlock) {
			if (ch === '*' && next === '/') {
				out += '  ';
				i++;
				inBlock = false;
			} else {
				out += ch === '\n' ? ch : ' ';
			}
			continue;
		}
		if (quote) {
			if (ch === '\\' && next != null) {
				out += '  ';
				i++;
				continue;
			}
			out += ch === '\n' ? ch : ' ';
			if (ch === quote) quote = null;
			continue;
		}
		if (ch === '/' && next === '/') {
			out += '  ';
			i++;
			inLine = true;
			continue;
		}
		if (ch === '/' && next === '*') {
			out += '  ';
			i++;
			inBlock = true;
			continue;
		}
		if (ch === '"' || ch === '\'') {
			out += ' ';
			quote = ch;
			continue;
		}
		out += ch;
	}
	return out;
}

export function analyzeAst(doc: TextDocument, script: Script, defs: Defs, pre: PreprocResult): Analysis {
	const diagnostics: Diag[] = [];
	const currentFile = (() => {
		try { return doc.uri.startsWith('file://') ? fileUriToPath(doc.uri) : undefined; }
		catch { return undefined; }
	})();
	const originFileOf = (node: { originFile?: string; span?: { file?: string } }): string | undefined => node.originFile || node.span?.file;
	const isCurrentNode = (node: { originFile?: string; span?: { file?: string } }): boolean => {
		const file = originFileOf(node);
		return !file || file === '<unknown>' || !currentFile || file === currentFile;
	};
	// Merge parser diagnostics (previously only available on Script) into analysis diagnostics so
	// downstream tests that inspect analysis.diagnostics see syntax/duplicate/state errors emitted
	// during parsing (e.g. LSL070 duplicate globals/functions, LSL022 illegal state decls, missing
	// semicolons, unterminated comments). Earlier refactor unified preprocessing+parsing but dropped
	// this merge causing multiple diagnostics-based tests to fail. We map parser spans to Ranges here.
	try {
		if (script.diagnostics && script.diagnostics.length) {
			for (const pd of script.diagnostics) {
				if (pd.file && pd.file !== '<unknown>' && currentFile && pd.file !== currentFile) continue;
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
	function pushTypeScope(parent?: TypeScope): TypeScope { return { parent, view: new Map<string, SimpleType>(parent?.view) }; }
	function addType(scope: TypeScope, name: string, type: string) { scope.view.set(name, normalizeType(type) as SimpleType); }
	// Global (file) scope for variables/functions/states
	const globalScope: Scope = { vars: new Map(), kind: 'global' };
	const globalTypeScope: TypeScope = pushTypeScope();
	const constantNames = new Set(defs.consts.keys());
	const constantStringValues = new Map<string, string>();
	for (const [name, type] of Object.entries(pre.dynamicMacros ?? {})) {
		addType(globalTypeScope, name, type);
	}
	// Seed type information for built-in constants so member validation sees their shapes.
	for (const c of defs.consts.values()) {
		if (c?.type) addType(globalTypeScope, c.name, c.type);
		if (typeof c?.value === 'string') constantStringValues.set(c.name, c.value);
	}
	const mustUseFunctions = new Set<string>();
	const functionMeta = new Map<string, { godMode: boolean; deprecated: boolean; deprecatedMessage?: string }>();
	const extractDeprecatedMessage = (doc?: string): string | undefined => {
		if (!doc) return undefined;
		const m = doc.match(/^\s*depr[ie]?cated[:-]?\s*(.*)$/i);
		if (!m) return undefined;
		const rest = (m[1] || '').trim();
		return rest.length ? rest : undefined;
	};
	for (const [name, overloads] of defs.funcs) {
		if (overloads && overloads.some(f => f?.mustUse)) {
			mustUseFunctions.add(name);
		}
		let godMode = false;
		let deprecated = false;
		let deprecatedMessage: string | undefined;
		for (const f of overloads || []) {
			if (f?.godMode) godMode = true;
			if (f?.deprecated) {
				deprecated = true;
				if (!deprecatedMessage) deprecatedMessage = f.deprecatedMessage || extractDeprecatedMessage(f.doc);
			}
		}
		if (godMode || deprecated) functionMeta.set(name, { godMode, deprecated, deprecatedMessage });
	}
	const isMustUseFunction = (name: string): boolean => mustUseFunctions.has(name);

	const CONST_COND_MAX_NODES = 200;
	const parseVectorish = (raw: unknown): { vec: [number, number, number]; rot?: [number, number, number, number] } | null => {
		if (typeof raw !== 'string') return null;
		const m = /^<\s*([^,]+)\s*,\s*([^,]+)\s*,\s*([^,>]+)\s*(?:,\s*([^,>]+)\s*)?>$/.exec(raw.trim());
		if (!m) return null;
		const toNum = (s: string) => Number(s.trim());
		const a = toNum(m[1]!); const b = toNum(m[2]!); const c = toNum(m[3]!);
		if (![a, b, c].every(Number.isFinite)) return null;
		if (m[4] !== undefined) {
			const d = toNum(m[4]!);
			if (!Number.isFinite(d)) return null;
			return { vec: [a, b, c], rot: [a, b, c, d] };
		}
		return { vec: [a, b, c] };
	};
	const zeroValueForType = (type: string): Value | null => {
		switch (normalizeType(type)) {
			case 'integer': return { kind: 'value', type: 'integer', value: 0 };
			case 'float': return { kind: 'value', type: 'float', value: 0 };
			case 'string': return { kind: 'value', type: 'string', value: '' };
			case 'key': return { kind: 'value', type: 'key', value: '' } as Value;
			case 'vector': return { kind: 'value', type: 'vector', value: [0, 0, 0] } as Value;
			case 'rotation': return { kind: 'value', type: 'rotation', value: [0, 0, 0, 1] } as Value;
			case 'list': return { kind: 'value', type: 'list', value: [] } as Value;
			default: return null;
		}
	};
	const evalFunctionReturnTypes = new Map<string, Type | 'void'>();
	const ANALYSIS_EVAL_OPTIONS: EvalOptions = {
		maxNodes: 500,
		maxDepth: 64,
		maxLoopIters: 128,
		allowRuntimeCalls: true,
	};
	const constantEnv = (() => {
		const env = new Env(new Map(), evalFunctionReturnTypes);
		const toValue = (type: string | undefined, raw: unknown): Value | null => {
			const t = normalizeType(type || 'integer');
			if (t === 'integer') {
				const n = typeof raw === 'number' ? raw : (typeof raw === 'string' ? Number(raw) : NaN);
				return Number.isFinite(n) ? { kind: 'value', type: 'integer', value: Math.trunc(n) } : null;
			}
			if (t === 'float') {
				const n = typeof raw === 'number' ? raw : (typeof raw === 'string' ? Number(raw) : NaN);
				return Number.isFinite(n) ? { kind: 'value', type: 'float', value: n } : null;
			}
			if (t === 'string' && typeof raw === 'string') return { kind: 'value', type: 'string', value: raw };
			if ((t === 'vector' || t === 'rotation') && raw !== undefined) {
				const parsed = parseVectorish(raw);
				if (parsed) {
					if (t === 'rotation' && parsed.rot) return { kind: 'value', type: 'rotation', value: parsed.rot } as Value;
					return { kind: 'value', type: 'vector', value: parsed.vec } as Value;
				}
			}
			return null;
		};
		for (const c of defs.consts.values()) {
			const legacyConst = c as typeof c & { val?: unknown };
			const v = toValue(c.type, legacyConst.value ?? legacyConst.val ?? undefined);
			if (v) env.setVar(c.name, v);
		}
		for (const [name, type] of Object.entries(pre.dynamicMacros ?? {})) {
			env.setVar(name, { kind: 'unknown', type });
		}
		return env;
	})();
	const valueEnvStack: Env[] = [constantEnv.child()];
	const currentValueEnv = () => valueEnvStack[valueEnvStack.length - 1] ?? constantEnv;
	const evalLocalConstant = (expr: Expr | null, env: Env = currentValueEnv()): Value =>
		evalExpr(expr, env, ANALYSIS_EVAL_OPTIONS);
	function visitWithRestoredValueEnv(fn: () => void) {
		const index = valueEnvStack.length - 1;
		const snapshot = currentValueEnv().clone();
		try {
			fn();
		} finally {
			if (index >= 0) valueEnvStack[index] = snapshot;
		}
	}

	function conditionNodeCount(expr: Expr | null, limit: number): number {
		if (!expr) return 0;
		let count = 1;
		switch (expr.kind) {
			case 'Unary': count += conditionNodeCount(expr.argument, limit); break;
			case 'Binary': count += conditionNodeCount(expr.left, limit) + conditionNodeCount(expr.right, limit); break;
			case 'Cast': count += conditionNodeCount(expr.argument, limit); break;
			case 'Paren': count += conditionNodeCount(expr.expression, limit); break;
			case 'Call': count += conditionNodeCount(expr.callee, limit); for (const a of expr.args) count += conditionNodeCount(a, limit); break;
			case 'Member': count += conditionNodeCount(expr.object, limit); break;
			case 'VectorLiteral': for (const e of expr.elements) count += conditionNodeCount(e, limit); break;
			case 'ListLiteral': for (const e of expr.elements) count += conditionNodeCount(e, limit); break;
			default: break;
		}
		return count > limit ? limit + 1 : count;
	}

	const toConcreteType = (type: string): Type | null => {
		const normalized = normalizeType(type);
		return isLslType(normalized) ? normalized as Type : null;
	};
	const coerceValueForDeclaredType = (value: Value, type: string): Value => {
		const target = toConcreteType(type);
		if (!target) return value;
		if (value.kind === 'unknown') return { kind: 'unknown', type: target };
		if (value.type === target) return value;
		if (target === 'float' && value.type === 'integer') {
			return { kind: 'value', type: 'float', value: value.value };
		}
		if (target === 'string' && value.type === 'key') {
			return { kind: 'value', type: 'string', value: value.value };
		}
		if (target === 'key' && value.type === 'string') {
			const key = keyValueFromString(value.value);
			return key === null ? { kind: 'unknown', type: 'key' } : { kind: 'value', type: 'key', value: key };
		}
		return value;
	};
	const truthyValue = (v: Value): boolean | null => {
		if (v.kind !== 'value') return null;
		if (v.type === 'integer' || v.type === 'float') return Math.trunc(v.value) !== 0;
		if (v.type === 'string') return v.value.length !== 0;
		if (v.type === 'key') return v.value !== '' && v.value !== NULL_KEY_VALUE;
		if (v.type === 'list') return v.value.length !== 0;
		if (v.type === 'vector' || v.type === 'rotation') return v.value.some(component => component !== 0);
		return null;
	};

	function evalCondition(expr: Expr | null, env: Env = currentValueEnv()): boolean | null {
		if (!expr) return null;
		if (conditionNodeCount(expr, CONST_COND_MAX_NODES) > CONST_COND_MAX_NODES) return null;
		const v = evalLocalConstant(expr, env);
		return truthyValue(v);
	}
	// Usage tracking for unused param/local diagnostics
	type UsageContext = { usedParamNames: Set<string>; usedLocalNames: Set<string>; paramDecls: Decl[]; localDecls: Decl[] };
	const usageStack: UsageContext[] = [];
	type ReturnInfo = { expr?: Expr; span: { start: number; end: number } };
	function collectReturns(stmt: Stmt, out: ReturnInfo[]) {
		if (!stmt) return;
		switch (stmt.kind) {
			case 'ReturnStmt': out.push({ expr: stmt.expression, span: stmt.span }); break;
			case 'BlockStmt': for (const s of stmt.statements) collectReturns(s, out); break;
			case 'IfStmt': collectReturns(stmt.then, out); if (stmt.else) collectReturns(stmt.else, out); break;
			case 'WhileStmt': collectReturns(stmt.body, out); break;
			case 'DoWhileStmt': collectReturns(stmt.body, out); break;
			case 'ForStmt': collectReturns(stmt.body, out); break;
			default: break;
		}
	}
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
	let currentJumpTargets: Set<string> | null = null;
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
	function collectJumpTargets(stmt: Stmt | null): Set<string> {
		const targets = new Set<string>();
		function visit(s: Stmt | null) {
			if (!s) return;
			switch (s.kind) {
				case 'BlockStmt': for (const ch of s.statements) visit(ch); break;
				case 'IfStmt': visit(s.then); if (s.else) visit(s.else); break;
				case 'WhileStmt': visit(s.body); break;
				case 'DoWhileStmt': visit(s.body); break;
				case 'ForStmt': visit(s.body); break;
				case 'JumpStmt':
					if (s.target.kind === 'Identifier') targets.add(s.target.name);
					break;
				default: break;
			}
		}
		visit(stmt);
		return targets;
	}

	// Events declared outside any state are not captured in script.states; detect by a simple text scan fallback
	// Heuristic tightened to reduce false positives in header-like include files.
	// - Skip this check for files that look like headers (path contains "/include/" or common include guards like #pragma once / #ifndef INCLUDE_)
	// - Match only real event handler definitions: "eventName(type name, ...) {" (no return type before), not mere prototypes/macros
	if (script.states.size === 0) {
		const text: string = doc.getText ? doc.getText() : '';
		const uri: string = doc.uri || '';
		const headerLike = /\/include\//.test(uri)
			|| /^[ \t]*#pragma\s+once/m.test(text)
			|| /^[ \t]*#ifndef\s+INCLUDE_/m.test(text);
		if (!headerLike) {
			// Only consider actual LSL event names at start-of-line
			const eventNames = Array.from(defs.events.keys());
			if (eventNames.length > 0) {
				const codeText = maskCommentsAndStrings(text);
				const namesRe = eventNames.map(n => n.replace(/[-\\^$*+?.()|[\]{}]/g, '\\$&')).join('|');
				const sigRe = new RegExp(`^[\\t ]*(${namesRe})\\s*\\(`, 'gm');
				for (const match of codeText.matchAll(sigRe)) {
					const leading = /^[\t ]*/.exec(match[0])?.[0].length ?? 0;
					const eventStart = match.index + leading;
					const inactiveRanges = pre.inactiveRanges ?? pre.disabledRanges;
					const disabled = inactiveRanges.some(r => (!r.file || !currentFile || r.file === currentFile) && eventStart >= r.start && eventStart < r.end);
					if (disabled) continue;
					const eventName = match[1] ?? '';
					diagnostics.push({
						code: LSL_DIAGCODES.EVENT_OUTSIDE_STATE,
						message: 'Event must be declared inside a state',
						range: { start: doc.positionAt(eventStart), end: doc.positionAt(eventStart + eventName.length) },
						severity: DiagnosticSeverity.Error,
					});
					break;
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
						|| (pre.dynamicMacros && Object.prototype.hasOwnProperty.call(pre.dynamicMacros, e.name))
						|| (pre.funcMacros && Object.prototype.hasOwnProperty.call(pre.funcMacros, e.name))
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
							|| (pre.dynamicMacros && Object.prototype.hasOwnProperty.call(pre.dynamicMacros, calleeName))
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
					const meta = functionMeta.get(calleeName);
					if (meta?.godMode) {
						diagnostics.push({
							code: LSL_DIAGCODES.GOD_MODE_REQUIRED,
							message: `Function ${calleeName} requires god mode`,
							range: spanToRange(doc, e.callee.span),
							severity: DiagnosticSeverity.Error,
						});
					}
					if (meta?.deprecated) {
						const detail = meta.deprecatedMessage ? `: ${meta.deprecatedMessage}` : '';
						diagnostics.push({
							code: LSL_DIAGCODES.DEPRECATED_CALL,
							message: `Function ${calleeName} is deprecated${detail}`,
							range: spanToRange(doc, e.callee.span),
							severity: DiagnosticSeverity.Warning,
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
		valueEnvStack.push(currentValueEnv().clone().child());
		const scope = pushScope(globalScope, 'func');
		const ts = pushTypeScope(globalTypeScope);
		const returnType = (fn.returnType ?? 'void') as string;
		// Collect all labels in this function body so jump targets can be validated without unknown-identifier noise
		const savedLabels = currentLabels;
		const savedJumpTargets = currentJumpTargets;
		currentLabels = collectLabels(fn.body);
		currentJumpTargets = collectJumpTargets(fn.body);
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
		const returns: ReturnInfo[] = [];
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
				case 'WhileStmt':
				case 'DoWhileStmt':
				case 'ForStmt':
					return false;
				default: return false;
			}
		}
		visitStmt(fn.body, scope, ts);
		if (fn.body.kind === 'BlockStmt' && fn.body.statements.length === 0) {
			diagnostics.push({ code: LSL_DIAGCODES.EMPTY_FUNCTION_BODY, message: `Function ${fn.name} body is empty`, range: spanToRange(doc, fn.body.span), severity: DiagnosticSeverity.Warning });
		}
		collectReturns(fn.body, returns);
		if (returnType === 'void') {
			for (const r of returns) {
				if (r.expr) {
					diagnostics.push({ code: LSL_DIAGCODES.RETURN_IN_VOID, message: 'Returning a value in a void function', range: spanToRange(doc, r.span), severity: DiagnosticSeverity.Error });
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
		valueEnvStack.pop();
		usageStack.pop();
		currentLabels = savedLabels;
		currentJumpTargets = savedJumpTargets;
	}

	type TypeScopeView = { view: Map<string, SimpleType> | ReadonlyMap<string, SimpleType> };
	function inferTypeOf(e: Expr, typeScope: TypeScopeView): string {
		// Use direct import to work in both test and build environments
		const v = typeScope.view as Map<string, SimpleType>;
		return inferExprTypeFromAst(e, v) as string;
	}

	function typesCompatible(expected: string, got: string): boolean {
		return isAssignmentCompatible(toSimpleType(expected), toSimpleType(got));
	}

	function visitState(st: AstState) {
		const scope = pushScope(globalScope, 'state');
		const tsState = pushTypeScope(globalTypeScope);
		// Duplicate event names within the same state
		const evNames = new Set<string>();
		for (const ev of st.events) {
			valueEnvStack.push(currentValueEnv().clone().child());
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
			// Collect labels for this event body
			const savedLabels = currentLabels;
			const savedJumpTargets = currentJumpTargets;
			currentLabels = collectLabels(ev.body);
			currentJumpTargets = collectJumpTargets(ev.body);
			visitStmt(ev.body, evScope, tsEvent);
			if (ev.body.kind === 'BlockStmt' && ev.body.statements.length === 0) {
				diagnostics.push({ code: LSL_DIAGCODES.EMPTY_EVENT_BODY, message: `Event ${ev.name} body is empty`, range: spanToRange(doc, ev.body.span), severity: DiagnosticSeverity.Warning });
			}
			const returns: ReturnInfo[] = [];
			collectReturns(ev.body, returns);
			for (const r of returns) {
				if (r.expr) {
					diagnostics.push({ code: LSL_DIAGCODES.RETURN_IN_VOID, message: 'Returning a value in an event handler', range: spanToRange(doc, r.span), severity: DiagnosticSeverity.Error });
				}
			}
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
			currentJumpTargets = savedJumpTargets;
			valueEnvStack.pop();
		}
	}

	function validateExpr(expr: Expr | null, typeScope: TypeScope) {
		if (!expr) return;
		validateOperatorsFromAst(doc, [expr], diagnostics, typeScope.view, functionReturnTypes, callSignatures, { constantNames, constantStringValues });
	}

	function validateInitializerType(targetType: string, initializer: Expr, typeScope: TypeScope) {
		const target = toSimpleType(targetType);
		const source = inferExprTypeFromAst(initializer, typeScope.view, functionReturnTypes);
		if (!isAssignmentCompatible(target, source)) {
			diagnostics.push({
				code: LSL_DIAGCODES.WRONG_TYPE,
				message: `Cannot assign ${source} to ${target}`,
				range: spanToRange(doc, initializer.span),
				severity: DiagnosticSeverity.Error,
			});
		}
	}

	function isValidGlobalInitializer(expr: Expr, scope: Scope): boolean {
		switch (expr.kind) {
			case 'NumberLiteral':
			case 'StringLiteral':
				return true;
			case 'Identifier':
				return defs.consts.has(expr.name) || !!resolveInScope(expr.name, scope) || !!pre.macros?.[expr.name] || !!pre.dynamicMacros?.[expr.name];
			case 'Unary':
				return (expr.op === '+' || expr.op === '-') && expr.argument.kind === 'NumberLiteral';
			case 'ListLiteral':
				return expr.elements.every((element) => isValidGlobalInitializer(element, scope));
			case 'VectorLiteral':
				return expr.elements.every((element) => isValidGlobalInitializer(element, scope));
			case 'Binary':
			case 'Call':
			case 'Cast':
			case 'ErrorExpr':
			case 'Member':
			case 'Paren':
				return false;
			default:
				AssertNever(expr, 'Unhandled Expr kind in isValidGlobalInitializer');
				return false;
		}
	}

	const assignmentOps = new Set(['=', '+=', '-=', '*=', '/=', '%=']);
	function rootIdentifier(expr: Expr): string | null {
		if (expr.kind === 'Identifier') return expr.name;
		if (expr.kind === 'Member') return rootIdentifier(expr.object);
		if (expr.kind === 'Paren') return rootIdentifier(expr.expression);
		return null;
	}

	function updateValueEnvFromExpr(expr: Expr | null, typeScope: TypeScope) {
		if (!expr) return;
		if (expr.kind === 'Binary' && assignmentOps.has(expr.op)) {
			if (expr.left.kind === 'Identifier') {
				if (expr.op === '=') {
					const rhsVal = evalLocalConstant(expr.right);
					const lhsType = normalizeType(inferTypeOf(expr.left, typeScope));
					currentValueEnv().setExistingOrLocal(expr.left.name, coerceValueForDeclaredType(rhsVal, lhsType));
				} else {
					const t = normalizeType(inferTypeOf(expr.left, typeScope));
					currentValueEnv().setExistingOrLocal(expr.left.name, { kind: 'unknown', type: t } as Value);
				}
			} else {
				const name = rootIdentifier(expr.left);
				if (name) {
					const t = normalizeType(typeScope.view.get(name) ?? inferTypeOf(expr.left, typeScope));
					currentValueEnv().setExistingOrLocal(name, { kind: 'unknown', type: toConcreteType(t) ?? 'integer' } as Value);
				}
			}
		}
		if (expr.kind === 'Unary' && (expr.op === '++' || expr.op === '--')) {
			const arg = expr.argument;
			const name = rootIdentifier(arg);
			if (name) {
				const t = normalizeType(typeScope.view.get(name) ?? inferTypeOf(arg, typeScope));
				currentValueEnv().setExistingOrLocal(name, { kind: 'unknown', type: toConcreteType(t) ?? 'integer' } as Value);
			}
		}
	}

	function collectIdentifiers(expr: Expr | null, acc: Set<string> = new Set()): Set<string> {
		if (!expr) return acc;
		switch (expr.kind) {
			case 'Identifier': acc.add(expr.name); break;
			case 'Unary': collectIdentifiers(expr.argument, acc); break;
			case 'Binary': collectIdentifiers(expr.left, acc); collectIdentifiers(expr.right, acc); break;
			case 'Call': collectIdentifiers(expr.callee, acc); for (const a of expr.args) collectIdentifiers(a, acc); break;
			case 'Member': collectIdentifiers(expr.object, acc); break;
			case 'Cast': collectIdentifiers(expr.argument, acc); break;
			case 'Paren': collectIdentifiers(expr.expression, acc); break;
			case 'ListLiteral': for (const e of expr.elements) collectIdentifiers(e, acc); break;
			case 'VectorLiteral': for (const e of expr.elements) collectIdentifiers(e, acc); break;
			default: break;
		}
		return acc;
	}

	function collectMutatedIdentifiers(expr: Expr | null, acc: Set<string> = new Set()): Set<string> {
		if (!expr) return acc;
		switch (expr.kind) {
			case 'Binary': {
				if (assignmentOps.has(expr.op)) {
					const name = rootIdentifier(expr.left);
					if (name) acc.add(name);
				}
				collectMutatedIdentifiers(expr.left, acc); collectMutatedIdentifiers(expr.right, acc);
				break;
			}
			case 'Unary': {
				if (expr.op === '++' || expr.op === '--') {
					const name = rootIdentifier(expr.argument);
					if (name) acc.add(name);
				}
				collectMutatedIdentifiers(expr.argument, acc);
				break;
			}
			case 'Call': collectMutatedIdentifiers(expr.callee, acc); for (const a of expr.args) collectMutatedIdentifiers(a, acc); break;
			case 'Member': collectMutatedIdentifiers(expr.object, acc); break;
			case 'Cast': collectMutatedIdentifiers(expr.argument, acc); break;
			case 'Paren': collectMutatedIdentifiers(expr.expression, acc); break;
			case 'ListLiteral': for (const e of expr.elements) collectMutatedIdentifiers(e, acc); break;
			case 'VectorLiteral': for (const e of expr.elements) collectMutatedIdentifiers(e, acc); break;
			default: break;
		}
		return acc;
	}

	function collectMutatedIdentifiersInStmt(stmt: Stmt | null | undefined, acc: Set<string> = new Set()): Set<string> {
		if (!stmt) return acc;
		switch (stmt.kind) {
			case 'ExprStmt': collectMutatedIdentifiers(stmt.expression, acc); break;
			case 'ReturnStmt': collectMutatedIdentifiers(stmt.expression ?? null, acc); break;
			case 'BlockStmt': for (const s of stmt.statements) collectMutatedIdentifiersInStmt(s, acc); break;
			case 'IfStmt':
				collectMutatedIdentifiers(stmt.condition, acc);
				collectMutatedIdentifiersInStmt(stmt.then, acc);
				collectMutatedIdentifiersInStmt(stmt.else, acc);
				break;
			case 'WhileStmt':
			case 'DoWhileStmt':
				collectMutatedIdentifiers(stmt.condition, acc);
				collectMutatedIdentifiersInStmt(stmt.body, acc);
				break;
			case 'ForStmt':
				collectMutatedIdentifiers(stmt.init ?? null, acc);
				collectMutatedIdentifiers(stmt.condition ?? null, acc);
				collectMutatedIdentifiers(stmt.update ?? null, acc);
				collectMutatedIdentifiersInStmt(stmt.body, acc);
				break;
			default: break;
		}
		return acc;
	}

	function markMutatedValuesUnknown(names: Iterable<string>, typeScope: TypeScope) {
		for (const name of names) {
			const t = normalizeType(typeScope.view.get(name) ?? 'integer');
			currentValueEnv().setExistingOrLocal(name, { kind: 'unknown', type: toConcreteType(t) ?? 'integer' } as Value);
		}
	}

	function collectMutatedGlobalNames(globalNames: ReadonlySet<string>): Set<string> {
		const mutated = new Set<string>();
		const addGlobalsFromStmt = (stmt: Stmt) => {
			for (const name of collectMutatedIdentifiersInStmt(stmt)) {
				if (globalNames.has(name)) mutated.add(name);
			}
		};
		for (const [, fn] of script.functions) addGlobalsFromStmt(fn.body);
		for (const [, st] of script.states) {
			for (const ev of st.events) addGlobalsFromStmt(ev.body);
		}
		return mutated;
	}

	function evaluateIfCondition(expr: Expr): { truth: boolean | null; envAfter?: Env } {
		const hasAssignment = collectMutatedIdentifiers(expr).size > 0;
		if (!hasAssignment) return { truth: evalCondition(expr) };
		const env = currentValueEnv().clone();
		return { truth: evalCondition(expr, env), envAfter: env };
	}

	function applyConditionValueEnv(result: { envAfter?: Env }) {
		if (!result.envAfter) return;
		const index = valueEnvStack.length - 1;
		if (index >= 0) valueEnvStack[index] = result.envAfter;
	}

	function visitStmt(stmt: Stmt | null, scope: Scope, typeScope: TypeScope) {
		if (!stmt) return;
		switch (stmt.kind) {
			case 'BlockStmt': {
				// Also detect duplicate local declarations in the same block
				const blockScope = pushScope(scope, 'block');
				const blockTypeScope = pushTypeScope(typeScope);
				valueEnvStack.push(currentValueEnv().child());
				const localNames = new Set<string>();
				try {
					for (let i = 0; i < stmt.statements.length; i++) {
						const s = stmt.statements[i];
						visitStmt(s, blockScope, blockTypeScope);
						if (s && s.kind === 'VarDecl') {
							if (localNames.has(s.name)) {
								diagnostics.push({ code: LSL_DIAGCODES.DUPLICATE_DECL, message: `Duplicate declaration of ${s.name}`, range: spanToRange(doc, s.span), severity: DiagnosticSeverity.Error });
							} else localNames.add(s.name);
						}
						if (!s || s.kind !== 'ReturnStmt') continue;
						const next = stmt.statements[i + 1];
						if (!next) continue;
						if (next.kind === 'LabelStmt' && currentJumpTargets?.has(next.name)) continue;
						const sEnd = spanToRange(doc, s.span).end;
						const nStart = spanToRange(doc, next.span).start;
						diagnostics.push({ code: LSL_DIAGCODES.DEAD_CODE, message: 'Dead code found beyond return statement', range: { start: sEnd, end: nStart }, severity: DiagnosticSeverity.Warning });
					}
				} finally {
					valueEnvStack.pop();
				}
				break;
			}
			case 'ExprStmt': walkExpr(stmt.expression, scope, typeScope, false); validateExpr(stmt.expression, typeScope); updateValueEnvFromExpr(stmt.expression, typeScope); break;
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
				if (stmt.initializer) {
					walkExpr(stmt.initializer, scope, typeScope);
					validateExpr(stmt.initializer, typeScope);
					validateInitializerType(type, stmt.initializer, typeScope);
					currentValueEnv().setVar(name, coerceValueForDeclaredType(evalLocalConstant(stmt.initializer), type));
				} else {
					const dv = zeroValueForType(type);
					if (dv) currentValueEnv().setVar(name, dv);
				}
				scope.vars.set(name, d);
				decls.push(d);
				// Track local decl for unused checks when inside a body
				const top = usageStack[usageStack.length - 1];
				if (top) top.localDecls.push(d);
				addType(typeScope, name, type);
				break;
			}
			case 'ReturnStmt': walkExpr(stmt.expression || null, scope, typeScope); validateExpr(stmt.expression || null, typeScope); break;
			case 'IfStmt': {
				walkExpr(stmt.condition, scope, typeScope);
				// Validate condition with suspicious-assignment flag; other expressions validated normally
				validateOperatorsFromAst(doc, [stmt.condition], diagnostics, typeScope.view, functionReturnTypes, callSignatures, { flagSuspiciousAssignment: true, constantNames, constantStringValues });
				const condition = evaluateIfCondition(stmt.condition);
				const truth = condition.truth;
				if (truth === true) diagnostics.push({ code: LSL_DIAGCODES.ALWAYS_TRUE_CONDITION, message: 'Condition is always true', range: spanToRange(doc, stmt.condition.span), severity: DiagnosticSeverity.Warning });
				else if (truth === false) diagnostics.push({ code: LSL_DIAGCODES.ALWAYS_FALSE_CONDITION, message: 'Condition is always false', range: spanToRange(doc, stmt.condition.span), severity: DiagnosticSeverity.Warning });
				applyConditionValueEnv(condition);
				if (truth === true) {
					visitStmt(stmt.then, scope, typeScope);
					if (stmt.else) visitWithRestoredValueEnv(() => visitStmt(stmt.else ?? null, scope, typeScope));
				} else if (truth === false) {
					visitWithRestoredValueEnv(() => visitStmt(stmt.then, scope, typeScope));
					if (stmt.else) visitStmt(stmt.else, scope, typeScope);
				} else {
					visitWithRestoredValueEnv(() => visitStmt(stmt.then, scope, typeScope));
					if (stmt.else) visitWithRestoredValueEnv(() => visitStmt(stmt.else ?? null, scope, typeScope));
					const mutated = new Set<string>();
					collectMutatedIdentifiersInStmt(stmt.then, mutated);
					collectMutatedIdentifiersInStmt(stmt.else, mutated);
					markMutatedValuesUnknown(mutated, typeScope);
				}
				break;
			}
			case 'WhileStmt': {
				walkExpr(stmt.condition, scope, typeScope);
				validateOperatorsFromAst(doc, [stmt.condition], diagnostics, typeScope.view, functionReturnTypes, callSignatures, { flagSuspiciousAssignment: true, constantNames, constantStringValues });
				let truth: boolean | null = null;
				const condIds = collectIdentifiers(stmt.condition);
				const bodyMutations = collectMutatedIdentifiersInStmt(stmt.body);
				const mutatedCondition = collectMutatedIdentifiers(stmt.condition);
				const mutatesLoop = [...condIds].some(n => bodyMutations.has(n) || mutatedCondition.has(n));
				if (!mutatesLoop) {
					truth = evalCondition(stmt.condition);
					if (truth === true) diagnostics.push({ code: LSL_DIAGCODES.ALWAYS_TRUE_CONDITION, message: 'Loop condition is always true', range: spanToRange(doc, stmt.condition.span), severity: DiagnosticSeverity.Warning });
					else if (truth === false) diagnostics.push({ code: LSL_DIAGCODES.ALWAYS_FALSE_CONDITION, message: 'Loop condition is always false', range: spanToRange(doc, stmt.condition.span), severity: DiagnosticSeverity.Warning });
				}
				const loopMutations = new Set<string>(bodyMutations);
				collectMutatedIdentifiers(stmt.condition, loopMutations);
				visitWithRestoredValueEnv(() => {
					if (truth !== false && loopMutations.size) markMutatedValuesUnknown(loopMutations, typeScope);
					visitStmt(stmt.body, scope, typeScope);
				});
				if (truth !== false && loopMutations.size) markMutatedValuesUnknown(loopMutations, typeScope);
				break;
			}
			case 'DoWhileStmt': {
				const bodyMutations = collectMutatedIdentifiersInStmt(stmt.body);
				visitWithRestoredValueEnv(() => {
					if (bodyMutations.size) markMutatedValuesUnknown(bodyMutations, typeScope);
					visitStmt(stmt.body, scope, typeScope);
				});
				if (bodyMutations.size) markMutatedValuesUnknown(bodyMutations, typeScope);
				walkExpr(stmt.condition, scope, typeScope);
				validateOperatorsFromAst(doc, [stmt.condition], diagnostics, typeScope.view, functionReturnTypes, callSignatures, { flagSuspiciousAssignment: true, constantNames, constantStringValues });
				const condIds = collectIdentifiers(stmt.condition);
				const mutatedCondition = collectMutatedIdentifiers(stmt.condition);
				const mutatesLoop = [...condIds].some(n => bodyMutations.has(n) || mutatedCondition.has(n));
				if (!mutatesLoop) {
					const truth = evalCondition(stmt.condition);
					if (truth === true) diagnostics.push({ code: LSL_DIAGCODES.ALWAYS_TRUE_CONDITION, message: 'Loop condition is always true', range: spanToRange(doc, stmt.condition.span), severity: DiagnosticSeverity.Warning });
					else if (truth === false) diagnostics.push({ code: LSL_DIAGCODES.ALWAYS_FALSE_CONDITION, message: 'Loop condition is always false', range: spanToRange(doc, stmt.condition.span), severity: DiagnosticSeverity.Warning });
				}
				if (mutatedCondition.size) markMutatedValuesUnknown(mutatedCondition, typeScope);
				break;
			}
			case 'ForStmt': {
				if (stmt.init) { walkExpr(stmt.init, scope, typeScope, false); validateExpr(stmt.init, typeScope); updateValueEnvFromExpr(stmt.init, typeScope); }
				let truth: boolean | null = stmt.condition ? null : true;
				if (stmt.condition) {
					walkExpr(stmt.condition, scope, typeScope);
					validateOperatorsFromAst(doc, [stmt.condition], diagnostics, typeScope.view, functionReturnTypes, callSignatures, { flagSuspiciousAssignment: true, constantNames, constantStringValues });
					const condIds = collectIdentifiers(stmt.condition);
					const mutatedInit = collectMutatedIdentifiers(stmt.init ?? null);
					const mutatedUpdate = collectMutatedIdentifiers(stmt.update ?? null);
					const mutatedCondition = collectMutatedIdentifiers(stmt.condition ?? null);
					const mutatesLoop = [...condIds].some(n => mutatedInit.has(n) || mutatedUpdate.has(n) || mutatedCondition.has(n));
					if (!mutatesLoop) {
						truth = evalCondition(stmt.condition);
						if (truth === true) diagnostics.push({ code: LSL_DIAGCODES.ALWAYS_TRUE_CONDITION, message: 'Loop condition is always true', range: spanToRange(doc, stmt.condition.span), severity: DiagnosticSeverity.Warning });
						else if (truth === false) diagnostics.push({ code: LSL_DIAGCODES.ALWAYS_FALSE_CONDITION, message: 'Loop condition is always false', range: spanToRange(doc, stmt.condition.span), severity: DiagnosticSeverity.Warning });
					}
				}
				if (stmt.update) {
					walkExpr(stmt.update, scope, typeScope, false);
					validateExpr(stmt.update, typeScope);
					visitWithRestoredValueEnv(() => updateValueEnvFromExpr(stmt.update ?? null, typeScope));
				}
				const loopMutations = collectMutatedIdentifiersInStmt(stmt.body);
				collectMutatedIdentifiers(stmt.condition ?? null, loopMutations);
				collectMutatedIdentifiers(stmt.update ?? null, loopMutations);
				visitWithRestoredValueEnv(() => {
					if (truth !== false && loopMutations.size) markMutatedValuesUnknown(loopMutations, typeScope);
					visitStmt(stmt.body, scope, typeScope);
				});
				if (truth !== false && loopMutations.size) markMutatedValuesUnknown(loopMutations, typeScope);
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
			if (thenIsEmptyStmt || thenEmptyBlock) diagnostics.push({ code: LSL_DIAGCODES.EMPTY_IF_BODY, message: 'Empty if-body has no effect', range: spanToRange(doc, stmt.then.span), severity: DiagnosticSeverity.Warning });
			if (stmt.else) {
				const elseIsEmptyStmt = stmt.else && stmt.else.kind === 'EmptyStmt';
				const elseEmptyBlock = stmt.else && stmt.else.kind === 'BlockStmt' && stmt.else.statements.length === 0;
				if (elseIsEmptyStmt || elseEmptyBlock) diagnostics.push({ code: LSL_DIAGCODES.EMPTY_ELSE_BODY, message: 'Empty else-body has no effect', range: spanToRange(doc, stmt.else.span), severity: DiagnosticSeverity.Warning });
			}
		}
	}

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
				const rt = toSimpleType(f.returns);
				functionReturnTypes.set(name, rt);
				if (rt === 'void' || isLslType(rt)) evalFunctionReturnTypes.set(name, rt);
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
		if (r === 'void' || isLslType(r)) evalFunctionReturnTypes.set(name, r);
		// no separate void set needed; we record 'void' in functionReturnTypes
	}

	// Validate global initializers with global scope types
	for (const [, g] of script.globals) {
		// Create a declaration entry for each user global (was previously missing)
		const name = g.name;
		const currentGlobal = isCurrentNode(g);
		// TEMP DEBUG: log global name for reserved identifier investigation
		try { if (process.env.LSL_DEBUG_RESERVED) console.log('[analyze-debug] global', name); } catch { /* ignore */ }
		// Reserved identifier check for global variable names
		if (currentGlobal && isReserved(defs, name)) {
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
		if (g.initializer) {
			if (currentGlobal) {
				walkExpr(g.initializer, globalScope, globalTypeScope);
				if (!isValidGlobalInitializer(g.initializer, globalScope)) {
					diagnostics.push({
						code: LSL_DIAGCODES.SYNTAX,
						message: 'Global initializer must be a literal, builtin constant, or previously declared global',
						range: spanToRange(doc, g.initializer.span),
						severity: DiagnosticSeverity.Error,
					});
				}
				validateOperatorsFromAst(doc, [g.initializer], diagnostics, globalTypeScope.view, functionReturnTypes, callSignatures, { constantNames, constantStringValues });
				validateInitializerType(g.varType, g.initializer, globalTypeScope);
			}
			currentValueEnv().setVar(name, coerceValueForDeclaredType(evalExpr(g.initializer, currentValueEnv()), g.varType));
		} else {
			const dv = zeroValueForType(g.varType);
			if (dv) currentValueEnv().setVar(name, dv);
		}
		globalScope.vars.set(name, d);
		addType(globalTypeScope, name, g.varType);
	}

	const globalNames = new Set(script.globals.keys());
	const mutatedGlobals = collectMutatedGlobalNames(globalNames);
	markMutatedValuesUnknown(mutatedGlobals, globalTypeScope);

	// Collect function/state/event declarations up-front so later analysis (refs, state-change validity) can resolve them.
	// Functions
	for (const [, f] of script.functions) {
		const name = f.name;
		const currentFunction = isCurrentNode(f);
		if (currentFunction && isReserved(defs, name)) {
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
	// Map include file -> range of its #include directive in root doc for duplicate diagnostics.
	const includeRangeByFile = new Map<string, { start: ReturnType<typeof doc.positionAt>; end: ReturnType<typeof doc.positionAt> }>();
	try {
		const targets = pre.includeTargets as undefined | { start: number; end: number; file: string; resolved: string | null }[];
		if (targets) for (const t of targets) { const r = { start: doc.positionAt(t.start), end: doc.positionAt(t.end) }; if (t.resolved) includeRangeByFile.set(t.resolved, r); includeRangeByFile.set(t.file, r); }
	} catch { /* ignore */ }

	for (const [, f] of script.functions) if (isCurrentNode(f)) visitFunction(f);
	for (const [, s] of script.states) if (isCurrentNode(s)) visitState(s);

	// After building declarations from the expanded AST, perform cross-include duplicate state detection.
	try {
		const expanded = pre.expandedTokens as unknown as Token[] | undefined;
		if (expanded && expanded.length) {
			const userStateNames = new Set<string>();
			for (const d of decls) if (d.kind === 'state') userStateNames.add(d.name);
			let primaryFsPath: string | undefined;
			try { primaryFsPath = doc.uri.startsWith('file://') ? fileUriToPath(doc.uri) : undefined; } catch { /* ignore */ }
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
		const lineSuppression = (map: Map<number, Set<string> | null>, line: number) => {
			if (map.has(line)) return map.get(line);
			return undefined;
		};
		finalDiagnostics = diagnostics.filter(d => {
			const startOff = doc.offsetAt(d.range.start);
			const zeroBasedLine = doc.positionAt(startOff).line; // 0-based
			// In preprocessing we stored line numbers as 0-based when calling lineOf(); convert consistently here.
			const hasCode = (set: Set<string> | null) => !set || set.has(d.code);
			// disable-line: same physical line (maps stored with 0-based line index)
			const s1 = lineSuppression(dd.disableLine, zeroBasedLine);
			if (s1 !== undefined && hasCode(s1)) return false;
			// disable-next-line: directive appears on previous line suppressing this one. Maps store directive line index.
			const sPrev = dd.disableNextLine.has(zeroBasedLine - 1) ? dd.disableNextLine.get(zeroBasedLine - 1) : undefined;
			if (sPrev !== undefined && hasCode(sPrev)) return false;
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
