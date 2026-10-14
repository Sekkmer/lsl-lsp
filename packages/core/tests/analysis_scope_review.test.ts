import { describe, expect, it } from 'vitest';
import { lslCompletions } from '../src/completions';
import { CompletionItemKind } from '../src/protocol';
import { inferExprTypeFromAst, isZeroLiteral } from '../src/ast/infer';
import { parseScriptFromText } from '../src/ast/parser';
import { loadTestDefs } from './loadDefs.testutil';
import { docFrom, runPipeline } from './testUtils';

describe('analysis lexical scope regressions', () => {
	it('recognizes hexadecimal zero without treating other hexadecimal literals as zero', () => {
		for (const [raw, expected] of [['0x10', false], ['0x0', true], ['0x1p0', false], ['0x0p1', false], ['0.0', true]] as const) {
			const ast = parseScriptFromText(`integer x = ${raw};`, 'file:///zero.lsl');
			expect(isZeroLiteral(ast.globals.get('x')!.initializer!)).toBe(expected);
		}
	});

	it('forgets linear constant values at targeted labels', async () => {
		const defs = await loadTestDefs();
		const doc = docFrom('default { state_entry() { integer n = 0; @again; if (n == 0) { n = 1; jump again; } } }');
		const { analysis } = runPipeline(doc, defs);
		expect(analysis.diagnostics.filter(d => d.code === 'LSL120' || d.code === 'LSL121')).toEqual([]);
	});

	it('infers assignment results from the declared left-hand type', () => {
		const types = new Map<'text' | 'count', 'string' | 'integer'>([['text', 'string'], ['count', 'integer']]);
		for (const [source, expected] of [['text = "x"', 'string'], ['text += "x"', 'string'], ['count += 0.5', 'integer'], ['count *= 0.5', 'integer']]) {
			const ast = parseScriptFromText(`default { state_entry() { ${source}; } }`, 'file:///infer-assignment.lsl');
			const body = ast.states.get('default')!.events[0]!.body;
			if (body.kind !== 'BlockStmt' || body.statements[0]?.kind !== 'ExprStmt') throw new Error('invalid fixture');
			expect(inferExprTypeFromAst(body.statements[0].expression, types)).toBe(expected);
		}
	});

	it('does not inherit global constant values for function or event parameters', async () => {
		const defs = await loadTestDefs();
		const doc = docFrom(`integer count = 1;
integer f(integer count) { if (count) return 1; return 0; }
default { touch_start(integer count) { if (count) llOwnerSay("touch"); } }`);
		const { analysis } = runPipeline(doc, defs);
		expect(analysis.diagnostics.filter(d => d.code === 'LSL120' || d.code === 'LSL121')).toEqual([]);
	});

	it('checks return types in the local lexical scope and includes callee return types', async () => {
		const defs = await loadTestDefs();
		const doc = docFrom(`string text;
string getText() { return "x"; }
integer badLocal() { string local = "x"; return local; }
integer badCall() { return getText(); }
integer goodShadow() { integer text = 1; return text; }`);
		const { analysis } = runPipeline(doc, defs);
		const errors = analysis.diagnostics.filter(d => d.code === 'LSL042');
		expect(errors).toHaveLength(2);
		expect(errors.map(d => d.message)).toEqual([
			'Function badLocal returns integer but returning string',
			'Function badCall returns integer but returning string',
		]);
	});

	it('does not call a for condition constant when its variable changes in the body', async () => {
		const defs = await loadTestDefs();
		const doc = docFrom('default { state_entry() { integer i = 0; for (; i < 3;) { ++i; } } }');
		const { analysis } = runPipeline(doc, defs);
		expect(analysis.diagnostics.filter(d => d.code === 'LSL120' || d.code === 'LSL121')).toEqual([]);
	});

	it('offers only visible variables and picks the innermost declaration', async () => {
		const defs = await loadTestDefs();
		const code = `integer shared;
integer f(integer unrelatedParam) { integer unrelatedLocal; return 0; }
default {
state_entry() {
	integer before;
	{ integer expired; }
	{ string shared; shared = "marker"; }
	integer after;
}
touch_start(integer anotherEvent) { integer anotherLocal; }
}`;
		const doc = docFrom(code);
		const { analysis, pre } = runPipeline(doc, defs);
		const position = doc.positionAt(code.indexOf('shared ='));
		const variables = lslCompletions(doc, { textDocument: { uri: doc.uri }, position }, defs, analysis, pre)
			.filter(item => item.kind === CompletionItemKind.Variable);
		expect(variables.map(item => item.label).sort()).toEqual(['before', 'shared']);
		expect(variables.find(item => item.label === 'shared')?.detail).toBe('string');
	});

	it('resolves member completions using the visible declaration', async () => {
		const defs = await loadTestDefs();
		const code = `vector value;
integer f() { rotation value; return 0; }
default { state_entry() { value. } }`;
		const doc = docFrom(code);
		const { analysis, pre } = runPipeline(doc, defs);
		const position = doc.positionAt(code.lastIndexOf('.') + 1);
		const properties = lslCompletions(doc, { textDocument: { uri: doc.uri }, position }, defs, analysis, pre)
			.filter(item => item.kind === CompletionItemKind.Property).map(item => item.label);
		expect(properties).toEqual(['x', 'y', 'z']);
	});
});
