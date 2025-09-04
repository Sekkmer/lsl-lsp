import { describe, it, expect } from 'vitest';
import { parseScriptFromText } from '../../src/ast/parser';

describe('AST parser: expressions smoke', () => {
	it('parses calls, members, lists, vectors', () => {
		const src = 'integer f(integer a){ return a; }\nvector v = <1,2,3>; list L = [1,2,3]; integer y = f(1+2).z;';
		const script = parseScriptFromText(src);
		expect(script.globals.has('v')).toBe(true);
		expect(script.globals.has('L')).toBe(true);
		expect(script.globals.has('y')).toBe(true);
	});
});
