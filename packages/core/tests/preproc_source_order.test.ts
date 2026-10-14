import { describe, expect, it } from 'vitest';
import { preprocessForAst } from '../src/core/pipeline';

function values(source: string) {
	return preprocessForAst(source, { includePaths: [] }).expandedTokens.filter(t => t.kind !== 'eof').map(t => t.value);
}

describe('preprocessor source order and token substitution', () => {
	it('uses the macro definition at each use, including before define and after undef', () => {
		expect(values('integer a = N;\n#define N 1\ninteger b = N;\n#undef N\n#define N 2\ninteger c = N;\n#undef N\ninteger d = N;'))
			.toEqual(['integer', 'a', '=', 'N', ';', 'integer', 'b', '=', '1', ';', 'integer', 'c', '=', '2', ';', 'integer', 'd', '=', 'N', ';']);
	});

	it('evaluates nested conditions using definitions encountered inside their parent', () => {
		expect(values('#if 1\n#define N 2\n#if N == 2\ninteger yes;\n#else\ninteger no;\n#endif\n#endif'))
			.toEqual(['integer', 'yes', ';']);
	});

	it('evaluates expanded arithmetic macros and hexadecimal constants in conditions', () => {
		const result = preprocessForAst('#define N (2 + 3)\n#if defined(N) && N == 5 && 0x10 == 16\ninteger yes;\n#else\ninteger no;\n#endif', { includePaths: [] });
		expect(result.expandedTokens.filter(t => t.kind === 'id').map(t => t.value)).toEqual(['yes']);
		expect(result.preprocDiagnostics).toEqual([]);
	});

	it('propagates undef through includes and reports unresolved nested includes', () => {
		const source = '#define N 1\ninteger before = N;\n#include "first.lsl"\n#ifdef N\ninteger wrong;\n#endif\ninteger after = N;';
		const result = preprocessForAst(source, {
			fromPath: '/v/main.lsl', includePaths: [],
			fs: { readFileSync: ((path: string) => {
				if (path === '/v/first.lsl') return '#undef N\n#include "missing.lsl"';
				throw new Error('not found');
			}) as typeof import('node:fs').readFileSync },
		});
		expect(result.expandedTokens.filter(t => t.kind !== 'eof').map(t => t.value)).toEqual(['integer', 'before', '=', '1', ';', 'integer', 'after', '=', 'N', ';']);
		expect(result.macros).not.toHaveProperty('N');
		expect(result.missingIncludes).toEqual([expect.objectContaining({ file: 'missing.lsl' })]);
		expect(result.preprocDiagnostics).toContainEqual(expect.objectContaining({ code: 'LSL-include-missing', file: '/v/first.lsl' }));
	});

	it('treats whitespace before parentheses as an object macro', () => {
		expect(values('#define N (1) + 2\ninteger a = N;')).toEqual(['integer', 'a', '=', '(', '1', ')', '+', '2', ';']);
	});

	it('keeps parameters and cleanup-looking characters inside strings unchanged', () => {
		expect(values('#define ECHO(x) llOwnerSay("x,,);;a##b"); llOwnerSay(x)\nECHO("hello")'))
			.toEqual(['llOwnerSay', '(', '"x,,);;a##b"', ')', ';', 'llOwnerSay', '(', '"hello"', ')']);
	});

	it('substitutes each parameter once and preserves dollar characters in arguments', () => {
		expect(values('#define PAIR(a,b) [a,b]\nPAIR(b,"$&")')).toEqual(['[', 'b', ',', '"$&"', ']']);
	});

	it('stringifies quoted arguments with their quotes and does not replace text in the result', () => {
		const output = values('#define STR(x) #x\nSTR("x")');
		expect(output).toEqual([JSON.stringify('"x"')]);
	});

	it('expands empty function macros without leaving a function call', () => {
		expect(values('#define IGNORE(x)\nIGNORE(1)\ninteger a;')).toEqual(['integer', 'a', ';']);
	});

	it('preserves empty for-loop clauses in macro bodies', () => {
		expect(values('#define LOOP(x) for(x;;) {}\nLOOP(i = 0)')).toEqual(['for', '(', 'i', '=', '0', ';', ';', ')', '{', '}']);
	});

	it('preserves separated operators through nested macro argument expansion', () => {
		expect(values('#define ID(x) x\n#define WRAP(x) ID(x)\nWRAP(a - -b)'))
			.toEqual(['a', '-', '-', 'b']);
	});

	it('normalizes existing whitespace when stringifying without merging tokens', () => {
		expect(values('#define STR(x) #x\nSTR(a  +  b)')).toEqual(['"a + b"']);
	});

	it('preserves boolean configuration defines in conditional expressions', () => {
		const result = preprocessForAst('#if ENABLED && !DISABLED\ninteger yes;\n#endif', { includePaths: [], defines: { ENABLED: true, DISABLED: false } });
		expect(result.expandedTokens.filter(t => t.kind === 'id').map(t => t.value)).toEqual(['yes']);
	});

	it('retains object/function macro kinds when carrying definitions into a new preprocessing call', () => {
		const first = preprocessForAst('#define N (x) + 2\n#define F(x) x', { includePaths: [] });
		const second = preprocessForAst('integer a = N;\ninteger b = F(3);', { includePaths: [], defines: first.macros });
		expect(second.expandedTokens.filter(t => t.kind !== 'eof').map(t => t.value)).toEqual(['integer', 'a', '=', '(', 'x', ')', '+', '2', ';', 'integer', 'b', '=', '3', ';']);
		expect(second.funcMacros).not.toHaveProperty('N');
		expect(second.funcMacros).toHaveProperty('F');
	});

	it('expands optional varargs containing quoted text and its separator', () => {
		const define = '#define M(...) [__VA_OPT__("present",)__VA_ARGS__]\n';
		expect(values(define + 'M(1)')).toEqual(['[', '"present"', ',', '1', ']']);
		expect(values(define + 'M()')).toEqual(['[', ']']);
	});

	it('balances nested calls inside optional varargs while ignoring quoted parentheses', () => {
		const define = '#define M(...) [__VA_OPT__(llList2String(["a)b"], (0)),)__VA_ARGS__]\n';
		expect(values(define + 'M(1)')).toEqual(['[', 'llList2String', '(', '[', '"a)b"', ']', ',', '(', '0', ')', ')', ',', '1', ']']);
		expect(values(define + 'M()')).toEqual(['[', ']']);
	});

	it('preserves quoted marker text and protects literals following stringification', () => {
		expect(values('#define M(x,...) #x, "x __VA_OPT__(literal)", __VA_OPT__("present",) __VA_ARGS__\nM(name,1)'))
			.toEqual(['"name"', ',', '"x __VA_OPT__(literal)"', ',', '"present"', ',', '1']);
	});
});
