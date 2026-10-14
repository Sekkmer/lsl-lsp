import { describe, expect, it } from 'vitest';
import { measureAst, optimizeScript, parseScriptFromText } from '../src';

describe('AST measure', () => {
	it('counts major AST shapes and reports a Mono memory estimate', () => {
		const source = [
			'list items = [1, 2, 3];',
			'integer helper(integer value) { return value + llGetListLength(items); }',
			'default { state_entry() { integer value = helper(1); llOwnerSay((string)value); } }',
		].join('\n');
		const result = measureAst(parseScriptFromText(source), { sourceText: source });
		expect(result.monoMemoryLimit).toBe(65536);
		expect(result.estimatedMonoUsedMemory).toBeGreaterThan(result.cost.baseline);
		expect(result.estimatedMonoFreeMemory).toBe(65536 - result.estimatedMonoUsedMemory);
		expect(result.counts.globals).toBe(1);
		expect(result.counts.functions).toBe(1);
		expect(result.counts.states).toBe(1);
		expect(result.counts.events).toBe(1);
		expect(result.counts.listLiterals).toBe(1);
		expect(result.counts.listElements).toBe(3);
		expect(result.counts.calls).toBe(3);
		expect(result.compactCharacters).toBeGreaterThan(0);
		expect(result.sourceCharacters).toBe(source.length);
	});

	it('can compare optimized AST measures', () => {
		const source = 'integer value = 1 + 2; default { state_entry() { integer local = value; llOwnerSay((string)local); } }';
		const original = measureAst(parseScriptFromText(source), { sourceText: source });
		const optimized = optimizeScript(parseScriptFromText(source), { inlineConstantGlobals: true, dropDefaultInitializers: true });
		const optimizedMeasure = measureAst(parseScriptFromText(optimized.code), { sourceText: optimized.code });
		expect(optimizedMeasure.compactCharacters).toBeLessThan(original.compactCharacters);
		expect(optimizedMeasure.estimatedMonoUsedMemory).toBeLessThanOrEqual(original.estimatedMonoUsedMemory);
	});

	it('models SL-backed local list constructor steps', () => {
		const empty = measureAst(parseScriptFromText('default { state_entry() { list value = []; } }'));
		const twoInts = measureAst(parseScriptFromText('default { state_entry() { list value = [1, 2]; } }'));
		const threeInts = measureAst(parseScriptFromText('default { state_entry() { list value = [1, 2, 3]; } }'));
		const oneVector = measureAst(parseScriptFromText('default { state_entry() { list value = [<1.0, 2.0, 3.0>]; } }'));
		const plainVector = measureAst(parseScriptFromText('default { state_entry() { vector value = <1.0, 2.0, 3.0>; } }'));
		expect(empty.counts.listRuntimeBytes).toBe(0);
		expect(twoInts.counts.listRuntimeBytes).toBe(0);
		expect(threeInts.counts.listRuntimeBytes).toBe(512);
		expect(oneVector.counts.localListRuntimeBytes).toBe(512);
		expect(oneVector.cost.containers).toBe(0);
		expect(plainVector.cost.containers).toBe(0);
	});

	it('keeps startup container cost limited to global initializers', () => {
		const local = measureAst(parseScriptFromText('default { state_entry() { list value = [1, 2, 3]; } }'));
		const global = measureAst(parseScriptFromText('list value = [1, 2, 3]; default { state_entry() { } }'));
		expect(local.counts.localListRuntimeBytes).toBe(512);
		expect(local.counts.globalListRuntimeBytes).toBe(0);
		expect(local.cost.containers).toBe(0);
		expect(global.counts.globalListRuntimeBytes).toBe(512);
		expect(global.cost.containers).toBe(512);
		expect(global.cost.declarations).toBeGreaterThan(local.cost.declarations);
	});

	it('subtracts a declared reserve for bounded runtime growth', () => {
		const plainSource = 'list sessions; default { state_entry() { } }';
		const reservedSource = [
			'// lsl-memory-reserve: 8192 bytes',
			plainSource,
		].join('\n');
		const plain = measureAst(
			parseScriptFromText(plainSource),
			{ sourceText: plainSource },
		);
		const reserved = measureAst(
			parseScriptFromText(reservedSource),
			{ sourceText: reservedSource },
		);
		expect(reserved.runtimeReserveBytes).toBe(8192);
		expect(reserved.cost.runtimeReserve).toBe(8192);
		expect(reserved.estimatedMonoUsedMemory - plain.estimatedMonoUsedMemory)
			.toBe(8192);
		expect(reserved.estimatedMonoFreeMemory)
			.toBe(plain.estimatedMonoFreeMemory - 8192);
		expect(reserved.notes.some(note => note.includes('runtime growth')))
			.toBe(true);
	});

	it('normalizes invalid runtime reserve options to finite nonnegative bytes', () => {
		const ast = parseScriptFromText('default { state_entry() {} }');
		for (const runtimeReserveBytes of [NaN, Infinity, -Infinity, -20]) {
			const result = measureAst(ast, { runtimeReserveBytes });
			expect(result.runtimeReserveBytes).toBe(0);
			expect(Number.isFinite(result.estimatedMonoFreeMemory)).toBe(true);
		}
		expect(measureAst(ast, { runtimeReserveBytes: 12.9 }).runtimeReserveBytes).toBe(12);
	});

	it('models SL-backed value-call placement steps', () => {
		const helper = 'integer F(integer A) { return A + 1; }';
		const base = measureAst(parseScriptFromText(`${helper} default { state_entry() { } }`));
		const stateEntryThree = measureAst(parseScriptFromText(`${helper} default { state_entry() { integer A = F(1) + F(2) + F(3); } }`));
		const touchOne = measureAst(parseScriptFromText(`${helper} default { state_entry() { } touch_start(integer N) { integer A = F(1); } }`));
		const touchThree = measureAst(parseScriptFromText(`${helper} default { state_entry() { } touch_start(integer N) { integer A = F(1) + F(2) + F(3); } }`));
		const listenTwo = measureAst(parseScriptFromText(`${helper} default { state_entry() { } listen(integer C, string N, key I, string M) { integer A = F(1) + F(2); } }`));
		expect(stateEntryThree.cost.calls - base.cost.calls).toBe(512);
		expect(touchOne.cost.calls - base.cost.calls).toBe(512);
		expect(touchThree.cost.calls - base.cost.calls).toBe(1024);
		expect(listenTwo.cost.calls - base.cost.calls).toBe(1024);
	});

	it('reports the deepest reachable user-call chain', () => {
		const source = [
			'C() { llOwnerSay("done"); }',
			'B() { C(); }',
			'A() { B(); }',
			'Unused() { C(); }',
			'default { state_entry() { A(); } }',
		].join('\n');
		const result = measureAst(parseScriptFromText(source));
		expect(result.callGraph.maxStaticUserCallDepth).toBe(3);
		expect(result.callGraph.staticDepthIsUpperBound).toBe(false);
		expect(result.callGraph.deepestStaticUserCallChain)
			.toEqual(['default.state_entry', 'A', 'B', 'C']);
		expect(result.callGraph.recursiveFunctions).toEqual([]);
		expect(result.callGraph.reachableRecursiveFunctions).toEqual([]);
	});

	it('marks reachable recursion without claiming a finite runtime depth', () => {
		const source = [
			'A(integer value) { if (value) B(value - 1); }',
			'B(integer value) { if (value) A(value - 1); }',
			'Unused() { Unused(); }',
			'default { state_entry() { A(2); } }',
		].join('\n');
		const result = measureAst(parseScriptFromText(source));
		expect(result.callGraph.maxStaticUserCallDepth).toBe(2);
		expect(result.callGraph.staticDepthIsUpperBound).toBe(true);
		expect(result.callGraph.deepestStaticUserCallChain)
			.toEqual(['default.state_entry', '<recursive:A,B>']);
		expect(result.callGraph.recursiveFunctions).toEqual(['A', 'B', 'Unused']);
		expect(result.callGraph.reachableRecursiveFunctions).toEqual(['A', 'B']);
		expect(result.notes.some(note => note.includes('runtime depth depends on input')))
			.toBe(true);
	});

	it('measures shared helper graphs without enumerating exponentially many paths', () => {
		const source = ['F0() {}', 'F1() { F0(); }'];
		for (let i = 2; i < 80; i++) source.push(`F${i}() { F${i - 1}(); F${i - 2}(); }`);
		source.push('default { state_entry() { F79(); } }');
		const result = measureAst(parseScriptFromText(source.join('\n')));
		expect(result.callGraph.maxStaticUserCallDepth).toBe(80);
		expect(result.callGraph.deepestStaticUserCallChain).toHaveLength(81);
		expect(result.callGraph.staticDepthIsUpperBound).toBe(false);
	});

	it('bounds recursive components with multiple exits and excludes unreachable cycles', () => {
		const source = [
			'Leaf() {}',
			'Tail() { Leaf(); }',
			'A() { B(); Tail(); }',
			'B() { A(); C(); }',
			'C() { B(); Leaf(); }',
			'Unused() { Unused(); }',
			'Root() { A(); }',
			'default { state_entry() { Root(); } }',
		].join('\n');
		const result = measureAst(parseScriptFromText(source));
		expect(result.callGraph.maxStaticUserCallDepth).toBe(6);
		expect(result.callGraph.deepestStaticUserCallChain)
			.toEqual(['default.state_entry', 'Root', '<recursive:A,B,C>', 'Tail', 'Leaf']);
		expect(result.callGraph.reachableRecursiveFunctions).toEqual(['A', 'B', 'C']);
		expect(result.callGraph.recursiveFunctions).toEqual(['A', 'B', 'C', 'Unused']);
	});

	it('does not mark an acyclic reachable chain as approximate for unreachable recursion', () => {
		const source = 'A() {} Unused() { Unused(); } default { state_entry() { A(); } }';
		const result = measureAst(parseScriptFromText(source));
		expect(result.callGraph.maxStaticUserCallDepth).toBe(1);
		expect(result.callGraph.staticDepthIsUpperBound).toBe(false);
		expect(result.callGraph.reachableRecursiveFunctions).toEqual([]);
	});
});
