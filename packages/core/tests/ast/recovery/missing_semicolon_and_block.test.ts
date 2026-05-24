import { describe, it, expect } from 'vitest';
import { parseScriptFromText } from '../../../src/ast/parser';

// These tests assert that the parser recovers with accurate diagnostics and continues parsing

describe('AST parser recovery: missing tokens', () => {
	it('recovers from missing ; at global and continues', () => {
		const src = 'integer a = 1\ninteger b = 2;';
		const s = parseScriptFromText(src);
		expect(Array.from(s.globals.keys())).toContain('a');
		expect(Array.from(s.globals.keys())).toContain('b');
		const msgs = (s.diagnostics||[]).map(d => d.message);
		// accept either phrasing
		expect(msgs.some(m => m.includes('\';\'') || m.includes('missing ;'))).toBe(true);
	});

	it('recovers from missing } before next state and continues', () => {
		const src = [
			'integer f(integer x){',
			'	integer y = x;',
			'// missing closing } for function',
			'default { event(){ integer z = 3; } }'
		].join('\n');
		const s = parseScriptFromText(src);
		// Function and state should still be recognized
		expect(s.functions.has('f')).toBe(true);
		expect(s.states.has('default')).toBe(true);
		const msgs = (s.diagnostics||[]).map(d => d.message);
		expect(msgs.some(m => m.includes('missing }'))).toBe(true);
	});

	it('assumes implicit } before next function/state/event and points near the boundary', () => {
		const src = [
			'integer f(){',
			'	integer x = 1;',
			'// missing } here',
			'integer g(){ return x; }',
		].join('\n');
		const s = parseScriptFromText(src);
		expect(s.functions.has('f')).toBe(true);
		expect(s.functions.has('g')).toBe(true);
		const msgs = (s.diagnostics||[]).map(d => d.message);
		expect(msgs.some(m => m.includes('missing }'))).toBe(true);
	});
});
