import type { MacroDefines } from './core/macro';

export const LSL_EXTENSION_NAMES = [
	'switch',
	'lazyLists',
	'constGlobalExpressions',
] as const;

export type LslExtensionName = typeof LSL_EXTENSION_NAMES[number];

export type LslExtensionSettings = Partial<Record<LslExtensionName, boolean>>;

export type LslExtensionSource = 'config' | 'comment' | 'firestorm-macro';

export interface ResolvedLslExtensions {
	switch: boolean;
	lazyLists: boolean;
	constGlobalExpressions: boolean;
	firestormPreprocessorDisabled: boolean;
	sources: Partial<Record<LslExtensionName, LslExtensionSource>>;
}

const EXTENSION_ALIASES: Record<string, LslExtensionName> = {
	switch: 'switch',
	switches: 'switch',
	'lazy-list': 'lazyLists',
	'lazy-lists': 'lazyLists',
	lazylist: 'lazyLists',
	lazylists: 'lazyLists',
	lazyLists: 'lazyLists',
	'const-global': 'constGlobalExpressions',
	'const-globals': 'constGlobalExpressions',
	'const-global-expression': 'constGlobalExpressions',
	'const-global-expressions': 'constGlobalExpressions',
	constglobal: 'constGlobalExpressions',
	constglobals: 'constGlobalExpressions',
	constGlobalExpressions: 'constGlobalExpressions',
};

function normalizeExtensionName(raw: string): LslExtensionName | null {
	const trimmed = raw.trim();
	if (!trimmed) return null;
	const direct = EXTENSION_ALIASES[trimmed];
	if (direct) return direct;
	const key = trimmed.replace(/_/g, '-').replace(/([a-z0-9])([A-Z])/g, '$1-$2').toLowerCase();
	return EXTENSION_ALIASES[key] ?? null;
}

export function parseLslExtensionSettings(raw: unknown): LslExtensionSettings {
	const out: LslExtensionSettings = {};
	const set = (name: string, enabled = true): void => {
		const normalized = normalizeExtensionName(name);
		if (normalized) out[normalized] = enabled;
	};
	if (typeof raw === 'string') {
		for (const part of raw.split(/[\s,]+/)) set(part);
		return out;
	}
	if (Array.isArray(raw)) {
		for (const item of raw) if (typeof item === 'string') set(item);
		return out;
	}
	if (!raw || typeof raw !== 'object') return out;
	for (const [name, value] of Object.entries(raw)) {
		if (typeof value === 'boolean') set(name, value);
	}
	return out;
}

export function formatLslExtensionName(name: LslExtensionName): string {
	switch (name) {
		case 'switch': return 'switch';
		case 'lazyLists': return 'lazy-lists';
		case 'constGlobalExpressions': return 'const-globals';
	}
}

function hasMacro(macros: MacroDefines | undefined, name: string): boolean {
	return !!macros && Object.prototype.hasOwnProperty.call(macros, name);
}

type CommentDirective = { mode: 'enable' | 'disable-all'; names: LslExtensionName[] };

function parseCommentDirective(body: string): CommentDirective | null {
	const match = body.match(/^lsl-lsp\s+extensions?\s*:\s*(.+)$/i);
	if (!match) {
		if (/^lsl-lsp\s+no-extensions\b/i.test(body)) return { mode: 'disable-all', names: [] };
		return null;
	}
	const raw = match[1].trim();
	if (/^(?:off|none|false|0|disable|disabled)$/i.test(raw)) return { mode: 'disable-all', names: [] };
	if (/^(?:firestorm|fs)$/i.test(raw)) return { mode: 'enable', names: ['switch', 'lazyLists'] };
	const names: LslExtensionName[] = [];
	for (const part of raw.split(/[\s,]+/)) {
		const normalized = normalizeExtensionName(part);
		if (normalized && !names.includes(normalized)) names.push(normalized);
	}
	return names.length ? { mode: 'enable', names } : null;
}

function readCommentDirectives(text: string, commentLines?: readonly string[]): { firestormPreprocessorDisabled: boolean; directives: CommentDirective[] } {
	const directives: CommentDirective[] = [];
	let firestormPreprocessorDisabled = false;
	const comments = commentLines ?? Array.from(text.matchAll(/\/\/[^\r\n]*/g), match => match[0]);
	for (const comment of comments) {
		const body = comment.replace(/^\/\//, '').trim();
		if (/^fspreprocessor\s+off\b/i.test(body)) {
			firestormPreprocessorDisabled = true;
			continue;
		}
		const directive = parseCommentDirective(body);
		if (directive) directives.push(directive);
	}
	return { firestormPreprocessorDisabled, directives };
}

export function resolveLslExtensions(
	text: string,
	config?: LslExtensionSettings,
	macros?: MacroDefines,
	commentLines?: readonly string[],
): ResolvedLslExtensions {
	const resolved: ResolvedLslExtensions = {
		switch: false,
		lazyLists: false,
		constGlobalExpressions: false,
		firestormPreprocessorDisabled: false,
		sources: {},
	};
	const assign = (name: LslExtensionName, enabled: boolean, source: LslExtensionSource): void => {
		resolved[name] = enabled;
		if (enabled) resolved.sources[name] = source;
		else delete resolved.sources[name];
	};

	const parsedConfig = parseLslExtensionSettings(config);
	for (const name of LSL_EXTENSION_NAMES) {
		if (typeof parsedConfig[name] === 'boolean') assign(name, parsedConfig[name], 'config');
	}

	const commentState = readCommentDirectives(text, commentLines);
	resolved.firestormPreprocessorDisabled = commentState.firestormPreprocessorDisabled;
	if (!commentState.firestormPreprocessorDisabled) {
		if (hasMacro(macros, 'USE_SWITCHES')) assign('switch', true, 'firestorm-macro');
		if (hasMacro(macros, 'USE_LAZY_LISTS')) assign('lazyLists', true, 'firestorm-macro');
	}

	for (const directive of commentState.directives) {
		if (directive.mode === 'disable-all') {
			for (const name of LSL_EXTENSION_NAMES) assign(name, false, 'comment');
			continue;
		}
		for (const name of directive.names) assign(name, true, 'comment');
	}

	return resolved;
}
