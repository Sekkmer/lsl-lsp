import { describe, it, expect } from 'vitest';
import { parseScriptFromText } from '../src/ast/parser';

describe('preproc: stringify and paste', () => {
	it('stringification with #', () => {
		const src = `
			#define STR(x) #x

			default { state_entry(){ string s = STR(hello world); } }
		`;
		const script = parseScriptFromText(src);
		const st = script.states.get('default');
		expect(st).toBeTruthy();
		const ev = st!.events[0]!;
		const stmt = (ev.body as any).statements[0];
		expect(stmt.kind).toBe('VarDecl');
		const init = stmt.initializer;
		expect(init.kind).toBe('StringLiteral');
		expect(init.value).toBe('hello world');
	});

	it('token pasting with ##', () => {
		const src = `
			#define CAT(a,b) a##b

			default { state_entry(){ integer n1 = 1; integer x = CAT(n,1); } }
		`;
		const script = parseScriptFromText(src);
		const st = script.states.get('default');
		expect(st).toBeTruthy();
		const ev = st!.events[0]!;
		const stmt = (ev.body as any).statements[1];
		expect(stmt.kind).toBe('VarDecl');
		const init = stmt.initializer;
		expect(init.kind).toBe('Identifier');
		expect(init.name).toBe('n1');
	});
});
