import { describe, expect, it } from 'vitest';
import { emitScript } from '../src/ast/emit';
import { docFrom, runPipeline } from './testUtils';
import { loadTestDefs } from './loadDefs.testutil';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { Stmt } from '../src/ast/types';

function declarations(stmt: Stmt): Extract<Stmt, { kind: 'VarDecl' }>[] {
	if (stmt.kind === 'VarDecl') return [stmt];
	if (stmt.kind === 'BlockStmt') return stmt.statements.flatMap(declarations);
	if (stmt.kind === 'IfStmt') return [...declarations(stmt.then), ...(stmt.else ? declarations(stmt.else) : [])];
	if (stmt.kind === 'ForStmt' || stmt.kind === 'WhileStmt' || stmt.kind === 'DoWhileStmt') return declarations(stmt.body);
	return [];
}

describe('switch extension', () => {
	it('keeps switch invalid when the extension is disabled', async () => {
		const defs = await loadTestDefs();
		const doc = docFrom('integer mode; default { state_entry() { switch (mode) { case 1: llOwnerSay("one"); break; } } }');
		const { analysis } = runPipeline(doc, defs);
		expect(analysis.diagnostics.some(d => d.code === 'LSL000')).toBe(true);
	});

	it('lowers switch with fallthrough and break to standard LSL', async () => {
		const defs = await loadTestDefs();
		const doc = docFrom(`
// lsl-lsp extensions: switch
integer mode;
default {
	state_entry() {
		switch (mode) {
			case 1:
				llOwnerSay("one");
				break;
			case 2:
				llOwnerSay("two");
			default:
				llOwnerSay("default");
		}
	}
}
`);
		const { analysis, script } = runPipeline(doc, defs);
		const messages = analysis.diagnostics.map(d => `${d.message} @${d.code}`);
		expect(messages.some(m => m.includes('Unknown jump target'))).toBe(false);
		expect(messages.some(m => m.includes('missing ;'))).toBe(false);
		const rendered = emitScript(script);
		expect(rendered).not.toContain('switch(');
		expect(rendered).toContain('integer __lsl_switch_0_value=mode;');
		expect(rendered).toContain('if(__lsl_switch_0_value==1)jump __lsl_switch_0_case_0;');
		expect(rendered).toContain('if(__lsl_switch_0_value==2)jump __lsl_switch_0_case_1;');
		expect(rendered).toContain('jump __lsl_switch_0_default;');
		expect(rendered).toContain('@__lsl_switch_0_case_0;');
		expect(rendered).toContain('jump __lsl_switch_0_break;');
		expect(rendered).toContain('@__lsl_switch_0_default;');
		expect(rendered).toContain('@__lsl_switch_0_break;');
	});

	it('enables switch through Firestorm compatibility macros', async () => {
		const defs = await loadTestDefs();
		const doc = docFrom('#define USE_SWITCHES\ninteger mode; default { state_entry() { switch (mode) { case 1: llOwnerSay("one"); break; } } }');
		const { analysis, script } = runPipeline(doc, defs);
		expect(analysis.diagnostics.some(d => d.code === 'LSL000')).toBe(false);
		expect(emitScript(script)).toContain('if(__lsl_switch_0_value==1)jump __lsl_switch_0_case_0;');
	});

	it('jumps to the break label when no default case exists', async () => {
		const defs = await loadTestDefs();
		const doc = docFrom(`
// lsl-lsp extensions: switch
integer mode;
default { state_entry() { switch (mode) { case 1: llOwnerSay("one"); } } }
`);
		const { analysis, script } = runPipeline(doc, defs);
		expect(analysis.diagnostics.some(d => d.code === 'LSL000')).toBe(false);
		const rendered = emitScript(script);
		expect(rendered).toContain('if(__lsl_switch_0_value==1)jump __lsl_switch_0_case_0;');
		expect(rendered).toContain('jump __lsl_switch_0_break;');
	});

	it('evaluates side effects once, including empty and default-only switches', async () => {
		const defs = await loadTestDefs();
		const doc = docFrom(`// lsl-lsp extensions: switch
integer count;
integer next() { return ++count; }
default { state_entry() {
	switch (next()) { case 0: break; case 1: break; default: break; }
	switch (count++) { }
	switch (++count) { default: break; }
} }`);
		const { analysis, script } = runPipeline(doc, defs);
		expect(analysis.diagnostics.filter(d => d.severity === 1)).toEqual([]);
		const rendered = emitScript(script);
		expect(rendered.match(/=next\(\);/g)).toHaveLength(1);
		expect(rendered).toContain('integer __lsl_switch_1_value=count++;');
		expect(rendered).toContain('integer __lsl_switch_2_value=++count;');
		expect(rendered).not.toMatch(/if\([^;]*(next\(\)|\+\+count|count\+\+)/);
		const reparsed = runPipeline(docFrom(rendered), defs);
		expect(reparsed.analysis.diagnostics.filter(d => d.severity === 1)).toEqual([]);
	});

	it('preserves each LSL value type and infers calls declared later', async () => {
		const defs = await loadTestDefs();
		const doc = docFrom(`// lsl-lsp extensions: switch
probe(string text, key avatar, list items, vector position, rotation orientation) {
	switch (text) { case "x": break; }
	switch (avatar) { case NULL_KEY: break; }
	switch (items) { case []: break; }
	switch (position) { case <0.0, 0.0, 0.0>: break; }
	switch (orientation) { case <0.0, 0.0, 0.0, 1.0>: break; }
	switch (position.x) { case 0.0: break; }
	switch (next()) { case "later": break; }
	switch (llGetOwner()) { case NULL_KEY: break; }
	switch (TRUE) { case 1: break; }
}
string next() { return "later"; }
default { state_entry() { } }`);
		const { analysis, script } = runPipeline(doc, defs);
		expect(analysis.diagnostics.filter(d => d.severity === 1)).toEqual([]);
		const values = declarations(script.functions.get('probe')!.body).filter(d => d.name.startsWith('__lsl_switch_'));
		expect(values.map(d => d.varType)).toEqual(['string', 'key', 'list', 'vector', 'rotation', 'float', 'string', 'key', 'integer']);
		expect(runPipeline(docFrom(emitScript(script)), defs).analysis.diagnostics.filter(d => d.severity === 1)).toEqual([]);
	});

	it('resolves lexical scopes and keeps nested break targets separate', async () => {
		const defs = await loadTestDefs();
		const doc = docFrom(`// lsl-lsp extensions: switch
string mode;
default { state_entry() {
	{ integer mode = 1; switch (mode) {
		case 1: switch (mode) { case 1: break; } break;
	} }
	switch (mode) { case "text": break; }
} }`);
		const { analysis, script } = runPipeline(doc, defs);
		expect(analysis.diagnostics.filter(d => d.severity === 1)).toEqual([]);
		const values = declarations(script.states.get('default')!.events[0]!.body).filter(d => d.name.startsWith('__lsl_switch_'));
		expect(values.map(d => d.varType)).toEqual(['integer', 'integer', 'string']);
		const rendered = emitScript(script);
		expect(rendered).toContain('@__lsl_switch_1_case_0;jump __lsl_switch_1_break;');
		expect(rendered).toContain('@__lsl_switch_1_break;}jump __lsl_switch_0_break;');
	});

	it('preserves assignment expression types without reevaluating assignments', async () => {
		const defs = await loadTestDefs();
		const { script, analysis } = runPipeline(docFrom(`// lsl-lsp extensions: switch
default { state_entry() {
	string text;
	float number;
	vector direction;
	switch (text = "set") { case "set": break; }
	switch (number += 1) { case 1.0: break; }
	switch (direction *= 2) { case <0, 0, 0>: break; }
} }`), defs);
		expect(analysis.diagnostics.filter(d => d.severity === 1)).toEqual([]);
		const values = declarations(script.states.get('default')!.events[0]!.body).filter(d => d.name.startsWith('__lsl_switch_'));
		expect(values.map(d => d.varType)).toEqual(['string', 'float', 'vector']);
		const rendered = emitScript(script);
		expect(rendered.match(/text="set"/g)).toHaveLength(1);
		expect(rendered.match(/number\+=1/g)).toHaveLength(1);
		expect(rendered.match(/direction\*=2/g)).toHaveLength(1);
	});

	it('requires an explicit type for unknown discriminator values', async () => {
		const defs = await loadTestDefs();
		const { script } = runPipeline(docFrom(`// lsl-lsp extensions: switch
default { state_entry() { switch (missing()) { case 1: break; } } }`), defs);
		expect(script.diagnostics?.some(d => d.message === 'Cannot infer switch expression type; use an explicit cast')).toBe(true);
	});

	it('avoids user identifiers and labels from includes and later declarations', async () => {
		const defs = await loadTestDefs();
		const directory = mkdtempSync(join(tmpdir(), 'lsl-switch-'));
		try {
			writeFileSync(join(directory, 'reserved.lslh'), 'integer __lsl_switch_0_value;\n');
			const doc = docFrom(`// lsl-lsp extensions: switch
#include "reserved.lslh"
default { state_entry() {
	switch (1) { case 1: break; }
	@__lsl_switch_1_break;
	integer __lsl_switch_2_case_0;
} }`, pathToFileURL(join(directory, 'root.lsl')).href);
			const { analysis, script } = runPipeline(doc, defs, { includePaths: [directory] });
			expect(analysis.diagnostics.filter(d => d.severity === 1)).toEqual([]);
			const rendered = emitScript(script);
			expect(rendered).toContain('integer __lsl_switch_3_value=1;');
			expect(rendered).toContain('@__lsl_switch_3_case_0;');
			expect(rendered).toContain('@__lsl_switch_3_break;');
		} finally { rmSync(directory, { recursive: true, force: true }); }
	});
});
