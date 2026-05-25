/* Centralized helpers for built-in macros and URI filename handling */

import { canonicalType, isTypeName, type Type } from './ast/types';

export type DynamicMacroMap = Record<string, Type>;

export const FIRESTORM_DYNAMIC_MACROS: DynamicMacroMap = {
	__AGENTID__: 'string',
	__AGENTKEY__: 'string',
	__AGENTIDRAW__: 'key',
	__AGENTNAME__: 'string',
	__ASSETID__: 'string',
	__UNIXTIME__: 'integer',
};

export function parseDynamicMacroList(input: unknown): DynamicMacroMap {
	const out: DynamicMacroMap = {};
	const add = (raw: string): void => {
		const trimmed = raw.trim();
		if (!trimmed) return;
		const sep = trimmed.indexOf(':');
		if (sep <= 0 || sep === trimmed.length - 1) throw new Error(`Invalid dynamic macro entry: ${raw}`);
		const name = trimmed.slice(0, sep).trim();
		const rawType = trimmed.slice(sep + 1).trim();
		if (!/^[A-Za-z_]\w*$/.test(name)) throw new Error(`Invalid dynamic macro name: ${name}`);
		if (!isTypeName(rawType)) throw new Error(`Invalid dynamic macro type for ${name}: ${rawType}`);
		out[name] = canonicalType(rawType);
	};
	if (Array.isArray(input)) {
		for (const item of input) {
			if (typeof item !== 'string') throw new Error('Dynamic macro entries must be strings.');
			add(item);
		}
	} else if (typeof input === 'string') {
		for (const item of input.split(',')) add(item);
	} else if (input && typeof input === 'object') {
		for (const [name, rawType] of Object.entries(input)) {
			if (typeof rawType !== 'string') throw new Error(`Invalid dynamic macro type for ${name}`);
			add(`${name}:${rawType}`);
		}
	}
	return out;
}

// Compute a display filename (basename) from a VSCode-style URI or raw path
export function basenameFromUri(uri: string): string {
	try {
		const u = new URL(uri);
		const p = u.protocol === 'file:' ? decodeURIComponent(u.pathname) : uri;
		const parts = p.split(/[\\/]/);
		return parts[parts.length - 1] || 'memory.lsl';
	} catch {
		const parts = uri.replace(/^file:\/\//, '').split(/[\\/]/);
		return parts[parts.length - 1] || 'memory.lsl';
	}
}

// Generate expansion for built-in macros at lexing time.
// Return token kind and already JSON-encoded string when kind==='string'.
export function builtinMacroForLexer(
	name: string,
	ctx: { filename: string; line: number; now?: Date }
): { kind: 'number' | 'string'; value: string } | null {
	switch (name) {
		case '__LINE__':
			return { kind: 'number', value: String(ctx.line) };
		case '__FILE__':
			// Defer __FILE__ expansion until AST parser builtin pass so we can reliably
			// compute the basename from the final document URI. Returning null keeps
			// the identifier token intact through preprocessing/macro expansion.
			return null; // handled later in parser.applyBuiltinExpansions
		case '__TIME__': {
			const d = ctx.now ?? new Date();
			const time = d.toLocaleTimeString('en-US', { hour12: false });
			return { kind: 'string', value: JSON.stringify(time) };
		}
		case '__DATE__': {
			const d = ctx.now ?? new Date();
			// Keep behavior stable: US locale date, UTC zone for determinism in tests
			const date = d.toLocaleDateString('en-US', { timeZone: 'UTC' });
			return { kind: 'string', value: JSON.stringify(date) };
		}
		default:
			return null;
	}
}
