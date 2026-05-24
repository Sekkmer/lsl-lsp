import { describe, it, expect } from 'vitest';
import { docFrom, runPipeline } from './testUtils';
import { loadDefs } from '../src/defs';
import { join } from 'node:path';
import { Diag } from '../src/analysisTypes';

function syntaxMsgs(diags: Diag[]) {
	return diags
		.filter(d => String(d.code).startsWith('LSL0'))
		.map(d => `${d.code}: ${d.message}`)
		.join('\n');
}

describe('parser: macro-expanded calls with list args', () => {
	it('does not emit LSL000 for nested call expanded from macro with list literal arg', async () => {
		const defs = await loadDefs(join(__dirname, '..', '..', '..', 'third_party', 'lsl-definitions', 'lsl_definitions.yaml'));
		const code = [
			'#define getjs llJsonGetValue',
			'#define setjs llJsonSetValue',
			'#define setdbl(_section, ...) llLinksetDataWrite(_section, setjs(llLinksetDataRead(_section), __VA_ARGS__))',
			'#define getdbl(_section, ...) getjs(llLinksetDataRead(_section), __VA_ARGS__)',
			'default {',
			'  state_entry() {',
			'    setdbl("status", ["pony"], "1");',
			'    string err = "";',
			'    err += getdbl("status", ["pony"]);',
			'  }',
			'}'
		].join('\n');
		const doc = docFrom(code, 'file:///macro_expansion_semicolon.lsl');
		const { analysis } = runPipeline(doc, defs);
		const msgs = syntaxMsgs(analysis.diagnostics);
		expect(msgs).not.toMatch(/LSL000/);
	});
});
