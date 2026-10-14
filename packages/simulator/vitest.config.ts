import { defineConfig } from 'vitest/config';

export default defineConfig({
	test: {
		environment: 'node',
		include: ['tests/**/*.test.ts'],
		pool: 'forks',
		isolate: true,
		testTimeout: 5_000,
		hookTimeout: 10_000,
	}
});
