import { describe, it, expect } from 'vitest';
import { parseScriptFromText } from '../../../src/ast/parser';

// Ensure parser doesn't loop on missing closing delimiters and emits useful diagnostics

describe('AST parser recovery: missing delimiters', () => {
	it('missing ) in call args recovers', () => {
		const src = [
			'state default {',
			'    event(){',
			'        llSay(0, "x"',
			'        integer y = 1;',
			'    }',
			'}',
		].join('\n');
		const s = parseScriptFromText(src);
		// still parse state and event
		expect(s.states.has('default')).toBe(true);
		const msgs = (s.diagnostics||[]).map(d => d.message).join('\n');
		expect(msgs).toMatch(/missing .*\) .*close/i);
	});

	it('missing ] in list literal recovers', () => {
		const src = [
			'integer x;',
			'state default {',
			'    event(){',
			'        list L = [1, 2, 3;',
			'        x = 1;',
			'    }',
			'}',
		].join('\n');
		const s = parseScriptFromText(src);
		expect(s.states.has('default')).toBe(true);
		const msgs = (s.diagnostics||[]).map(d => d.message).join('\n');
		expect(msgs).toMatch(/missing .*\] .*close/i);
	});

	it('missing ) in parameter list recovers', () => {
		const src = [
			'integer f(integer a, integer b {',
			'    return a + b;',
			'}',
			'state default { event(){ } }',
		].join('\n');
		const s = parseScriptFromText(src);
		expect(s.functions.has('f')).toBe(true);
		const msgs = (s.diagnostics||[]).map(d => d.message).join('\n');
		expect(msgs).toMatch(/missing .*\) .*parameter/i);
	});
});
