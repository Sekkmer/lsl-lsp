import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

type TMRule = {
	name?: string;
	begin?: string;
	end?: string;
	match?: string;
	patterns?: TMRule[];
};

function loadGrammar(): { scopeName: string; patterns: TMRule[] } {
	const serverDir = process.cwd(); // server/
	const grammarPath = path.resolve(serverDir, '../client-vscode/syntaxes/lsl.tmLanguage.json');
	const raw = fs.readFileSync(grammarPath, 'utf8');
	return JSON.parse(raw);
}

function findRuleByName(root: TMRule[] | undefined, name: string): TMRule | undefined {
	if (!root) return undefined;
	for (const r of root) {
		if (r.name === name) return r;
		const inChild = findRuleByName(r.patterns, name);
		if (inChild) return inChild;
	}
	return undefined;
}

function collectMatches(rule: TMRule, out: string[] = []): string[] {
	if (rule.match) out.push(rule.match);
	for (const p of rule.patterns || []) collectMatches(p, out);
	return out;
}

describe('TextMate grammar structural checks', () => {
	it('loads grammar JSON', () => {
		const g = loadGrammar();
		expect(g.scopeName).toBe('source.lsl');
		expect(Array.isArray(g.patterns)).toBe(true);
	});

	it('preprocessor block recognizes #if and #elif directives', () => {
		const g = loadGrammar();
		const pre = findRuleByName(g.patterns, 'meta.preprocessor.lsl');
		expect(pre).toBeTruthy();
		expect(pre?.begin).toBeTypeOf('string');
		const begin = pre!.begin!;
		expect(begin.includes('|if|')).toBe(true);
		expect(begin.includes('|elif|')).toBe(true);
	});

	it('macro define supports token-paste and built-in macros', () => {
		const g = loadGrammar();
		const def = findRuleByName(g.patterns, 'meta.preprocessor.define.lsl');
		expect(def).toBeTruthy();
		const matches = collectMatches(def!);
		// token-paste ##
		expect(matches.some(m => m.includes('##'))).toBe(true);
		// built-ins in define bodies
		expect(matches.some(m => m.includes('__FILE__'))).toBe(true);
		expect(matches.some(m => m.includes('__VA_ARGS__'))).toBe(true);
		expect(matches.some(m => m.includes('__VA_OPT__'))).toBe(true);
	});

	it('macro define pattern accepts noise-prefixed macro names', () => {
		const g = loadGrammar();
		const def = findRuleByName(g.patterns, 'meta.preprocessor.define.lsl');
		expect(def?.begin).toBeTypeOf('string');
		const begin = def!.begin!;
		expect(begin).toContain('[#?$A-Za-z_]');
		expect(begin).toContain('[#?$A-Za-z0-9_]');
	});

	it('#if/#elif condition pattern highlights defined() and operators', () => {
		const g = loadGrammar();
		const ifp = findRuleByName(g.patterns, 'meta.preprocessor.if.lsl');
		expect(ifp).toBeTruthy();
		const matches = collectMatches(ifp!);
		expect(matches.some(m => /\\bdefined\\b/.test(m))).toBe(true);
		expect(matches.some(m => /\[!&\|\?:=<>\+\\-\*\/%\]\+?/.test(m))).toBe(true);
		// built-ins available in conditions
		expect(matches.some(m => m.includes('__FILE__'))).toBe(true);
		expect(matches.some(m => m.includes('__VA_ARGS__'))).toBe(true);
		expect(matches.some(m => m.includes('__VA_OPT__'))).toBe(true);
	});

	it('all regex patterns compile in JS RegExp (sanity)', () => {
		const g = loadGrammar();
		const all: string[] = [];
		for (const top of g.patterns) collectMatches(top, all);
		for (const pat of all) {
			// Some Oniguruma tokens may degrade (e.g., \G), but should not throw in JS.
			expect(() => new RegExp(pat)).not.toThrow();
		}
	});
});
