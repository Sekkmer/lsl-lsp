import { describe, expect, it } from 'vitest';
import { decodeFirestormPreprocessorHeader, detectFirestormRuntimeDirective, encodeFirestormPreprocessorHeader, wrapWithFirestormPreprocessorHeader } from '../src/firestormHeader';

describe('Firestorm preprocessor header', () => {
	it('round-trips source that contains comment delimiters and marker escapes', () => {
		const source = 'default { state_entry() { llOwnerSay("/* // | */"); } }\n// tail\n';
		const header = encodeFirestormPreprocessorHeader(source, {
			programVersion: 'test',
			lastCompiled: 'now',
			runtime: 'lsl2',
		});
		const decoded = decodeFirestormPreprocessorHeader(`${header}\ndefault{state_entry(){}}`);
		expect(decoded?.originalSource).toBe(source);
		expect(decoded?.body).toBe('default{state_entry(){}}');
	});

	it('wraps a rendered body with the reversible source header', () => {
		const wrapped = wrapWithFirestormPreprocessorHeader('//mono\ninteger VALUE = 1;', 'integer VALUE=1;', {
			programVersion: 'test',
			lastCompiled: 'now',
		});
		expect(wrapped).toContain('//start_unprocessed_text\n/*/|/mono');
		expect(wrapped).toContain('//nfo_preprocessor_version 0');
		expect(wrapped).toContain('//mono\n\ninteger VALUE=1;');
		expect(decodeFirestormPreprocessorHeader(wrapped)?.originalSource).toBe('//mono\ninteger VALUE = 1;');
	});

	it('returns null when no Firestorm header is present', () => {
		expect(decodeFirestormPreprocessorHeader('default { state_entry() { } }')).toBeNull();
	});

	it('matches Firestorm runtime directive precedence', () => {
		expect(detectFirestormRuntimeDirective('integer x;\n//lsl2\n')).toBe('lsl2');
		expect(detectFirestormRuntimeDirective('integer x; //lsl2\n')).toBe('lsl2');
		expect(detectFirestormRuntimeDirective('//lsl2\n//mono\n')).toBe('mono');
		expect(detectFirestormRuntimeDirective('//lsl2\r\n')).toBe('mono');
		expect(encodeFirestormPreprocessorHeader('integer x;\n')).toContain('\n//mono\n');
	});
});
