import process from 'node:process';
import fs from 'node:fs/promises';
import path from 'node:path';
import yaml from 'js-yaml';
import Ajv2020 from 'ajv/dist/2020';
import schema from '../../common/lslDefSchema.json';
import draft7Meta from 'ajv/dist/refs/json-schema-draft-07.json';

export interface DefParam { name: string; type: string; doc?: string; default?: string | number | boolean | null };
export interface DefFunction { name: string; returns: string; params: DefParam[]; doc?: string; deprecated?: boolean; overloads?: DefFunction[]; wiki?: string; energy?: number; sleep?: number; experience?: boolean; }
export interface DefEvent { name: string; params: DefParam[]; doc?: string; wiki?: string; }
export interface DefConst { name: string; type: string; value?: string | number | boolean | null; doc?: string; deprecated?: boolean; wiki?: string; }
export interface DefFile {
	version: string;
	constants: DefConst[];
	events: DefEvent[];
	functions: DefFunction[];
}
export class Defs {
	file: DefFile;
	consts = new Map<string, DefConst>();
	funcs = new Map<string, DefFunction[]>();
	events = new Map<string, DefEvent>();

	constructor(file: DefFile) {
		this.file = file;
		// Add known synonyms that the LSL compiler accepts
		// "quaternion" is interchangeable with "rotation"
		file.constants.forEach(c => {
			this.consts.set(c.name, c);
		});
		file.functions.forEach(f => {
			const prev = this.funcs.get(f.name) || [];
			prev.push(f);
			if (f.overloads) prev.push(...f.overloads);
			this.funcs.set(f.name, prev);
		});
		file.events.forEach(e => {
			this.events.set(e.name, e);
		});
	}
}

const WIKI_BASE = 'https://wiki.secondlife.com/wiki/';

type OfficialParamEntry = Record<string, { type?: string; tooltip?: string; description?: string }>;
interface OfficialCommonFields {
	tooltip?: string;
	deprecated?: boolean;
	private?: boolean;
}
interface OfficialFunctionEntry extends OfficialCommonFields {
	return?: string;
	arguments?: OfficialParamEntry[];
	energy?: unknown;
	sleep?: unknown;
	experience?: unknown;
}
interface OfficialEventEntry extends OfficialCommonFields {
	arguments?: OfficialParamEntry[];
}
interface OfficialConstantEntry extends OfficialCommonFields {
	type?: string;
	value?: unknown;
}
interface OfficialDefinitions {
	['llsd-lsl-syntax-version']?: number;
	constants?: Record<string, OfficialConstantEntry>;
	functions?: Record<string, OfficialFunctionEntry>;
	events?: Record<string, OfficialEventEntry>;
	types?: Record<string, { tooltip?: string; private?: boolean }>;
	controls?: Record<string, unknown>;
}

type OverrideValue = string | null | boolean | undefined;
interface OverrideEntry {
	doc?: OverrideValue;
	wiki?: OverrideValue;
	deprecated?: boolean;
}
interface ParamOverride {
	name?: string;
	type?: string;
	doc?: OverrideValue;
	default?: unknown;
}
interface FunctionOverride extends OverrideEntry {
	params?: Record<string, ParamOverride>;
	energy?: number | null;
	sleep?: number | null;
	experience?: boolean | null;
}
interface OverridesFile {
	version?: number;
	constants?: Record<string, OverrideEntry>;
	functions?: Record<string, FunctionOverride>;
	events?: Record<string, OverrideEntry>;
}
interface Overrides {
	constants: Record<string, OverrideEntry>;
	functions: Record<string, FunctionOverride>;
	events: Record<string, OverrideEntry>;
}

function sanitizeDoc(doc?: unknown): string | undefined {
	if (typeof doc !== 'string') return undefined;
	const text = doc.replace(/\s+/g, ' ').trim();
	return text.length > 0 ? text : undefined;
}

function normalizeOfficialType(type?: unknown): string {
	if (typeof type !== 'string' || !type) return 'void';
	return type.toLowerCase();
}

