import { defineConfig } from 'vitest/config';

export default defineConfig({
	test: {
		environment: 'node',
		include: ['tests/**/*.test.ts'],
		pool: 'forks',
		isolate: true, 
		slowTestThreshold: 1_000,
		testTimeout: 2_000,
		hookTimeout: 10_000,
		teardownTimeout: 10_000,
		poolOptions: {
			forks: { singleFork: false }
		},
		coverage: {
			provider: 'v8',
			reportsDirectory: './coverage',
			reporter: ['text', 'html'],
			exclude: ['**/node_modules/**', 'out/**']
		}
	}
});
