import { describe, it, expect } from 'vitest';
import { docFrom, runPipeline } from './testUtils';
import { loadTestDefs } from './loadDefs.testutil';
import { parseScriptFromText } from '../src/ast/parser';

describe('preprocessor: nested include macros and functions', () => {
	it('sees macros from nested includes and expands function-like macros', async () => {
		const defs = await loadTestDefs();
		const src = [
			'#include "chain_a.lslh"',
			'default {',
			'\tstate_entry() {',
			'\t\t#if defined(MACRO_A) && defined(MACRO_B)',
			'\t\tinteger x = ADD(MACRO_A, MACRO_B);',
			'\t\t#else',
			'\t\tinteger x = 0;',
			'\t\t#endif',
			'\t\tllSay(0, (string)x);',
			'\t}',
			'}'
		].join('\n');
		const doc = docFrom(src, 'file:///proj/main.lsl');
		const { analysis } = runPipeline(doc, defs, { includePaths: [__dirname + '/fixtures/includes'] });
		// Ensure the active code used the true branch by inspecting AST initializer for x
		const script = parseScriptFromText(src, 'file:///proj/main.lsl', { includePaths: [__dirname + '/fixtures/includes'] });
		const def = script.states.get('default');
		expect(def).toBeTruthy();
		const ev = def!.events.find(e => e.name === 'state_entry');
		expect(ev).toBeTruthy();
		let init: any = undefined;
		const findVarDecl = (node: any): any | undefined => {
			if (!node) return undefined;
			if (Array.isArray(node)) {
				for (const n of node) { const r = findVarDecl(n); if (r) return r; }
				return undefined;
			}
			if (node.kind === 'VarDecl' && node.name === 'x') return node;
			if (node.kind === 'BlockStmt') return findVarDecl(node.statements);
			if (node.kind === 'IfStmt') return findVarDecl([node.then, node.else]);
			if (node.kind === 'ForStmt') return findVarDecl([node.init, node.body]);
			if (node.kind === 'WhileStmt' || node.kind === 'DoWhileStmt') return findVarDecl(node.body);
			return undefined;
		};
		if (ev) {
			const decl: any = findVarDecl(ev.body);
			expect(decl).toBeTruthy();
			init = decl?.initializer;
		}
		expect(init && init.kind).toBe('Binary');
		// No operator type mismatch diagnostics during addition
		const msgs = analysis.diagnostics.map(d => d.message);
		expect(msgs.some(m => m.includes('Operator + type mismatch'))).toBe(false);
	});
});
