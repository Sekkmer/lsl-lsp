import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { cachedDefinitionPath, readDefinitionUpdateMetadata, shouldCheckDefinitionUpdate, updateDefinitions, type FetchLike } from '../src/definitionUpdate';

const VALID_DEFS = `version: test-update
constants:
  - name: NULL_KEY
    type: key
events:
  - name: state_entry
    params: []
functions:
  - name: llSay
    returns: void
    params:
      - name: channel
        type: integer
      - name: msg
        type: string
  - name: llMessageLinked
    returns: void
    params:
      - name: link
        type: integer
      - name: num
        type: integer
      - name: str
        type: string
      - name: id
        type: key
`;

const tempDirs: string[] = [];

afterEach(async () => {
	await Promise.all(tempDirs.splice(0).map(dir => fs.rm(dir, { recursive: true, force: true })));
});

describe('definition updater', () => {
	it('downloads, validates, and caches definitions with metadata', async () => {
		const dir = await tempDir();
		const result = await updateDefinitions({
			cacheDir: dir,
			sourceUrl: 'https://example.test/defs.yaml',
			now: new Date('2026-05-26T10:00:00.000Z'),
			fetch: okFetch(VALID_DEFS, '"abc"'),
		});

		expect(result.updated).toBe(true);
		expect(result.notModified).toBe(false);
		expect(await fs.readFile(result.definitionsPath, 'utf8')).toBe(VALID_DEFS);
		expect(await cachedDefinitionPath(dir)).toBe(result.definitionsPath);
		const metadata = await readDefinitionUpdateMetadata(dir);
		expect(metadata?.sourceUrl).toBe('https://example.test/defs.yaml');
		expect(metadata?.etag).toBe('"abc"');
		expect(metadata?.version).toBe('test-update');
		expect(metadata?.checkedAt).toBe('2026-05-26T10:00:00.000Z');
	});

	it('updates check time without rewriting definitions on 304', async () => {
		const dir = await tempDir();
		await updateDefinitions({
			cacheDir: dir,
			now: new Date('2026-05-26T10:00:00.000Z'),
			fetch: okFetch(VALID_DEFS, '"abc"'),
		});

		const result = await updateDefinitions({
			cacheDir: dir,
			now: new Date('2026-05-26T12:00:00.000Z'),
			fetch: notModifiedFetch(),
		});

		expect(result.updated).toBe(false);
		expect(result.notModified).toBe(true);
		expect(result.metadata.checkedAt).toBe('2026-05-26T12:00:00.000Z');
		expect(await fs.readFile(result.definitionsPath, 'utf8')).toBe(VALID_DEFS);
	});

	it('uses metadata age for interval checks', async () => {
		const dir = await tempDir();
		await updateDefinitions({
			cacheDir: dir,
			now: new Date('2026-05-26T10:00:00.000Z'),
			fetch: okFetch(VALID_DEFS),
		});

		await expect(shouldCheckDefinitionUpdate(dir, 24 * 60 * 60 * 1000, new Date('2026-05-26T11:00:00.000Z'))).resolves.toBe(false);
		await expect(shouldCheckDefinitionUpdate(dir, 24 * 60 * 60 * 1000, new Date('2026-05-27T11:00:00.000Z'))).resolves.toBe(true);
	});

	it('rejects downloaded definitions missing required smoke entries', async () => {
		const dir = await tempDir();
		await expect(updateDefinitions({
			cacheDir: dir,
			fetch: okFetch('version: bad\nconstants: []\nevents: []\nfunctions: []\n'),
		})).rejects.toThrow(/missing required entries/);
		await expect(cachedDefinitionPath(dir)).resolves.toBeNull();
	});
});

async function tempDir(): Promise<string> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lsl-def-update-'));
	tempDirs.push(dir);
	return dir;
}

function okFetch(body: string, etag?: string): FetchLike {
	return async () => ({
		ok: true,
		status: 200,
		statusText: 'OK',
		text: async () => body,
		headers: { get: (name: string) => name.toLowerCase() === 'etag' ? etag ?? null : null },
	});
}

function notModifiedFetch(): FetchLike {
	return async () => ({
		ok: false,
		status: 304,
		statusText: 'Not Modified',
		text: async () => '',
		headers: { get: () => null },
	});
}
