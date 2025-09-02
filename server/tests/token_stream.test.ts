import { describe, it, expect } from 'vitest';
import type { Token } from '../src/core/tokens';
import { TokenStream } from '../src/core/tokens';

function t(kind: Token['kind'], value: string, start: number, end: number): Token {
	return { kind, value, span: { start, end } };
}

describe('TokenStream', () => {
	it('peek does not consume and next returns same token', () => {
		const s = new TokenStream([
			t('id', 'a', 0, 1),
			t('id', 'b', 2, 3),
		]);
		const p = s.peek();
		const n = s.next();
		expect(p).toEqual(n);
		expect(n.kind).toBe('id');
		expect(n.value).toBe('a');
	});

	it('pushBack replays the token and ignores EOF pushBack', () => {
		const s = new TokenStream([
			t('id', 'x', 0, 1),
			t('id', 'y', 2, 3),
		]);
		const x = s.next();
		const y1 = s.next();
		// push back y and read again
		s.pushBack(y1);
		const y2 = s.next();
		expect(y2).toEqual(y1);
		// now at EOF; get and try to push EOF back (should be ignored)
		const e1 = s.next();
		expect(e1.kind).toBe('eof');
		s.pushBack(e1);
		const e2 = s.next();
		expect(e2).toBe(e1); // sticky EOF object
		// ensure original tokens were correct
		expect(x.value).toBe('x');
		expect(y1.value).toBe('y');
	});

	it('returns sticky EOF instance repeatedly (array source)', () => {
		const s = new TokenStream([t('id', 'a', 0, 1)]);
		const a = s.next();
		expect(a.kind).toBe('id');
		const e1 = s.next();
		const e2 = s.next();
		expect(e1.kind).toBe('eof');
		expect(e2.kind).toBe('eof');
		expect(e2).toBe(e1); // same object instance
	});

	it('producer mode: stops calling producer after EOF due to sticky EOF', () => {
		let calls = 0;
		const seq: Token[] = [
			t('number', '1', 0, 1),
			t('op', '+', 1, 2),
			t('eof', '', 2, 2),
		];
		const s = new TokenStream({
			producer: () => {
				calls++;
				return seq[Math.min(calls - 1, seq.length - 1)];
			},
		});
		const n1 = s.next();
		const n2 = s.next();
		const e1 = s.next();
		const e2 = s.next();
		expect(n1.value).toBe('1');
		expect(n2.value).toBe('+');
		expect(e1.kind).toBe('eof');
		expect(e2).toBe(e1); // sticky
		// producer should have been called exactly 3 times (two tokens + one EOF)
		expect(calls).toBe(3);
	});
});
