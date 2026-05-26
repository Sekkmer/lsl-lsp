import { describe, expect, it } from 'vitest';
import { preprocessForAst } from '../src/core/pipeline';
import { parseLslExtensionSettings, resolveLslExtensions } from '../src/extensions';

function preprocess(code: string, extensions?: Parameters<typeof preprocessForAst>[1]['extensions']) {
	return preprocessForAst(code, { includePaths: [], extensions });
}

describe('LSL extension detection', () => {
	it('keeps all source extensions disabled by default', () => {
		const pre = preprocess('default { state_entry() {} }\n');
		expect(pre.extensions).toMatchObject({
			switch: false,
			lazyLists: false,
			constGlobalExpressions: false,
			firestormPreprocessorDisabled: false,
		});
		expect(pre.extensions.sources).toEqual({});
	});

	it('enables extensions from explicit settings', () => {
		const pre = preprocess('default { state_entry() {} }\n', {
			switch: true,
			constGlobalExpressions: true,
		});
		expect(pre.extensions.switch).toBe(true);
		expect(pre.extensions.lazyLists).toBe(false);
		expect(pre.extensions.constGlobalExpressions).toBe(true);
		expect(pre.extensions.sources).toEqual({
			switch: 'config',
			constGlobalExpressions: 'config',
		});
	});

	it('accepts CLI and comment aliases for extension names', () => {
		expect(parseLslExtensionSettings('switch,lazy-lists,const-globals')).toEqual({
			switch: true,
			lazyLists: true,
			constGlobalExpressions: true,
		});
		expect(resolveLslExtensions('// lsl-lsp extensions: lazy_lists const-global-expressions\n')).toMatchObject({
			switch: false,
			lazyLists: true,
			constGlobalExpressions: true,
		});
	});

	it('enables Firestorm switch and lazy-list compatibility from macros', () => {
		const pre = preprocess('#define USE_SWITCHES\n#define USE_LAZY_LISTS\n');
		expect(pre.extensions.switch).toBe(true);
		expect(pre.extensions.lazyLists).toBe(true);
		expect(pre.extensions.constGlobalExpressions).toBe(false);
		expect(pre.extensions.sources).toEqual({
			switch: 'firestorm-macro',
			lazyLists: 'firestorm-macro',
		});
	});

	it('lets lsl-lsp comments override config and macro defaults', () => {
		const pre = preprocess('#define USE_SWITCHES\n// lsl-lsp extensions: none\n', {
			switch: true,
			lazyLists: true,
			constGlobalExpressions: true,
		});
		expect(pre.extensions.switch).toBe(false);
		expect(pre.extensions.lazyLists).toBe(false);
		expect(pre.extensions.constGlobalExpressions).toBe(false);
		expect(pre.extensions.sources).toEqual({});
	});

	it('ignores extension-looking text inside strings', () => {
		const pre = preprocess('string s = "// lsl-lsp extensions: switch";\n');
		expect(pre.extensions.switch).toBe(false);
	});

	it('treats Firestorm preprocessor off as disabling Firestorm macro auto-enable only', () => {
		const pre = preprocess('//fspreprocessor off\n#define USE_SWITCHES\n#define USE_LAZY_LISTS\n', {
			constGlobalExpressions: true,
		});
		expect(pre.extensions.firestormPreprocessorDisabled).toBe(true);
		expect(pre.extensions.switch).toBe(false);
		expect(pre.extensions.lazyLists).toBe(false);
		expect(pre.extensions.constGlobalExpressions).toBe(true);
		expect(pre.extensions.sources).toEqual({
			constGlobalExpressions: 'config',
		});
	});
});
