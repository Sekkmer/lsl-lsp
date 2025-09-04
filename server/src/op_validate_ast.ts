import { TextDocument } from 'vscode-languageserver-textdocument';
import { DiagnosticSeverity } from 'vscode-languageserver/node';
import { Expr } from './ast';
import { inferExprTypeFromAst, isZeroLiteral, type SimpleType } from './ast/infer';
import { Diag, LSL_DIAGCODES } from './analysisTypes';
import { AssertNever } from './utils';

function mk(doc: TextDocument, start: number, end: number) {
	return { start: doc.positionAt(start), end: doc.positionAt(end) };
}

export function validateOperatorsFromAst(
	doc: TextDocument,
	exprs: Expr[],
	diagnostics: Diag[],
	symbolTypes: Map<string, SimpleType>,
	functionReturnTypes?: Map<string, SimpleType>,
	callSignatures?: Map<string, SimpleType[][]>,
	opts?: { flagSuspiciousAssignment?: boolean },
) {
	for (const e of exprs) walk(e);

	// Helper: report when an expression with inferred type 'void' is used as a value
	function pushVoidValueError(expr: Expr, inferred: SimpleType, ctx: 'binary' | 'unary' | 'cast'): boolean {
		if (inferred !== 'void') return false;
		const who = (expr.kind === 'Call' && expr.callee.kind === 'Identifier') ? `Function "${expr.callee.name}" ` : '';
		const where = ctx === 'binary' ? 'in binary expression' : ctx === 'unary' ? 'in unary expression' : 'in cast';
		diagnostics.push({
			code: LSL_DIAGCODES.WRONG_TYPE,
			message: `${who}returns void; cannot be used as a value ${where}`,
			range: mk(doc, expr.span.start, expr.span.end),
			severity: DiagnosticSeverity.Error,
		});
		return true;
	}

	function walk(e: Expr | null) {
		if (!e) return;
		switch (e.kind) {
			case 'Binary': {
				const lt = inferExprTypeFromAst(e.left, symbolTypes, functionReturnTypes);
				const leftVoid = pushVoidValueError(e.left, lt, 'binary');
				const rt = inferExprTypeFromAst(e.right, symbolTypes, functionReturnTypes);
				const rightVoid = pushVoidValueError(e.right, rt, 'binary');
				const op = e.op;
				// For compound assignments, ensure LHS is assignable (variable or member)
				if (op === '=' || op === '+=' || op === '-=' || op === '*=' || op === '/=' || op === '%=') {
					if (!isAssignable(e.left)) {
						diagnostics.push({
							code: LSL_DIAGCODES.INVALID_ASSIGN_LHS,
							message: 'Left-hand side of assignment must be a variable',
							range: mk(doc, e.span.start, e.span.end),
							severity: DiagnosticSeverity.Error,
						});
					}
				}
				// If either side is void, skip additional operator-specific checks to avoid noise
				if (leftVoid || rightVoid) {
					// recurse and exit this Binary
					walk(e.left); walk(e.right);
					break;
				}
				switch (op) {
					case '=': {
						// Only emit suspicious-assignment when explicitly validating a condition expression
						if (opts?.flagSuspiciousAssignment) {
							diagnostics.push({
								code: LSL_DIAGCODES.SUSPICIOUS_ASSIGNMENT,
								message: 'Suspicious assignment in condition: did you mean == ?',
								range: mk(doc, e.span.start, e.span.end),
								severity: DiagnosticSeverity.Information,
							});
						}
						break;
					}
					case '==':
					case '!=': {
						// Allow comparisons against empty list literal [] on either side
						const leftEmpty = e.left.kind === 'ListLiteral' && e.left.elements.length === 0;
						const rightEmpty = e.right.kind === 'ListLiteral' && e.right.elements.length === 0;
						// Be robust: detect list operands either via inference, literal kind, or symbol type mapping
						const leftIsList = lt === 'list' || e.left.kind === 'ListLiteral' || (e.left.kind === 'Identifier' && symbolTypes.get(e.left.name) === 'list');
						const rightIsList = rt === 'list' || e.right.kind === 'ListLiteral' || (e.right.kind === 'Identifier' && symbolTypes.get(e.right.name) === 'list');
						if ((leftIsList || leftEmpty) && (rightIsList || rightEmpty)) {
							if (leftEmpty || rightEmpty) { /* allow */ }
							else {
								diagnostics.push({
									code: LSL_DIAGCODES.LIST_COMPARISON_LENGTH_ONLY,
									message: `Comparing lists with ${e.op} compares only length (not contents)`,
									range: mk(doc, e.span.start, e.span.end),
									severity: DiagnosticSeverity.Information,
								});
							}
						}
						break;
					}
					case '/':
					case '/=': {
						if (isZeroLiteral(e.right)) {
							diagnostics.push({ code: LSL_DIAGCODES.WRONG_TYPE, message: 'Division by zero', range: mk(doc, e.span.start, e.span.end), severity: DiagnosticSeverity.Information });
						}
						break;
					}
					case '%':
					case '%=': {
						if (rt === 'integer' && isZeroLiteral(e.right)) {
							diagnostics.push({ code: LSL_DIAGCODES.WRONG_TYPE, message: 'Modulus by zero', range: mk(doc, e.span.start, e.span.end), severity: DiagnosticSeverity.Information });
						}
						const bothInt = lt === 'integer' && rt === 'integer';
						const bothVec = lt === 'vector' && rt === 'vector';
						const anyKnown = lt !== 'any' && rt !== 'any';
						if (anyKnown && !(bothInt || bothVec)) {
							diagnostics.push({ code: LSL_DIAGCODES.WRONG_TYPE, message: 'Operator % expects integer%integer or vector%vector', range: mk(doc, e.span.start, e.span.end), severity: DiagnosticSeverity.Information });
						}
						break;
					}
					case '&':
					case '|':
					case '^':
					case '<<':
					case '>>': {
						// Flag when either operand is known and non-integer; if both known and any is non-integer, also flag.
						const leftKnownNonInt = (lt !== 'any') && (lt !== 'integer');
						const rightKnownNonInt = (rt !== 'any') && (rt !== 'integer');
						if (leftKnownNonInt || rightKnownNonInt) {
							diagnostics.push({ code: LSL_DIAGCODES.WRONG_TYPE, message: `Operator ${e.op} expects integer operands`, range: mk(doc, e.span.start, e.span.end), severity: DiagnosticSeverity.Information });
						}
						break;
					}
					case '+':
					case '+=': {
						if (lt === 'list' || rt === 'list') {
							// ok
						} else if ((lt === 'string' && rt === 'string') || (num(lt) && num(rt)) || (lt === 'vector' && rt === 'vector') || (lt === 'rotation' && rt === 'rotation')) {
							// ok
						} else if (lt !== 'any' && rt !== 'any') {
							diagnostics.push({ code: LSL_DIAGCODES.WRONG_TYPE, message: `Operator + type mismatch: ${lt} + ${rt}`, range: mk(doc, e.span.start, e.span.end), severity: DiagnosticSeverity.Information });
						}
						break;
					}
					case '*':
					case '*=': {
						// Allowed combinations in LSL:
						// - vector * vector (dot product) [not for *=]
						// - number * number (integer/float)
						// - vector * number, number * vector (scaling)
						// - vector * rotation (rotate vector)
						const isVectorDot = (lt === 'vector' && rt === 'vector' && op !== '*=');
						const isNumericBoth = num(lt) && num(rt);
						const isVectorScale = (lt === 'vector' && num(rt)) || (num(lt) && rt === 'vector');
						const isVectorRotate = (lt === 'vector' && rt === 'rotation');
						if (isVectorDot || isNumericBoth || isVectorScale || isVectorRotate) {
							// ok
						} else if (lt !== 'any' && rt !== 'any') {
							diagnostics.push({ code: LSL_DIAGCODES.WRONG_TYPE, message: `Operator * type mismatch: ${lt} * ${rt}`, range: mk(doc, e.span.start, e.span.end), severity: DiagnosticSeverity.Information });
						}
						break;
					}
					case '-':
					case '-=': {
						// Subtraction: numeric only, but we don't currently emit diagnostics beyond other numeric checks
						// (Handled elsewhere by type inference if needed)
						break;
					}
					case '&&':
					case '||':
					case '<':
					case '<=':
					case '>':
					case '>=': {
						// Logical and relational operators: no additional diagnostics here
						break;
					}
					default:
						AssertNever(op, '<unknown operator>');
						break;
				}
				// recurse
				walk(e.left); walk(e.right);
				break;
			}
			case 'Unary': {
				// Validate unary operators (no longer require literals; only type-check when known)
				const argType = inferExprTypeFromAst(e.argument, symbolTypes, functionReturnTypes);
				if (pushVoidValueError(e.argument, argType, 'unary')) { walk(e.argument); break; }
				const isNum = (t: SimpleType) => t === 'integer' || t === 'float';
				const op = e.op;
				switch (op) {
					case '+':
					case '-': {
						// If argument type is known and not numeric, hint
						if (argType !== 'any' && !isNum(argType)) {
							diagnostics.push({
								code: LSL_DIAGCODES.WRONG_TYPE,
								message: `Unary operator ${op} expects a numeric value`,
								range: mk(doc, e.span.start, e.span.end),
								severity: DiagnosticSeverity.Information,
							});
						}
						break;
					}
					case '!':
					case '~': {
						// If argument type is known and not integer, hint
						if (argType !== 'any' && argType !== 'integer') {
							diagnostics.push({
								code: LSL_DIAGCODES.WRONG_TYPE,
								message: `Unary operator ${op} expects an integer value`,
								range: mk(doc, e.span.start, e.span.end),
								severity: DiagnosticSeverity.Information,
							});
						}
						break;
					}
					case '++':
					case '--': {
						// ++/-- require an assignable variable and integer type when known
						if (!isAssignable(e.argument)) {
							diagnostics.push({
								code: LSL_DIAGCODES.INVALID_ASSIGN_LHS,
								message: `Operand of ${op} must be a variable`,
								range: mk(doc, e.span.start, e.span.end),
								severity: DiagnosticSeverity.Error,
							});
						}
						if (argType !== 'any' && argType !== 'integer') {
							diagnostics.push({
								code: LSL_DIAGCODES.WRONG_TYPE,
								message: `Operator ${op} expects an integer variable`,
								range: mk(doc, e.span.start, e.span.end),
								severity: DiagnosticSeverity.Information,
							});
						}
						break;
					}
					default:
						// Unknown unary operator: ignore at runtime to avoid aborting validation
						break;
				}
				// Recurse into the argument to catch nested operators
				walk(e.argument);
				break;
			}
			case 'Paren': {
				walk(e.expression);
				break;
			}
			case 'Call': {
				// Walk callee and args
				walk(e.callee);
				e.args.forEach(walk);
				// If callee is an identifier and we have signatures, validate arg types
				if (e.callee.kind === 'Identifier' && callSignatures) {
					const name = e.callee.name;
					const cands = callSignatures.get(name);
					if (cands && cands.length > 0) {
						const argTypes = e.args.map(a => inferExprTypeFromAst(a, symbolTypes, functionReturnTypes));
						const sameArity = cands.filter(p => p.length === argTypes.length);
						if (sameArity.length > 0) {
							let matched = false;
							for (const params of sameArity) {
								let ok = true;
								for (let k = 0; k < params.length; k++) {
									if (!argTypeMatches(params[k]!, argTypes[k]!)) { ok = false; break; }
								}
								if (ok) { matched = true; break; }
							}
							if (!matched) {
								const params = sameArity[0]!;
								for (let k = 0; k < params.length; k++) {
									if (!argTypeMatches(params[k]!, argTypes[k]!)) {
										diagnostics.push({
											code: LSL_DIAGCODES.WRONG_TYPE,
											message: `Argument ${k + 1} of "${name}" expects ${params[k]}, got ${argTypes[k]}`,
											range: mk(doc, e.args[k]!.span.start, e.args[k]!.span.end),
											severity: DiagnosticSeverity.Error,
										});
										break;
									}
								}
							}
						} else {
							// Wrong arity: no signature matches the provided argument count
							// Prefer the first candidate to compute expected arity message (may be overloaded)
							const expected = cands[0] ? cands[0]!.length : 0;
							diagnostics.push({
								code: LSL_DIAGCODES.WRONG_ARITY,
								message: `Function ${name} expects ${expected} parameter(s), got ${e.args.length}`,
								range: mk(doc, e.span.start, e.span.end),
								severity: DiagnosticSeverity.Error,
							});
						}
					}
				}
				break;
			}
			case 'Cast': {
				// Walk down the argument
				walk(e.argument);
				// Validate cast semantics based on inferred type
				const target = e.type as SimpleType; // AST guarantees a known LSL type
				const src = inferExprTypeFromAst(e.argument, symbolTypes, functionReturnTypes);
				if (pushVoidValueError(e.argument, src, 'cast')) break;
				// Rule 0: casting from 'any' is always ok (unknown at analysis time)
				if (src === 'any') break;
				// Rule 1: cast to itself is allowed but warn and propose quick fix to drop cast
				if (src === target) {
					diagnostics.push({
						code: LSL_DIAGCODES.REDUNDANT_CAST,
						message: `Redundant cast to ${target}`,
						range: mk(doc, e.span.start, e.span.end),
						severity: DiagnosticSeverity.Hint,
					});
					break;
				}
				// Rule 2: everything can be cast to string
				if (target === 'string') {
					// Extra: if argument is a string literal, it's already a string (would have triggered rule 1),
					// for non-string literals, all ok. No extra checks here (LSL stringification is permissive).
					break;
				}
				// Rule 3: everything can be cast to list
				if (target === 'list') break;
				// Rule 4: int <-> float is ok
				if ((target === 'integer' && src === 'float') || (target === 'float' && src === 'integer')) break;
				// Rule 5 (user numbering has 6 forbidden): other casts are forbidden, except from string literal to vector/rotation/integer/float/key with validation
				// Special handling: casting FROM string literal has specific acceptance patterns in LSL
				if (e.argument.kind === 'StringLiteral') {
					const s = e.argument.value;
					if (target === 'integer') {
						// Accepts trims + decimal/hex prefixes, trailing garbage ignored; invalid -> 0, but allow with information
						if (!looksLikeIntegerString(s)) {
							diagnostics.push({ code: LSL_DIAGCODES.WRONG_TYPE, message: 'Casting string to integer may not parse as number (results in 0)', range: mk(doc, e.span.start, e.span.end), severity: DiagnosticSeverity.Information });
						}
						break;
					}
					if (target === 'float') {
						if (!looksLikeFloatString(s)) {
							diagnostics.push({ code: LSL_DIAGCODES.WRONG_TYPE, message: 'Casting string to float may not parse as number (NaN/Infinity behavior differs by runtime)', range: mk(doc, e.span.start, e.span.end), severity: DiagnosticSeverity.Information });
						}
						break;
					}
					if (target === 'vector' || target === 'rotation') {
						if (!looksLikeVectorOrRotationString(s, target)) {
							diagnostics.push({ code: LSL_DIAGCODES.WRONG_TYPE, message: `Casting string to ${target} requires ${target === 'vector' ? '"<x, y, z>"' : '"<x, y, z, s>"'} format`, range: mk(doc, e.span.start, e.span.end), severity: DiagnosticSeverity.Information });
						}
						break;
					}
					if (target === 'key') {
						if (!looksLikeKeyString(s)) {
							diagnostics.push({ code: LSL_DIAGCODES.WRONG_TYPE, message: 'Casting string to key requires a UUID-like value', range: mk(doc, e.span.start, e.span.end), severity: DiagnosticSeverity.Information });
						}
						break;
					}
				}
				// Special case: if casting from string, allow
				if (src === 'string') break;
				// If not covered by special-cases above, forbid
				diagnostics.push({ code: LSL_DIAGCODES.WRONG_TYPE, message: `Cannot cast ${src} to ${target}`, range: mk(doc, e.span.start, e.span.end), severity: DiagnosticSeverity.Error });
				break;
			}
			case 'ListLiteral': {
				// Walk and validate elements: LSL does not allow lists inside lists
				for (const comp of e.elements) {
					walk(comp);
					const ct = inferExprTypeFromAst(comp, symbolTypes, functionReturnTypes);
					const isListy = ct === 'list'
						|| comp.kind === 'ListLiteral'
						|| (comp.kind === 'Identifier' && symbolTypes.get(comp.name) === 'list');
					if (isListy) {
						diagnostics.push({
							code: LSL_DIAGCODES.WRONG_TYPE,
							message: 'List element cannot be a list',
							range: mk(doc, comp.span.start, comp.span.end),
							severity: DiagnosticSeverity.Error,
						});
					}
				}
				break;
			}
			case 'VectorLiteral': {
				// Each element in a vector literal should be numeric (integer or float).
				// If we can infer a non-numeric, known type, flag it; otherwise allow 'any'.
				for (const comp of e.elements) {
					walk(comp); // continue walking inside component expressions
					const ct = inferExprTypeFromAst(comp, symbolTypes, functionReturnTypes);
					if (ct !== 'any' && ct !== 'integer' && ct !== 'float') {
						diagnostics.push({
							code: LSL_DIAGCODES.WRONG_TYPE,
							message: 'Vector component must be numeric (integer or float)',
							range: mk(doc, comp.span.start, comp.span.end),
							severity: DiagnosticSeverity.Information,
						});
					}
				}
				break;
			}
			case 'Member': {
				walk(e.object);
				const type = inferExprTypeFromAst(e.object, symbolTypes, functionReturnTypes);
				if (type !== 'any' && type !== 'vector' && type !== 'rotation') {
					diagnostics.push({
						code: LSL_DIAGCODES.WRONG_TYPE,
						message: `Member access on non-vector/rotation type ${type}`,
						range: mk(doc, e.span.start, e.span.end),
						severity: DiagnosticSeverity.Error,
					});
				}
				// Validate known component names for vector/rotation
				if (type === 'vector') {
					const ok = e.property === 'x' || e.property === 'y' || e.property === 'z';
					if (!ok) diagnostics.push({ code: LSL_DIAGCODES.UNKNOWN_IDENTIFIER, message: `Unknown member ".${e.property}" for vector`, range: mk(doc, e.span.start, e.span.end), severity: DiagnosticSeverity.Warning });
				}
				if (type === 'rotation') {
					const ok = e.property === 'x' || e.property === 'y' || e.property === 'z' || e.property === 's';
					if (!ok) diagnostics.push({ code: LSL_DIAGCODES.UNKNOWN_IDENTIFIER, message: `Unknown member ".${e.property}" for rotation`, range: mk(doc, e.span.start, e.span.end), severity: DiagnosticSeverity.Warning });
				}
				break;
			}
			case 'Identifier': break;
			case 'NumberLiteral': break;
			case 'StringLiteral': break;
			default:
				// Unknown expression kind: ignore gracefully
				break;
		}
	}
	function num(t: SimpleType) { return t === 'integer' || t === 'float'; }
	function argTypeMatches(expected: SimpleType, got: SimpleType): boolean {
		if (expected === 'any' || got === 'any') return true;
		if (expected === got) return true;
		// Allow weak numeric coercions similar to LSL
		if (expected === 'integer' && got === 'float') return true;
		if (expected === 'float' && got === 'integer') return true;
		// LSL implicitly stringifies many values when a string is expected
		if (expected === 'string' && (got === 'integer' || got === 'float' || got === 'key')) return true;
		return false;
	}
	function isAssignable(n: Expr): boolean {
		switch (n.kind) {
			case 'Identifier': return true;
			case 'Member': return isAssignable(n.object); // allow nested like obj.x.y if language permits
			default: return false; // literals, calls, casts, etc.
		}
	}
}

