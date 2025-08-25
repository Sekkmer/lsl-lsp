import fs from 'node:fs/promises';
import path from 'node:path';
import { parse as parseYAML } from 'yaml';
import Ajv2020 from 'ajv/dist/2020';
import schema from '../../common/lslDefSchema.json';

export interface DefParam { name: string; type: string; doc?: string; default?: any; }
export interface DefFunction { name: string; returns: string; params: DefParam[]; doc?: string; deprecated?: boolean; overloads?: DefFunction[]; }
export interface DefEvent { name: string; params: DefParam[]; doc?: string; }
export interface DefConst { name: string; type: string; value?: any; doc?: string; deprecated?: boolean; }
export interface DefFile {
	version: string;
	types: string[];
	keywords?: string[];
	constants: DefConst[];
	events: DefEvent[];
	functions: DefFunction[];
}
export class Defs {
	file: DefFile;
	types = new Set<string>();
	keywords = new Set<string>();
	consts = new Map<string, DefConst>();
	funcs = new Map<string, DefFunction[]>();
	events = new Map<string, DefEvent>();

	constructor(file: DefFile) {
		this.file = file;
		file.types.forEach(t => this.types.add(t));
		// Add known synonyms that the LSL compiler accepts
		// "quaternion" is interchangeable with "rotation"
		this.types.add('quaternion');
		(file.keywords || []).forEach(k => this.keywords.add(k));
		file.constants.forEach(c => this.consts.set(c.name, c));
		file.functions.forEach(f => {
			const prev = this.funcs.get(f.name) || [];
			prev.push(f);
			if (f.overloads) prev.push(...f.overloads);
			this.funcs.set(f.name, prev);
		});
		file.events.forEach(e => this.events.set(e.name, e));
	}
}

// Normalize type names to canonical LSL types used in analysis.
export function normalizeType(t: string): string {
	if (!t) return t;
	const v = t.toLowerCase();
	if (v === 'quaternion') return 'rotation';
	return t;
}

export async function loadDefs(defPath: string): Promise<Defs> {
	let raw: string;
	try {
		raw = await fs.readFile(defPath, 'utf8');
	} catch {
		// Fallback to bundled defs next to compiled server
		const bundled = path.resolve(__dirname, 'lsl-defs.json');
		raw = await fs.readFile(bundled, 'utf8');
	}
	const ext = path.extname(defPath).toLowerCase();
	let obj: any;
	try {
		obj = (ext === '.yaml' || ext === '.yml') ? parseYAML(raw) : JSON.parse(raw);
	} catch {
		// If the configured path was wrong and we used bundled JSON, parse as JSON
		obj = JSON.parse(raw);
	}
	const ajv = new Ajv2020({ allErrors: true, strict: false });
	const validate = ajv.compile(schema);
	if (!validate(obj)) {
		const msg = (validate.errors || []).map(e => `${e.instancePath} ${e.message}`).join('\n');
		throw new Error(`Definition file schema validation failed:\n${msg}`);
	}
	return new Defs(obj as unknown as DefFile);
}
