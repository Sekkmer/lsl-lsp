import { describe, it, expect } from 'vitest';
import { preprocessTokens } from '../src/core/pipeline';

describe('core pipeline', () => {
	it('captures multi-line object-like and function-like defines', () => {
		const src = [
			'#define FOO 1 + \\\n+2',
			'#define SUM(a,b) (a + \\\n+b)',
			'// active code below',
			'integer x = 0;',
		].join('\n');
		const { macros } = preprocessTokens(src, { includePaths: [] });
		// object-like body preserves embedded newlines (leading '+' kept on next line)
		expect(macros.FOO).toBe('1 +\n+2');
		// function-like macro serialized as (params) body, preserving newline and leading '+'
		expect(macros.SUM).toBe('(a,b) (a +\n+b)');
	});

	it('respects conditional activation (#if/#else)', () => {
		const src = [
			'#if 0',
			'integer a;',
			'#else',
			'integer b;',
			'#endif',
		].join('\n');
		const { tokens } = preprocessTokens(src, { includePaths: [] });
		const ids = tokens.filter(t => t.kind === 'id').map(t => t.value);
		expect(ids).toContain('b');
		expect(ids).not.toContain('a');
	});

	it('recursively includes files via resolver', () => {
		const files = new Map<string, string>();
		files.set('/v/main.lsl', '#include "inc.lsl"\ninteger x;');
		files.set('/v/inc.lsl', 'integer y;');
		const fakeFs = {
			existsSync: (p: string) => files.has(p),
			readFileSync: (p: string, _enc: string) => files.get(p) as string,
			statSync: (_p: string) => ({ mtimeMs: 1 }),
		};
		const { tokens, includes } = preprocessTokens(files.get('/v/main.lsl')!, { includePaths: ['/v'], fromPath: '/v/main.lsl', fs: fakeFs });
		// Should have included the file and produced tokens from both
		expect(includes).toContain('/v/inc.lsl');
		const ids = tokens.filter(t => t.kind === 'id').map(t => t.value);
		// order is include first, then main
		expect(ids).toEqual(['y', 'x']);
	});
});
