import { describe, expect, it } from 'vitest';
import { optimizeScript, parseScriptFromText } from '../src';

const options = { inlineFunctions: true, removeUnusedFunctions: true, maxPasses: 12, constantFold: false };

function optimized(source: string) {
	const result = optimizeScript(parseScriptFromText(source), options);
	expect(parseScriptFromText(result.code).diagnostics.filter(d => d.severity === 'error')).toEqual([]);
	return result.code;
}

describe('optimizer review regressions', () => {
	it('keeps mutations of value parameters inside their original call frame', () => {
		const code = optimized('integer f(integer x) { return ++x; } default { touch_start(integer n) { llOwnerSay((string)f(n)); llOwnerSay((string)n); } }');
		expect(code).toContain('return ++x;');
		expect(code).toContain('f(n)');
		expect(code).not.toContain('++n');
	});

	it('retains implicit integer-to-float parameter conversion when inlining', () => {
		const code = optimized('string f(float x) { return (string)x; } default { touch_start(integer n) { llOwnerSay(f(n)); } }');
		expect(code).not.toContain('f(');
		expect(code).toContain('llOwnerSay((string)((float)n));');
	});

	it('retains implicit integer-to-float return conversion when inlining', () => {
		const code = optimized('float f(integer x) { return x; } default { touch_start(integer n) { llOwnerSay((string)f(n)); } }');
		expect(code).not.toContain('f(');
		expect(code).toContain('llOwnerSay((string)((float)n));');
	});

	it('captures global argument values before a callee can mutate them', () => {
		const code = optimized('integer x; integer mutate() { x=10; return 1; } integer f(integer p) { return p+mutate(); } default { state_entry() { x=2; llOwnerSay((string)f(x)); } }');
		expect(code).toContain('f(x)');
		expect(code).not.toContain('x+mutate()');
	});

	it('preserves a statement helper global reference when its caller shadows it', () => {
		const code = optimized('integer x=7; show() { llOwnerSay((string)x); } default { touch_start(integer x) { show(); } }');
		expect(code).toContain('show(){llOwnerSay((string)x);}');
		expect(code).toContain('touch_start(integer x){show();}');
	});

	it('keeps declaration conversions when propagating a local alias', () => {
		const code = optimized('default { touch_start(integer n) { float a=n; llOwnerSay((string)a); } }');
		expect(code).toContain('llOwnerSay((string)((float)n));');
	});

	it('keeps a local snapshot across calls which can mutate its source global', () => {
		const code = optimized('integer x; integer mutate() { x=10; return 1; } default { state_entry() { x=2; integer a=x; mutate(); llOwnerSay((string)a); } }');
		expect(code).toContain('integer a=x;');
		expect(code).toContain('llOwnerSay((string)a);');
	});

	it('does not treat a global as a local before a later shadow declaration', () => {
		const code = optimized('integer x; integer mutate() { x=10; return 1; } default { state_entry() { integer saved=x; mutate(); integer x=99; llOwnerSay((string)saved); llOwnerSay((string)x); } }');
		expect(code).toContain('integer saved=x;');
		expect(code).toContain('llOwnerSay((string)saved);');
	});

	it('retains global assignments before a later local shadows the same name', () => {
		const code = optimized('integer x; default { state_entry() { x=7; integer x=99; llOwnerSay((string)x); } touch_start(integer n) { llOwnerSay((string)x); } }');
		expect(code).toContain('state_entry(){x=7;');
	});

	it('does not widen a nested local scope to capture an outer variable', () => {
		const code = optimized('integer x; default { state_entry() { { integer x=llGetUnixTime(); ++x; llOwnerSay((string)x); } llOwnerSay((string)x); } }');
		expect(code).toContain('{integer x=llGetUnixTime();++x;llOwnerSay((string)x);}llOwnerSay((string)x);');
	});

	it('invalidates facts before reads in the same expression as a write', () => {
		const code = optimized('default { state_entry() { integer x=1; llOwnerSay((string)(x+(x=2))); } }');
		expect(code).toContain('x+(x=2)');
		expect(code).not.toContain('1+(x=2)');
	});

	it('preserves empty handlers which control child-prim event propagation', () => {
		const code = optimized('default { state_entry() { llOwnerSay("ready"); } touch_start(integer n) {} collision_start(integer n) {} }');
		expect(code).toContain('touch_start(integer n){}');
		expect(code).toContain('collision_start(integer n){}');
	});

	it('does not mistake hexadecimal nonzero for zero in a list helper rewrite', () => {
		const code = optimized('default { touch_start(integer n) { list xs=[n]; llOwnerSay((string)llDeleteSubList(xs,0x10,-1)); } }');
		expect(code).toContain('llDeleteSubList(');
	});

	it('keeps scalar arithmetic grouped when appending a cast to list', () => {
		const result = optimizeScript(parseScriptFromText('default { touch_start(integer n) { list xs=["old"]; xs+=(list)(n+1); llOwnerSay((string)xs); } }'), { listAdd: true, constantFold: false });
		expect(result.code).toContain('xs=xs+(n+1);');
		expect(result.code).not.toContain('xs=xs+n+1;');
	});

	it('keeps side-effecting list elements in left-to-right order', () => {
		const result = optimizeScript(parseScriptFromText('default { state_entry() { integer n=0; list xs=[n++,n++]; llOwnerSay(llDumpList2String(xs,",")); } }'), { listAdd: true, constantFold: false });
		expect(result.code).toContain('list xs=[n++,n++];');
	});

	it('does not discard a pure helper whose loop may never return', () => {
		const code = optimized('integer f(integer x) { while(x) {} return 1; } default { state_entry() { f(1); llOwnerSay("done"); } }');
		expect(code).toContain('f(1);');
		expect(code).toContain('while(x)');
	});

	it('does not discard potentially trapping expressions or their helper calls', () => {
		for (const expression of ['n / 0', 'n % 0', 'llSqrt(-1.0)', 'llPow(-1.0,0.5)']) {
			const code = optimized(`default { touch_start(integer n) { ${expression}; llOwnerSay("done"); } }`);
			expect(code).toContain(expression.replaceAll(' ', ''));
		}
		const code = optimized('integer f(integer n) { return n/0; } default { state_entry() { f(1); llOwnerSay("done"); } }');
		expect(code).toContain('/0');
	});

	it('folds nonzero fractional float conditions as true', () => {
		const result = optimizeScript(parseScriptFromText('default { state_entry() { if(0.5) llOwnerSay("yes"); else llOwnerSay("no"); } }'));
		expect(result.code).toContain('llOwnerSay("yes");');
		expect(result.code).not.toContain('llOwnerSay("no");');
	});

	it('keeps signed 32-bit coefficients during linear reassociation', () => {
		for (const suffix of ['', '*2147483647']) {
			const result = optimizeScript(parseScriptFromText(`integer f(integer n) { return n*2147483647*2147483647${suffix}+1; } default { touch_start(integer n) { llOwnerSay((string)f(n)); } }`), { integerPeepholes: true, constantFold: false });
			expect(result.code).not.toMatch(/461168601|9\.9.*e\+/);
			expect(parseScriptFromText(result.code).diagnostics.filter(d => d.severity === 'error')).toEqual([]);
			if (!suffix) expect(result.code).toContain('return -~n;');
		}
	});

	it('preserves implicit float conversion when inlining a global constant', () => {
		const result = optimizeScript(parseScriptFromText('float value=2; default { state_entry() { llOwnerSay((string)value); } }'), { inlineConstantGlobals: true, constantFold: false });
		expect(result.code).toContain('llOwnerSay((string)2.0);');
	});
});
