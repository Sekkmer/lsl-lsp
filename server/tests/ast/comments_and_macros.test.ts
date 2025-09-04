import { describe, it, expect } from 'vitest';
import { parseScriptFromText } from '../../src/ast/parser';

describe('AST parser: comments and macros', () => {
	it('attaches preceding comments to functions and globals', () => {
		const src = '// line doc\n/* multi\nline */\ninteger foo() { return 1; }\n\n// gv doc\nfloat PI = 3.14;';
		const script = parseScriptFromText(src);
		const fn = script.functions.get('foo');
		expect(fn).toBeTruthy();
		expect(fn!.comment).toContain('line doc');
		expect(fn!.comment).toContain('multi');
		const gv = script.globals.get('PI');
		expect(gv).toBeTruthy();
		expect(gv!.comment).toContain('gv doc');
	});

	it('expands object-like macros', () => {
		const src = '#define TEN 10\ninteger x = TEN + 5;';
		const script = parseScriptFromText(src);
		const gv = script.globals.get('x');
		expect(gv).toBeTruthy();
		// Expect initializer to be Binary(Number(10), '+', Number(5))
		const init = gv!.initializer!;
		expect(init.kind).toBe('Binary');
		const left = init.left;
		expect(left.kind).toBe('NumberLiteral');
		expect(left.raw).toBe('10');
	});

	it('expands simple function-like macros', () => {
		const src = '#define ADD(a,b) ((a)+(b))\ninteger x = ADD(2,3);';
		const script = parseScriptFromText(src);
		const gv = script.globals.get('x');
		const init = gv!.initializer!;
		expect(init.kind).toBe('Binary');
	});

	it('expands built-in __LINE__ and __FILE__ macros', () => {
		const src = [
			'integer a = __LINE__;',
			'// next line uses __FILE__',
			'string f = __FILE__;',
		].join('\n');
		const script = parseScriptFromText(src, 'file:///path/to/test.lsl');
		const a = script.globals.get('a');
		expect(a).toBeTruthy();
		const fa = a!.initializer!;
		expect(fa.kind).toBe('NumberLiteral');
		expect(fa.raw).toBe('1'); // first line
		const f = script.globals.get('f');
		expect(f).toBeTruthy();
		const fi = f!.initializer!;
		expect(fi.kind).toBe('StringLiteral');
		// should be quoted basename of uri
		expect(fi.value).toBe('test.lsl');
	});
});
