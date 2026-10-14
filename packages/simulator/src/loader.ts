import { createHash } from 'node:crypto';
import { access, readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { builtinConstantValuesFromDefs, loadDefs, parseScriptFromText, type Defs } from '@lsl-lsp/core';
import {
	SimLinkset,
	SimulatorWorld,
	type LinksetOptions,
	type PrimOptions,
	type ScriptOptions,
} from './world.js';

interface LinksetManifest {
	name?: string;
	key?: string;
	owner?: string;
	attached?: boolean;
}

interface ScriptManifest {
	running?: boolean;
}

interface PrimManifest {
	link?: number;
	name?: string;
	key?: string;
	scripts?: Record<string, ScriptManifest | boolean>;
}

export interface LoadProjectOptions {
	world?: SimulatorWorld;
	owner?: string;
	defs?: Defs;
}

export interface LoadedProject {
	world: SimulatorWorld;
	linkset: SimLinkset;
	linksetPath: string;
}

let bundledDefs: Promise<Defs> | undefined;

function defaultDefs(): Promise<Defs> {
	return bundledDefs ??= loadDefs(
		path.join(path.dirname(require.resolve('@lsl-lsp/core')), 'lsl_definitions.yaml'),
	);
}

export async function loadLinksetProject(
	projectPath: string,
	options: LoadProjectOptions = {},
): Promise<LoadedProject> {
	const resolvedProjectPath = path.resolve(projectPath);
	const linksetPath = await findLinksetPath(resolvedProjectPath);
	const manifest = await readJson<LinksetManifest>(path.join(linksetPath, 'linkset.json'), {});
	const world = options.world ?? new SimulatorWorld();
	const defs = options.defs ?? await defaultDefs();
	const constants = builtinConstantValuesFromDefs(defs);
	const linksetOptions: LinksetOptions = {
		name: manifest.name ?? path.basename(linksetPath),
		key: manifest.key ?? stableKey(`${linksetPath}:linkset`),
		owner: options.owner ?? manifest.owner ?? stableKey(`${linksetPath}:owner`),
		attached: manifest.attached ?? true,
	};
	if (world.linksets.some(linkset => linkset.key === linksetOptions.key)) {
		throw new Error(`duplicate linkset key ${linksetOptions.key}`);
	}
	// Do not leave half-loaded prims/scripts in a supplied world after an error.
	const linkset = new SimLinkset(world, linksetOptions);
	const primsPath = path.join(linksetPath, 'prims');
	const primDirectories = (await readdir(primsPath, { withFileTypes: true }))
		.filter(entry => entry.isDirectory())
		.map(entry => entry.name)
		.sort();
	if (primDirectories.length === 0) {
		throw new Error(`${primsPath} contains no prim directories`);
	}

	const loadedPrims: Array<{ directory: string; manifest: PrimManifest }> = [];
	for (const directory of primDirectories) {
		const manifestPath = path.join(primsPath, directory, 'prim.json');
		loadedPrims.push({
			directory,
			manifest: await readJson<PrimManifest>(manifestPath, {}),
		});
	}
	const explicitLinks = new Set<number>();
	for (const loaded of loadedPrims) {
		const link = loaded.manifest.link;
		if (link === undefined) continue;
		if (!Number.isInteger(link) || link < 1) {
			throw new Error(`${loaded.directory}/prim.json has invalid link ${String(link)}`);
		}
		if (explicitLinks.has(link)) throw new Error(`duplicate explicit link number ${link}`);
		explicitLinks.add(link);
	}
	let nextLink = 1;
	for (const loaded of loadedPrims) {
		while (explicitLinks.has(nextLink)) nextLink += 1;
		const link = loaded.manifest.link ?? nextLink++;
		const primPath = path.join(primsPath, loaded.directory);
		const primOptions: PrimOptions = {
			link,
			name: loaded.manifest.name ?? loaded.directory,
			key: loaded.manifest.key ?? stableKey(`${linksetOptions.key}:prim:${link}`),
		};
		const prim = linkset.addPrim(primOptions);
		const scriptsPath = path.join(primPath, 'scripts');
		const scriptFiles = await exists(scriptsPath)
			? (await readdir(scriptsPath, { withFileTypes: true }))
				.filter(entry => entry.isFile() && entry.name.toLowerCase().endsWith('.lsl'))
				.map(entry => entry.name)
				.sort()
			: [];
		for (const scriptFile of scriptFiles) {
			const sourcePath = path.join(scriptsPath, scriptFile);
			const source = await readFile(sourcePath, 'utf8');
			const ast = parseScriptFromText(source, pathToFileURL(sourcePath).href, {
				defs,
				includePaths: [scriptsPath, primPath, linksetPath, resolvedProjectPath],
			});
			const errors = ast.diagnostics?.filter(diagnostic =>
				diagnostic.severity === undefined || diagnostic.severity === 'error') ?? [];
			if (errors.length > 0) {
				const descriptions = errors.map(error => `${error.message} at ${error.span.start}`).join('; ');
				throw new Error(`${sourcePath}: ${descriptions}`);
			}
			const configured = loaded.manifest.scripts?.[scriptFile];
			const scriptOptions: ScriptOptions = {
				name: scriptFile,
				sourcePath,
				ast,
				assetKey: stableKey(`asset:${source}`),
				constants,
				running: typeof configured === 'boolean' ? configured : configured?.running,
			};
			prim.addScript(scriptOptions);
		}
	}

	if (!linkset.prim(1)) throw new Error(`${linksetPath} must contain a root prim with link number 1`);
	if (linkset.prims.some((prim, index) => prim.link !== index + 1)) {
		throw new Error(`${linksetPath} link numbers must be contiguous starting at 1`);
	}
	world.linksets.push(linkset);
	return { world, linkset, linksetPath };
}

async function findLinksetPath(projectPath: string): Promise<string> {
	if (await exists(path.join(projectPath, 'prims'))) return projectPath;
	const nested = path.join(projectPath, 'linkset');
	if (await exists(path.join(nested, 'prims'))) return nested;
	throw new Error(`${projectPath} must contain prims/ or linkset/prims/`);
}

async function exists(target: string): Promise<boolean> {
	try {
		await access(target);
		return true;
	} catch {
		return false;
	}
}

async function readJson<T>(target: string, fallback: T): Promise<T> {
	try {
		const parsed: unknown = JSON.parse(await readFile(target, 'utf8'));
		if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
			throw new Error('manifest must be a JSON object');
		}
		return parsed as T;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === 'ENOENT') return fallback;
		throw new Error(`cannot read ${target}: ${(error as Error).message}`, { cause: error });
	}
}

function stableKey(seed: string): string {
	const hex = createHash('sha256').update(seed).digest('hex').slice(0, 32);
	return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