// Helpers for string literal validation of casts
function looksLikeIntegerString(s: string): boolean {
	// Allow optional spaces, optional sign, hex 0x... or decimal digits
	s = s.trim();
	if (/^[+-]?0x[0-9a-fA-F]+/.test(s)) return true;
	if (/^[+-]?\d+/.test(s)) return true;
	return false;
}

function looksLikeFloatString(s: string): boolean {
	s = s.trim();
	// Decimal float with optional exponent
	if (/^[+-]?(?:\d*\.\d+|\d+\.\d*|\d+)(?:[eE][+-]?\d+)?/.test(s)) return true;
	// C99-style hex float like 0x1.fp3 or 0x1.f
	if (/^[+-]?0x[0-9a-fA-F]+(?:\.[0-9a-fA-F]*)?(?:p[+-]?\d+)?$/i.test(s)) return true;
	// NaN/Infinity prefixes
	if (/^\s*(nan|inf)/i.test(s)) return true;
	return false;
}

function looksLikeVectorOrRotationString(s: string, target: 'vector' | 'rotation'): boolean {
	// Minimal check: <a, b, c> or <a, b, c, d>
	const m = /^\s*<\s*[^,>]+\s*,\s*[^,>]+\s*,\s*[^,>]+\s*(?:,\s*[^,>]+\s*)?>\s*$/.exec(s);
	if (!m) return false;
	const has4 = /,\s*[^,>]+\s*>\s*$/.test(s.trim());
	return target === 'vector' ? !has4 : has4;
}

function looksLikeKeyString(s: string): boolean {
	// UUID format 8-4-4-4-12 hex
	return /^\s*[0-9a-fA-F]{8}-([0-9a-fA-F]{4}-){3}[0-9a-fA-F]{12}\s*$/.test(s);
}
