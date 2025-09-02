// Flat config for ESLint v9
import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
	// Global ignores
	{ ignores: ['**/node_modules/**', '**/out/**', '**/dist/**', '**/.vscode/**'] },

	// JavaScript files
	{
		files: ['**/*.js', '**/*.cjs', '**/*.mjs'] ,
		extends: [js.configs.recommended],
		rules: {
			indent: ['error', 'tab', { SwitchCase: 1 }]
		}
	},

	// TypeScript files
	{
		files: ['**/*.ts', '**/*.tsx'],
		extends: [js.configs.recommended, ...tseslint.configs.recommended],
		rules: {
			indent: ['error', 'tab', { SwitchCase: 1 }],
			'@typescript-eslint/no-require-imports': 'off',
			'@typescript-eslint/no-unused-vars': ['warn', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }]
		}
	}
);
