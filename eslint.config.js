// Flat config for ESLint v10.
import js from '@eslint/js';
import tseslint from 'typescript-eslint';

const jsFiles = ['**/*.js', '**/*.cjs', '**/*.mjs'];
const tsFiles = ['**/*.ts', '**/*.tsx'];
const [tsBase, tsEslintRecommended, tsRecommended] = tseslint.configs.recommended;

export default [
	{
		ignores: ['**/node_modules/**', '**/out/**', '**/dist/**', '**/.vscode/**'],
	},
	{
		files: jsFiles,
		rules: {
			...js.configs.recommended.rules,
			indent: ['error', 'tab', { SwitchCase: 1 }],
		},
	},
	{
		files: tsFiles,
		languageOptions: tsBase.languageOptions,
		plugins: tsBase.plugins,
		rules: {
			...js.configs.recommended.rules,
			...tsEslintRecommended.rules,
			...tsRecommended.rules,
			indent: ['error', 'tab', { SwitchCase: 1 }],
			quotes: ['error', 'single'],
			'@typescript-eslint/no-require-imports': 'off',
			'@typescript-eslint/no-unused-vars': ['warn', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
		},
	},
];
