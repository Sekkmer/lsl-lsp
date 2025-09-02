// Small shared utilities

const IS_TEST = typeof process !== 'undefined' && (
	// Access env in a type-safe way without any
	(typeof (process as { env?: Record<string, string | undefined> }).env?.VITEST_WORKER_ID === 'string') ||
	((process as { env?: Record<string, string | undefined> }).env?.NODE_ENV === 'test')
);

/**
 * Compile-time exhaustiveness helper. In runtime:
 * - during unit tests (Vitest) or when NODE_ENV==='test', it throws with a helpful message;
 * - otherwise it becomes a no-op. The return type is `never` to enforce exhaustiveness at compile time.
 */
export function AssertNever(x: never, message?: string): never {
	if (IS_TEST) {
		throw new Error(message ?? `Unexpected value in AssertNever: ${String(x)}`);
	}
	// In non-test runs, act as a no-op but keep the signature `never` for compile-time exhaustiveness.
	return undefined as never;
}

/**
 * Asserts that a value is not null or undefined.
 * @param x The value to check.
 * @param fallback The fallback value to return if x is null or undefined.
 * @param message Optional error message.
 * @returns The original value if not null/undefined, otherwise the fallback.
 */
export function AssertNotNull<T>(x: T | null | undefined, fallback: T, message?: string): T {
	if (x === null || x === undefined) {
		if (IS_TEST) {
			throw new Error(message ?? `Expected non-null value, but got: ${String(x)}`);
		}
		return fallback;
	}
	return x;
}
