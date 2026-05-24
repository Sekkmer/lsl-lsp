import { describe, expect, it } from 'vitest';
import { filePathToUri, fileUriToPath } from '../src/protocol';

describe('file URI helpers', () => {
	it('round-trips POSIX paths with encoded characters', () => {
		const path = '/home/sekkmer/LSL Scripts/probe #1.lsl';
		const uri = filePathToUri(path);

		expect(uri).toBe('file:///home/sekkmer/LSL%20Scripts/probe%20%231.lsl');
		expect(fileUriToPath(uri)).toBe(path);
	});

	it('round-trips Windows drive paths independent of host OS', () => {
		const path = String.raw`C:\Users\Sekkmer\LSL Scripts\probe #1.lsl`;
		const uri = filePathToUri(path);

		expect(uri).toBe('file:///c%3A/Users/Sekkmer/LSL%20Scripts/probe%20%231.lsl');
		expect(fileUriToPath(uri)).toBe(String.raw`c:\Users\Sekkmer\LSL Scripts\probe #1.lsl`);
	});

	it('accepts common Windows drive URI spellings', () => {
		expect(fileUriToPath('file:///C:/Users/Sekkmer/probe.lsl')).toBe(String.raw`c:\Users\Sekkmer\probe.lsl`);
		expect(fileUriToPath('file:///c%3A/Users/Sekkmer/probe.lsl')).toBe(String.raw`c:\Users\Sekkmer\probe.lsl`);
	});

	it('round-trips Windows UNC paths independent of host OS', () => {
		const path = String.raw`\\server\share\LSL Scripts\probe #1.lsl`;
		const uri = filePathToUri(path);

		expect(uri).toBe('file://server/share/LSL%20Scripts/probe%20%231.lsl');
		expect(fileUriToPath(uri)).toBe(String.raw`\\server\share\LSL Scripts\probe #1.lsl`);
	});

	it('returns undefined for non-file URIs and invalid input', () => {
		expect(fileUriToPath('http://example.invalid/probe.lsl')).toBeUndefined();
		expect(fileUriToPath('not a uri')).toBeUndefined();
	});
});
