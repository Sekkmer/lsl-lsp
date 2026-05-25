import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { loadDefsFromSource, type Defs } from './defs';

export const DEFAULT_DEFINITIONS_UPDATE_URL = 'https://raw.githubusercontent.com/secondlife/lsl-definitions/main/lsl_definitions.yaml';

export interface DefinitionUpdateMetadata {
	sourceUrl: string;
	sha256: string;
	etag?: string;
	checkedAt: string;
	activatedAt: string;
	version: string;
	sizeBytes: number;
}

export interface DefinitionUpdateResult {
	updated: boolean;
	notModified: boolean;
	definitionsPath: string;
	metadata: DefinitionUpdateMetadata;
}

export interface DefinitionUpdateOptions {
	cacheDir: string;
	sourceUrl?: string;
	fetch?: FetchLike;
	now?: Date;
}

export interface DefinitionUpdatePaths {
	definitionsPath: string;
	metadataPath: string;
}

export type FetchLike = (url: string, init?: { headers?: Record<string, string> }) => Promise<FetchResponseLike>;

export interface FetchResponseLike {
	ok: boolean;
	status: number;
	statusText: string;
	text(): Promise<string>;
	headers: { get(name: string): string | null };
}

export function definitionUpdatePaths(cacheDir: string): DefinitionUpdatePaths {
	return {
		definitionsPath: path.join(cacheDir, 'lsl_definitions.yaml'),
		metadataPath: path.join(cacheDir, 'lsl_definitions.metadata.json'),
	};
}

export async function readDefinitionUpdateMetadata(cacheDir: string): Promise<DefinitionUpdateMetadata | null> {
	const { metadataPath } = definitionUpdatePaths(cacheDir);
	try {
		const raw = await fs.readFile(metadataPath, 'utf8');
		return parseDefinitionUpdateMetadata(raw);
	} catch (err) {
		const code = (err as NodeJS.ErrnoException)?.code;
		if (code === 'ENOENT' || code === 'ENOTDIR') return null;
		throw err;
	}
}

export async function cachedDefinitionPath(cacheDir: string): Promise<string | null> {
	const { definitionsPath } = definitionUpdatePaths(cacheDir);
	try {
		await fs.access(definitionsPath);
		return definitionsPath;
	} catch (err) {
		const code = (err as NodeJS.ErrnoException)?.code;
		if (code === 'ENOENT' || code === 'ENOTDIR') return null;
		throw err;
	}
}

export async function shouldCheckDefinitionUpdate(cacheDir: string, intervalMs: number, now = new Date()): Promise<boolean> {
	if (intervalMs <= 0) return true;
	const metadata = await readDefinitionUpdateMetadata(cacheDir);
	if (!metadata) return true;
	const checkedAt = Date.parse(metadata.checkedAt);
	return !Number.isFinite(checkedAt) || now.getTime() - checkedAt >= intervalMs;
}

export async function updateDefinitions(options: DefinitionUpdateOptions): Promise<DefinitionUpdateResult> {
	const sourceUrl = options.sourceUrl || DEFAULT_DEFINITIONS_UPDATE_URL;
	const now = options.now || new Date();
	const fetcher = options.fetch ?? defaultFetch;

	await fs.mkdir(options.cacheDir, { recursive: true });
	const paths = definitionUpdatePaths(options.cacheDir);
	const previous = await readDefinitionUpdateMetadata(options.cacheDir);
	const headers: Record<string, string> = {};
	if (previous?.etag && previous.sourceUrl === sourceUrl) headers['If-None-Match'] = previous.etag;

	const response = await fetcher(sourceUrl, { headers });
	if (response.status === 304 && previous && await cachedDefinitionPath(options.cacheDir)) {
		const metadata = { ...previous, checkedAt: now.toISOString() };
		await writeJsonAtomic(paths.metadataPath, metadata);
		return {
			updated: false,
			notModified: true,
			definitionsPath: paths.definitionsPath,
			metadata,
		};
	}
	if (!response.ok) {
		throw new Error(`Definition update failed: HTTP ${response.status} ${response.statusText}`);
	}

	const raw = await response.text();
	const defs = await loadDefsFromSource(raw, '<downloaded lsl_definitions.yaml>');
	validateDefinitionSmoke(defs);

	const sha256 = hashSha256(raw);
	const metadata: DefinitionUpdateMetadata = {
		sourceUrl,
		sha256,
		etag: response.headers.get('etag') ?? undefined,
		checkedAt: now.toISOString(),
		activatedAt: now.toISOString(),
		version: defs.file.version,
		sizeBytes: Buffer.byteLength(raw, 'utf8'),
	};
	const updated = previous?.sha256 !== sha256 || !await cachedDefinitionPath(options.cacheDir);
	await writeTextAtomic(paths.definitionsPath, raw);
	await writeJsonAtomic(paths.metadataPath, metadata);
	return {
		updated,
		notModified: false,
		definitionsPath: paths.definitionsPath,
		metadata,
	};
}

async function defaultFetch(url: string, init?: { headers?: Record<string, string> }): Promise<FetchResponseLike> {
	if (!globalThis.fetch) throw new Error('No fetch implementation is available for definition updates');
	return globalThis.fetch(url, init) as Promise<FetchResponseLike>;
}

function parseDefinitionUpdateMetadata(raw: string): DefinitionUpdateMetadata | null {
	try {
		const parsed = JSON.parse(raw) as Partial<DefinitionUpdateMetadata>;
		if (!parsed || typeof parsed !== 'object') return null;
		if (typeof parsed.sourceUrl !== 'string' || typeof parsed.sha256 !== 'string' || typeof parsed.checkedAt !== 'string' || typeof parsed.activatedAt !== 'string' || typeof parsed.version !== 'string' || typeof parsed.sizeBytes !== 'number') {
			return null;
		}
		return {
			sourceUrl: parsed.sourceUrl,
			sha256: parsed.sha256,
			etag: typeof parsed.etag === 'string' ? parsed.etag : undefined,
			checkedAt: parsed.checkedAt,
			activatedAt: parsed.activatedAt,
			version: parsed.version,
			sizeBytes: parsed.sizeBytes,
		};
	} catch {
		return null;
	}
}

function validateDefinitionSmoke(defs: Defs): void {
	const missing: string[] = [];
	if (!defs.consts.has('NULL_KEY')) missing.push('constant NULL_KEY');
	if (!defs.events.has('state_entry')) missing.push('event state_entry');
	if (!defs.funcs.has('llSay')) missing.push('function llSay');
	if (!defs.funcs.has('llMessageLinked')) missing.push('function llMessageLinked');
	if (missing.length > 0) {
		throw new Error(`Downloaded definitions are missing required entries: ${missing.join(', ')}`);
	}
}

function hashSha256(raw: string): string {
	return crypto.createHash('sha256').update(raw).digest('hex');
}

async function writeTextAtomic(file: string, raw: string): Promise<void> {
	const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
	await fs.writeFile(tmp, raw, 'utf8');
	await fs.rename(tmp, file);
}

async function writeJsonAtomic(file: string, value: unknown): Promise<void> {
	await writeTextAtomic(file, `${JSON.stringify(value, null, 2)}\n`);
}
