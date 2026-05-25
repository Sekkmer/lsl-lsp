import { describe, expect, it } from 'vitest';
import { analyzeAst, optimizeScript, parseDynamicMacroList, parseScriptFromText, preprocessForAst, TextDocument } from '../src';
import { loadTestDefs } from './loadDefs.testutil';
import { docFrom, runPipeline } from './testUtils';

describe('dynamic macros', () => {
	it('parses configurable typed macro entries', () => {
		expect(parseDynamicMacroList(['__AGENTID__:string', '__AGENTIDRAW__:key', '__UNIXTIME__:integer'])).toEqual({
			__AGENTID__: 'string',
			__AGENTIDRAW__: 'key',
			__UNIXTIME__: 'integer',
		});
		expect(parseDynamicMacroList('__ROT__:quaternion')).toEqual({ __ROT__: 'rotation' });
	});

	it('preserves dynamic macro tokens through preprocessing and treats them as defined', () => {
		const source = [
			'#if defined(__AGENTID__)',
			'string id = __AGENTID__;',
			'#else',
			'string id = "missing";',
			'#endif',
		].join('\n');
		const pre = preprocessForAst(source, {
			includePaths: [],
			fromPath: '/tmp/dynamic.lsl',
			dynamicMacros: { __AGENTID__: 'string' },
		});
		expect(pre.preprocDiagnostics?.map(d => d.message) ?? []).not.toContain('Identifier \'__AGENTID__\' not defined in preprocessor expression');
		expect(pre.expandedTokens.map(t => t.value)).toContain('__AGENTID__');
		expect(pre.expandedTokens.map(t => t.value)).not.toContain('missing');
	});

	it('uses configured dynamic macro types in diagnostics', async () => {
		const defs = await loadTestDefs();
		const doc = docFrom('integer needsInt(integer value) { return value; }\ndefault { state_entry() { needsInt(__UNIXTIME__); } }');
		const { analysis } = runPipeline(doc, defs, { dynamicMacros: { __UNIXTIME__: 'integer' } });
		expect(analysis.diagnostics.filter(d => d.severity === 1).map(d => d.message)).toEqual([]);
	});

	it('keeps dynamic macro values unknown during optimization', () => {
		const source = 'default { state_entry() { if (__UNIXTIME__) llOwnerSay("now"); } }';
		const ast = parseScriptFromText(source, 'file:///dynamic-opt.lsl', { dynamicMacros: { __UNIXTIME__: 'integer' } });
		const out = optimizeScript(ast, { dynamicMacros: { __UNIXTIME__: 'integer' } });
		expect(out.code).toContain('__UNIXTIME__');
		expect(out.code).toContain('llOwnerSay');
	});

	it('allows analysis to see a preserved Firestorm-style agent id as a string', async () => {
		const defs = await loadTestDefs();
		const source = 'default { state_entry() { string id = __AGENTID__; } }';
		const doc = TextDocument.create('file:///agent.lsl', 'lsl', 1, source);
		const full = preprocessForAst(source, { includePaths: [], fromPath: '/tmp/agent.lsl', dynamicMacros: { __AGENTID__: 'string' } });
		const ast = parseScriptFromText(source, doc.uri, { pre: full });
		const analysis = analyzeAst(doc, ast, defs, {
			disabledRanges: full.disabledRanges,
			dynamicMacros: full.dynamicMacros,
			funcMacros: full.funcMacros,
			includes: full.includes,
			macros: full.macros,
		});
		expect(analysis.diagnostics.filter(d => d.severity === 1).map(d => d.message)).toEqual([]);
	});
});
