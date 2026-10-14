import { describe, expect, it } from 'vitest';
import { isNumberLiteral, parseHexFloat, parseNumberLiteral } from '../src/ast/numberLiteral';
import { parseScriptFromText } from '../src/ast/parser';
import { optimizeScript } from '../src/ast/optimize';
import { Tokenizer } from '../src/core/tokenizer';
import { Lexer } from '../src/ast/lexer';

describe('number literal syntax', () => {
	// Native compiler evidence: .local/review-2026-10/{literal,suffix}-results.json.
	it.each(['1e', '1e+', '1e-', '1e2suffix', '12suffix', '0x', '0x1p', '0x1p+', '0x1.fp3', '0x1.p2', '0x1.f', '1f', '1e3f', '.', '+', '--1', '1.2.3', 'Infinity', 'NaN'])('rejects incomplete or partially numeric input %s', raw => {
		expect(isNumberLiteral(raw)).toBe(false);
		expect(parseNumberLiteral(raw)).toBeNull();
	});

	it.each([
		['0', 'integer', 0], ['012', 'integer', 12], ['-42', 'integer', -42],
		['.5', 'float', 0.5], ['1.', 'float', 1], ['1e3', 'float', 1000],
		['1.e-2', 'float', 0.01], ['+.5E+2', 'float', 50],
		['0x1e', 'integer', 30], ['-0x1e', 'integer', -30],
		['1.5f', 'float', 1.5], ['1.5F', 'float', 1.5], ['.5f', 'float', 0.5],
		['1.f', 'float', 1], ['1.e3F', 'float', 1000],
	] as const)('fully parses %s', (raw, type, value) => {
		expect(isNumberLiteral(raw)).toBe(true);
		expect(parseNumberLiteral(raw)).toEqual({ type, value });
	});

	it.each(['1e', '1e+', '1e-', '0x', '0x1p', '0x1p+', '0x1.fp3', '0x1.f', '0x1.p2'])('reports malformed source token %s before optimization', raw => {
		const script = parseScriptFromText(`default { state_entry() { float value = ${raw}; } }`);
		expect(script.diagnostics?.some(d => d.code === 'LSL000' && d.message.includes('Invalid number literal'))).toBe(true);
		// Evaluation of a malformed literal stays unknown; folding must not silently
		// repair the user's source into a different valid number.
		expect(optimizeScript(script).code).toContain(raw);
	});

	it('keeps hexadecimal string conversion separate from native literal syntax', () => {
		expect(parseHexFloat('0x1.fp3')).toBe(15.5);
		expect(parseHexFloat('0x1.p2')).toBe(4);
		expect(parseHexFloat('0x1.f')).toBe(1.9375);
	});

	it.each(['1.5f', '1.5F', '.5f', '1.f', '1.e3F'])('tokenizes float suffix %s consistently and preserves float type in optimization', raw => {
		for (const Scanner of [Lexer, Tokenizer]) {
			const scanner = new Scanner(raw);
			expect(scanner.next()).toMatchObject({ kind: 'number', value: raw });
			expect(scanner.next().kind).toBe('eof');
		}
		const script = parseScriptFromText(`default { state_entry() { float value = ${raw}; } }`);
		expect(script.diagnostics).toEqual([]);
		expect(optimizeScript(script).code).not.toContain(raw);
		expect(parseScriptFromText(optimizeScript(script).code).diagnostics).toEqual([]);
	});

	it.each(['1f', '1e3f', '1.0 f', '1.0 /*suffix*/ F'])('rejects suffix placement rejected by the native compiler: %s', raw => {
		const script = parseScriptFromText(`float value = ${raw}; default { state_entry() {} }`);
		expect(script.diagnostics?.some(d => d.severity === 'error')).toBe(true);
	});

	it('distinguishes valid overflow syntax from a finite value available to the evaluator', () => {
		expect(isNumberLiteral('1e400')).toBe(true);
		expect(parseNumberLiteral('1e400')).toBeNull();
		expect(parseScriptFromText('float value = 1e400; default { state_entry() {} }').diagnostics).toEqual([]);
	});
});