function normalizeParamName(name?: string, index = 0): string {
	if (!name || !name.trim()) return `arg${index + 1}`;
	const trimmed = name.trim();
	return trimmed.charAt(0).toLowerCase() + trimmed.slice(1);
}

function parseNumber(value: unknown): number | undefined {
	if (typeof value === 'number') return value;
	if (value == null) return undefined;
	const raw = String(value).trim();
	if (!raw) return undefined;
	if (/^0x[0-9a-f]+$/i.test(raw)) return Number.parseInt(raw, 16);
	if (/^-?\d+(?:\.\d+)?$/.test(raw)) return Number(raw);
	return undefined;
}

function normalizeConstantValue(type: string, value: unknown): string | number | undefined {
	if (value == null) return undefined;
	const t = normalizeOfficialType(type);
	if (t === 'integer' || t === 'float') {
		const num = parseNumber(value);
		if (num !== undefined && Number.isFinite(num)) return t === 'integer' ? Math.trunc(num) : num;
		return undefined;
	}
	if (t === 'string' || t === 'key') {
		if (typeof value === 'string') return value.replace(/^['"]|['"]$/g, '');
		return String(value);
	}
	return typeof value === 'string' ? value.trim() : (value as string | number | undefined);
}

function defaultWiki(name: string): string {
	return `${WIKI_BASE}${encodeURIComponent(name)}`;
}

function applyEntryOverride<T extends { doc?: string; wiki?: string; deprecated?: boolean }>(target: T, override?: OverrideEntry): T {
	if (!override) return target;
	const out: T = { ...target };
	if (Object.prototype.hasOwnProperty.call(override, 'doc')) {
		const doc = override.doc;
		if (typeof doc === 'string' && doc.trim()) out.doc = doc.trim();
		else if (doc === null || doc === false) delete out.doc;
	}
	if (Object.prototype.hasOwnProperty.call(override, 'wiki')) {
		const wiki = override.wiki;
		if (typeof wiki === 'string' && wiki.trim()) out.wiki = wiki.trim();
		else if (wiki === null || wiki === false) delete out.wiki;
	}
	if (Object.prototype.hasOwnProperty.call(override, 'deprecated')) {
		const dep = override.deprecated;
		if (dep) out.deprecated = true;
		else delete out.deprecated;
	}
	return out;
}

function applyFunctionOverride(target: DefFunction, override?: FunctionOverride): DefFunction {
	let next: DefFunction = applyEntryOverride(target, override);
	if (override) {
		if (Object.prototype.hasOwnProperty.call(override, 'energy')) {
			const energy = override.energy;
			if (typeof energy === 'number') next = { ...next, energy };
			else if (energy === null) {
				const { energy: _omit, ...rest } = next;
				next = rest;
			}
		}
		if (Object.prototype.hasOwnProperty.call(override, 'sleep')) {
			const sleep = override.sleep;
			if (typeof sleep === 'number') next = { ...next, sleep };
			else if (sleep === null) {
				const { sleep: _omit, ...rest } = next;
				next = rest;
			}
		}
		if (Object.prototype.hasOwnProperty.call(override, 'experience')) {
			const exp = override.experience;
			if (exp === true) next = { ...next, experience: true };
			else if (exp === false) {
				next = { ...next, experience: false };
			} else if (exp === null) {
				const { experience: _omit, ...rest } = next;
				next = rest;
			}
		}
	}
	if (!override?.params || !Array.isArray(next.params)) return next;
	const merged = [...next.params];
	for (const [key, value] of Object.entries(override.params)) {
		if (!value || typeof value !== 'object') continue;
		let index = Number.isInteger(Number(key)) ? Number(key) : Number.NaN;
		if (!Number.isInteger(index) || index < 0 || index >= merged.length) {
			index = merged.findIndex(p => p.name === key);
		}
		if (index < 0 || index >= merged.length) continue;
		const current = { ...merged[index] };
		if (typeof value.name === 'string' && value.name.trim()) current.name = value.name.trim();
		if (typeof value.type === 'string' && value.type.trim()) current.type = value.type.trim();
		if (Object.prototype.hasOwnProperty.call(value, 'doc')) {
			const doc = value.doc;
			if (typeof doc === 'string' && doc.trim()) current.doc = doc.trim();
			else if (doc === null || doc === false) delete current.doc;
		}
		if (Object.prototype.hasOwnProperty.call(value, 'default')) {
			const defVal = value.default;
			if (defVal === null || defVal === false) delete current.default;
			else current.default = defVal as string | number | boolean | null;
		}
		merged[index] = current;
	}
	return { ...next, params: merged };
}

function normalizeOverrides(value: OverridesFile | null | undefined): Overrides {
	return {
		constants: value?.constants ?? {},
		functions: value?.functions ?? {},
		events: value?.events ?? {},
	};
}

async function loadOverridesFor(defPath: string): Promise<Overrides> {
	const candidates: string[] = [];
	const envPath = process.env.LSL_DEFS_OVERRIDES;
	if (envPath && envPath.trim()) candidates.push(envPath.trim());
	const dir = path.dirname(defPath);
	candidates.push(path.resolve(dir, 'lsl-defs.overrides.json'));
	candidates.push(path.resolve(dir, '..', 'lsl-defs.overrides.json'));
	candidates.push(path.resolve(__dirname, '../../common/lsl-defs.overrides.json'));
	const seen = new Set<string>();
	for (const candidate of candidates) {
		if (!candidate) continue;
		const resolved = path.resolve(candidate);
		if (seen.has(resolved)) continue;
		seen.add(resolved);
		try {
			const raw = await fs.readFile(resolved, 'utf8');
			const parsed = JSON.parse(raw) as OverridesFile;
			return normalizeOverrides(parsed);
		} catch (err) {
			const code = (err as NodeJS.ErrnoException)?.code;
			if (code === 'ENOENT' || code === 'ENOTDIR') continue;
			throw err;
		}
	}
	return normalizeOverrides(null);
}

function isOfficialDefinitions(obj: unknown): obj is OfficialDefinitions {
	if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return false;
	const record = obj as Record<string, unknown>;
	const constants = record.constants;
	const functions = record.functions;
	if (!constants || !functions) return false;
	if (Array.isArray(constants) || Array.isArray(functions)) return false;
	if (record.version) return false; // schema-based JSON definitions include a version string
	return true;
}

function toDefFileFromOfficial(defs: OfficialDefinitions, overrides: Overrides): DefFile {
	const version = new Date().toISOString().slice(0, 10);

	const constants: DefConst[] = [];
	for (const [name, info] of Object.entries(defs.constants ?? {})) {
		if (info?.private) continue;
		const type = normalizeOfficialType(info?.type);
		const value = normalizeConstantValue(type, info?.value);
		const doc = sanitizeDoc(info?.tooltip);
		const base: DefConst = {
			name,
			type,
			...(value !== undefined ? { value } : {}),
			...(doc ? { doc } : {}),
			wiki: defaultWiki(name),
			...(info?.deprecated ? { deprecated: true } : {}),
		};
		const overridden = applyEntryOverride(base, overrides.constants[name]);
		constants.push(overridden);
	}
	constants.sort((a, b) => a.name.localeCompare(b.name));

	const functions: DefFunction[] = [];
	for (const [name, info] of Object.entries(defs.functions ?? {})) {
		if (info?.private) continue;
		const params: DefParam[] = [];
		(info?.arguments ?? []).forEach((entry, index) => {
			const [paramName, details] = Object.entries(entry ?? {}).at(0) ?? [];
			if (!paramName) return;
			const type = normalizeOfficialType(details?.type);
			const doc = sanitizeDoc(details?.tooltip ?? details?.description);
			params.push({
				name: normalizeParamName(paramName, index),
				type,
				...(doc ? { doc } : {}),
			});
		});
		const doc = sanitizeDoc(info?.tooltip);
		const energy = parseNumber(info?.energy);
		const sleep = parseNumber(info?.sleep);
		const experience = typeof info?.experience === 'boolean' ? info.experience : info?.experience === 1 || info?.experience === '1' || info?.experience === 'true';
		const base: DefFunction = {
			name,
			returns: normalizeOfficialType(info?.return),
			params,
			...(doc ? { doc } : {}),
			...(info?.deprecated ? { deprecated: true } : {}),
			wiki: defaultWiki(name),
			...(Number.isFinite(energy) ? { energy: energy as number } : {}),
			...(Number.isFinite(sleep) ? { sleep: sleep as number } : {}),
			...(experience ? { experience: true } : {}),
		};
		const overridden = applyFunctionOverride(base, overrides.functions[name]);
		functions.push(overridden);
	}
	functions.sort((a, b) => a.name.localeCompare(b.name));

	const events: DefEvent[] = [];
	for (const [name, info] of Object.entries(defs.events ?? {})) {
		if (info?.private) continue;
		const params: DefParam[] = [];
		(info?.arguments ?? []).forEach((entry, index) => {
			const [paramName, details] = Object.entries(entry ?? {}).at(0) ?? [];
			if (!paramName) return;
			const type = normalizeOfficialType(details?.type);
			const doc = sanitizeDoc(details?.tooltip ?? details?.description);
			params.push({
				name: normalizeParamName(paramName, index),
				type,
				...(doc ? { doc } : {}),
			});
		});
		const doc = sanitizeDoc(info?.tooltip);
		const base: DefEvent = {
			name,
			params,
			...(doc ? { doc } : {}),
			wiki: defaultWiki(name),
		};
		const overridden = applyEntryOverride(base, overrides.events[name]);
		events.push(overridden);
	}
	events.sort((a, b) => a.name.localeCompare(b.name));

	return { version, constants, functions, events };
}

// Normalize type names to canonical LSL types used in analysis.
export function normalizeType(t: string): string {
	if (!t) return t;
	const v = t.toLowerCase();
	if (v === 'quaternion') return 'rotation';
	return t;
}

const BUILD_OUTPUT_YAML = path.resolve(__dirname, '..', 'out', 'lsl_definitions.yaml');
const DEFAULT_OFFICIAL_YAML = path.resolve(__dirname, '..', '..', 'third_party', 'lsl-definitions', 'lsl_definitions.yaml');

async function resolveDefinitionPath(defPath: string): Promise<{ raw: string; resolvedPath: string }> {
	const requested = defPath?.trim();
	const candidates: string[] = [];
	if (requested) {
		if (path.isAbsolute(requested)) candidates.push(requested);
		else {
			candidates.push(path.resolve(process.cwd(), requested));
			candidates.push(path.resolve(__dirname, requested));
		}
	}
	candidates.push(BUILD_OUTPUT_YAML);
	candidates.push(DEFAULT_OFFICIAL_YAML);
	const seen = new Set<string>();
	let lastErr: unknown;
	for (const candidate of candidates) {
		const resolved = path.resolve(candidate);
		if (seen.has(resolved)) continue;
		seen.add(resolved);
		try {
			const raw = await fs.readFile(resolved, 'utf8');
			return { raw, resolvedPath: resolved };
		} catch (err) {
			lastErr = err;
		}
	}
	throw lastErr ?? new Error('No definition file could be resolved');
}

export async function loadDefs(defPath: string): Promise<Defs> {
	const { raw, resolvedPath } = await resolveDefinitionPath(defPath);

	const obj = yaml.load(raw, { json: true });
	if (!obj) {
		throw new Error(`Definition file "${resolvedPath}" appears to be empty or could not be parsed`);
	}
	if (isOfficialDefinitions(obj)) {
		const overrides = await loadOverridesFor(resolvedPath);
		return validateAndCreate(toDefFileFromOfficial(obj, overrides));
	}
	return validateAndCreate(obj as DefFile);
}

function validateAndCreate(defs: DefFile): Defs {
	const ajv = new Ajv2020({ allErrors: true, strict: false });
	ajv.addMetaSchema(draft7Meta as unknown as object);
	const validate = ajv.compile(schema);
	if (!validate(defs)) {
		const msg = (validate.errors || []).map(e => `${e.instancePath} ${e.message}`).join('\n');
		throw new Error(`Definition file schema validation failed:\n${msg}`);
	}
	return new Defs(defs);
}
