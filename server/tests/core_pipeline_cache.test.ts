import { describe, it, expect, beforeEach } from 'vitest';
import { preprocessTokens, buildIncludeResolver, clearIncludeResolverCache } from '../src/core/pipeline';
import type { Stats, BigIntStats, PathLike, PathOrFileDescriptor } from 'node:fs';

describe('core pipeline cache', () => {
	beforeEach(() => clearIncludeResolverCache());

	it('reuses tokenized include on unchanged mtime and refreshes after change', () => {
		// Fake fs with a single include file we can mutate and control mtime
		let mtimeMs = 1000;
		let content = '#define F 1\n';
		// Provide a statSync function that is compatible with Node's overloads
		function statSyncCompat(_p: PathLike): Stats;
		function statSyncCompat(_p: PathLike, _opts: { bigint: true }): BigIntStats;
		function statSyncCompat(_p: PathLike, _opts?: { bigint?: boolean }): Stats | BigIntStats {
			// Our pipeline only calls statSync(path) so returning Stats is sufficient
			return ({ mtimeMs } as unknown) as Stats;
		}
		type RFS = typeof import('node:fs').readFileSync;
		const readFileSyncCompat: RFS = ((path: PathOrFileDescriptor, _options?: Parameters<RFS>[1]): ReturnType<RFS> => {
			const sp = typeof path === 'string' ? path : String(path);
			if (!sp.endsWith('/inc.lsl')) throw new Error('not found');
			return content as unknown as ReturnType<RFS>;
		}) as RFS;
		const fakeFs: import('../src/core/pipeline').IncludeResolverOptions['fs'] = {
			existsSync: (p: import('node:fs').PathLike) => String(p).endsWith('/inc.lsl'),
			readFileSync: readFileSyncCompat,
			statSync: statSyncCompat,
		};
		const resolver = buildIncludeResolver({ includePaths: ['/abs'], fs: fakeFs });
		// First call builds cache
		const r1 = resolver('inc.lsl', '/abs/main.lsl');
		if (!r1) throw new Error('resolver failed');
		// Second call with same mtime must return same token array instance
		const r2 = resolver('inc.lsl', '/abs/main.lsl');
		expect(r2).not.toBeNull();
		expect(r2!.tokens).toBe(r1.tokens);
		// Modify file and bump mtime -> cache refresh returns a different token array
		content = '#define F 2\n';
		mtimeMs += 1;
		const r3 = resolver('inc.lsl', '/abs/main.lsl');
		expect(r3).not.toBeNull();
		expect(r3!.tokens).not.toBe(r1.tokens);
	});

	it('macro table delta detects define/undef changes', () => {
		const src = [
			'#define A 1',
			'#undef A',
			'#define B 2',
		].join('\n');
		const r1 = preprocessTokens(src, { includePaths: [] });
		expect(r1.macrosChanged).toBe(true);
		// Only keys that differ between previous and final tables are reported (A is not present finally)
		expect(new Set(r1.changedKeys)).toEqual(new Set(['B']));
		// Running again with the same defines should yield no change
		const r2 = preprocessTokens(src, { includePaths: [], defines: r1.macros });
		expect(r2.macrosChanged).toBe(false);
		expect(r2.changedKeys.length).toBe(0);
	});

	it('handles CRLF in multi-line define by normalizing to \n', () => {
		const src = '#define X 1 + \\\r\n+2';
		const { macros } = preprocessTokens(src, { includePaths: [] });
		expect(macros.X).toBe('1 +\n+2');
	});
});
