import {
	createConnection,
	TextDocuments,
	Diagnostic,
	DiagnosticSeverity,
	ProposedFeatures,
	InitializeParams,
	DidChangeConfigurationNotification,
	CompletionItem,
	TextDocumentSyncKind,
	InitializeResult,
	type Connection,
	CompletionParams,
	HoverParams,
	Hover,
	SignatureHelpParams,
	DocumentSymbolParams,
	SemanticTokens,
	SemanticTokensParams,
	SignatureHelp,
	Definition,
	LocationLink,
	FileChangeType,
} from 'vscode-languageserver/node';
import { TextDocument } from "vscode-languageserver-textdocument";
import { loadDefs, Defs } from './defs';
import type { PreprocResult } from './core/preproc';
import { preprocessForAst } from './core/pipeline';
import { lex } from './lexer';
import { Analysis, LSL_DIAGCODES } from './analysisTypes';
import { semanticTokensLegend, buildSemanticTokens } from './semtok';
import { lslCompletions, resolveCompletion, lslSignatureHelp } from './completions';
import { lslHover } from './hover';
import { formatDocumentEdits, type FormatSettings, formatRangeEdits, detectIndent } from './format';
import { documentSymbols, gotoDefinition } from './symbols';
import {
	DocumentLink, DocumentLinkParams, DocumentFormattingParams, TextEdit, CodeAction, CodeActionKind, Range,
	DocumentRangeFormattingParams, DocumentOnTypeFormattingParams
} from 'vscode-languageserver/node';
import { URI } from 'vscode-uri';
import { prepareRename as navPrepareRename, computeRenameEdits, findAllReferences } from './navigation';
import { parseScriptFromText } from './ast/parser';
import { analyzeAst } from './ast/analyze';
import { isType } from './ast';
import { preprocessMacros } from './core/pipeline';

const connection: Connection = createConnection(ProposedFeatures.all);
const documents = new TextDocuments(TextDocument);

let defs: Defs | null = null;
// Persist workspace root paths (filesystem paths) detected at initialize time
let workspaceRootPaths: string[] = [];
const settings = {
	definitionsPath: '',
	includePaths: [] as string[],
	macros: {} as Record<string, string | number | boolean>,
	enableSemanticTokens: true,
	logFile: '' as string,
	debug: false,
	format: {
		enabled: true,
		braceStyle: 'same-line' as 'same-line' | 'next-line',
	} satisfies FormatSettings,
	diag: {
		unknownIdentifier: true,
		unusedVariable: true,
		wrongArity: true,
		unknownConstant: true
	}
};

// -------------------------------------------------
// Lightweight per-document pipeline cache + indexes
// -------------------------------------------------
type PipelineCache = {
	version: number;
	pre: PreprocResult;
	tokens: ReturnType<typeof lex>;
	analysis: Analysis;
	// AST script used by the analysis pipeline
	ast?: import('./ast').Script;
	sem?: SemanticTokens & { resultId?: string };
	// Track macros-only includes to avoid unnecessary reindex work
	macrosOnlyIncludes?: string[];
	// Hash of macros+includePaths to guard cache reuse
	configHash: number;
};
const pipelineCache = new Map<string, PipelineCache>(); // key: doc.uri
// Reverse include index: include file URI -> set of doc URIs that include it
const includeToDocs = new Map<string, Set<string>>();

// ------------------------
// Include symbols indexing
// ------------------------
type IncludeFunction = { name: string; returns: string; params: { type: string; name?: string }[]; line: number; col: number; endCol: number; doc?: string };
type IncludeGlobal = { name: string; type: string; line: number; col: number; endCol: number; doc?: string };
type IncludeMacro = { name: string; line: number; col: number; endCol: number };
type IncludeInfo = {
	file: string;
	functions: Map<string, IncludeFunction>;
	globals: Map<string, IncludeGlobal>;
	macroObjs: Map<string, IncludeMacro>;
	macroFuncs: Map<string, IncludeMacro>;
	states: Set<string>;
};

type IncludeCacheEntry = { mtimeMs: number; info: IncludeInfo };
const includeSymbolsCache = new Map<string, IncludeCacheEntry>();

function cleanBlockDoc(raw: string): string {
	const lines = raw.split(/\r?\n/);
	const body = lines.map(l => l.replace(/^\s*\*\s?/, '').trimEnd());
	// drop leading/trailing empty lines
	while (body.length && body[0].trim() === '') body.shift();
	while (body.length && body[body.length - 1].trim() === '') body.pop();
	return body.join('\n');
}

function parseIncludeSymbols(file: string): IncludeInfo | null {
	try {
		const fs = require('node:fs') as typeof import('node:fs');
		const stat = fs.statSync(file);
		const mtimeMs = Number(stat?.mtimeMs ?? 0) || 0;
		const cached = includeSymbolsCache.get(file);
		if (cached && cached.mtimeMs === mtimeMs) return cached.info;
		const text = fs.readFileSync(file, 'utf8');
		const lines = text.split(/\r?\n/);
		const info: IncludeInfo = {
			file,
			functions: new Map(),
			globals: new Map(),
			macroObjs: new Map(),
			macroFuncs: new Map(),
			states: new Set(),
		};
		let pendingDoc: string | null = null;
		let braceDepth = 0;
		for (let i = 0; i < lines.length; i++) {
			const rawLine = lines[i]!;
			const L = rawLine;
			// Detect single-line block comment used as doc: /* ... */
			const mSingle = /^\s*\/\*([\s\S]*?)\*\/\s*$/.exec(L);
			if (mSingle) {
				pendingDoc = cleanBlockDoc(mSingle[1] || '');
				// consumed as pending doc; continue
				continue;
			}
			// Detect start of multiline block doc /** ... */ accumulating until end
			if (/^\s*\/\*/.test(L) && !/\*\//.test(L)) {
				let body = L.replace(/^\s*\/\*/, '');
				let j = i + 1;
				for (; j < lines.length; j++) {
					const ln = lines[j]!;
					body += '\n' + ln;
					if (/\*\//.test(ln)) { j++; break; }
				}
				i = j - 1;
				// Trim closing */
				body = body.replace(/\*\/\s*$/, '');
				pendingDoc = cleanBlockDoc(body);
				// consumed as pending doc; continue
				continue;
			}
			// Strip line comments for matching, but keep for macro line position
			const noLineComments = L.replace(/\/\/.*$/, '');
			// Macros (object-like)
			let m = /^\s*#\s*define\s+([A-Za-z_]\w*)(?!\s*\()/.exec(L);
			if (m) {
				const name = m[1]!;
				const col = L.indexOf(name);
				info.macroObjs.set(name, { name, line: i, col: col >= 0 ? col : 0, endCol: (col >= 0 ? col + name.length : 0) });
				pendingDoc = null; continue;
			}
			// Macros (function-like)
			m = /^\s*#\s*define\s+([A-Za-z_]\w*)\s*\(.*\)/.exec(L);
			if (m) {
				const name = m[1]!;
				const col = L.indexOf(name);
				info.macroFuncs.set(name, { name, line: i, col: col >= 0 ? col : 0, endCol: (col >= 0 ? col + name.length : 0) });
				pendingDoc = null; continue;
			}
			if (braceDepth === 0) {
				// States
				const st = /^\s*state\s+([A-Za-z_]\w*)\b/.exec(noLineComments);
				if (st) { info.states.add(st[1]!); }
				// Globals: [const] type name [= expr] ;
				const gg = /^\s*(?:const\s+)?([A-Za-z_]\w+)\s+([A-Za-z_]\w+)\s*(?:=|;)\s*/.exec(noLineComments);
				if (gg) {
					const type = gg[1]!; const name = gg[2]!;
					const col = L.indexOf(name);
					const g: IncludeGlobal = { name, type, line: i, col: col >= 0 ? col : 0, endCol: (col >= 0 ? col + name.length : 0) };
					if (pendingDoc && pendingDoc.trim()) g.doc = pendingDoc;
					info.globals.set(name, g); pendingDoc = null; continue;
				}
				// Function headers: returnType name(params) followed by ; or { or EOL
				const ff = /^\s*([A-Za-z_]\w*)\s+([A-Za-z_]\w*)\s*\(([^)]*)\)\s*(?:[;{]|$)/.exec(noLineComments);
				if (ff) {
					const returns = ff[1]!; const name = ff[2]!; const rawParams = (ff[3] || '').trim();
					const params: { type: string; name?: string }[] = [];
					if (rawParams.length > 0) {
						for (const piece of rawParams.split(',')) {
							const p = piece.trim().replace(/\s+/g, ' ');
							const parts = p.split(' ');
							const ty = parts[0] || 'any';
							const pn = parts[1];
							params.push(pn ? { type: ty, name: pn } : { type: ty });
						}
					}
					const col = L.indexOf(name);
					const f: IncludeFunction = { name, returns, params, line: i, col: col >= 0 ? col : 0, endCol: (col >= 0 ? col + name.length : 0) };
					if (pendingDoc && pendingDoc.trim()) f.doc = pendingDoc;
					  info.functions.set(name, f); pendingDoc = null; continue;
				}
			}
			// update brace depth for entire raw line
			for (let k = 0; k < noLineComments.length; k++) {
				const ch = noLineComments[k]!; if (ch === '{') braceDepth++; else if (ch === '}') braceDepth = Math.max(0, braceDepth - 1);
			}
			// advance to next line
		}
		includeSymbolsCache.set(file, { mtimeMs, info });
		return info;
	} catch {
		return null;
	}
}

function indexIncludes(docUri: string, pre: PreprocResult) {
	// Remove previous entries for this doc
	for (const set of includeToDocs.values()) set.delete(docUri);
	for (const inc of pre.includes) {
		const incUri = URI.file(inc).toString();
		let set = includeToDocs.get(incUri);
		if (!set) { set = new Set(); includeToDocs.set(incUri, set); }
		set.add(docUri);
	}
}

function indexIncludesList(docUri: string, includes: string[]) {
	// Remove previous entries for this doc
	for (const set of includeToDocs.values()) set.delete(docUri);
	for (const inc of includes) {
		const incUri = URI.file(inc).toString();
		let set = includeToDocs.get(incUri);
		if (!set) { set = new Set(); includeToDocs.set(incUri, set); }
		set.add(docUri);
	}
}

function arraysShallowEqual(a: string[] | undefined, b: string[] | undefined): boolean {
	if (a === b) return true;
	if (!a || !b) return false;
	if (a.length !== b.length) return false;
	for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
	return true;
}

function getDocVersion(doc: TextDocument): number {
	return (doc as any).version ?? 0;
}

// Stable stringify for objects by sorting keys; handles primitives and arrays
function stableStringify(value: any): string {
	if (value === null || typeof value !== 'object') return JSON.stringify(value);
	if (Array.isArray(value)) return '[' + value.map(v => stableStringify(v)).join(',') + ']';
	const keys = Object.keys(value).sort();
	return '{' + keys.map(k => JSON.stringify(k) + ':' + stableStringify(value[k])).join(',') + '}';
}
// Simple djb2 hash for short strings
function djb2Hash(str: string): number {
	let h = 5381 >>> 0;
	for (let i = 0; i < str.length; i++) h = (((h << 5) + h) ^ str.charCodeAt(i)) >>> 0;
	return h >>> 0;
}
function computeConfigHash(macros: Record<string, any>, includePaths: string[]): number {
	const s = stableStringify({ macros, includePaths });
	return djb2Hash(s);
}

function getPipeline(doc: TextDocument): PipelineCache | null {
	if (!defs) return null;
	const key = doc.uri;
	const currentVersion = getDocVersion(doc);
	const hit = pipelineCache.get(key);
	const currentHash = computeConfigHash(settings.macros, settings.includePaths);
	if (hit && hit.version === currentVersion && hit.configHash === currentHash) return hit;

	// Run macros-only prepass to cheaply compute includes and avoid unnecessary reindex work
	let macrosOnlyIncludes: string[] = [];
	try {
		const fromPath = URI.parse(doc.uri).fsPath;
		const mr = preprocessMacros(doc.getText(), { includePaths: settings.includePaths, fromPath, defines: settings.macros });
		macrosOnlyIncludes = mr.includes || [];
		if (!arraysShallowEqual(hit?.macrosOnlyIncludes, macrosOnlyIncludes)) {
			indexIncludesList(key, macrosOnlyIncludes);
		}
	} catch {
		// ignore macros-only failures; fall back to legacy indexing later
	}

	// Use new tokenizer+macro pipeline for disabled ranges/macros/includes; keep legacy PreprocResult shape for analyzeAst compatibility
	const full = preprocessForAst(doc.getText(), { includePaths: settings.includePaths, fromPath: URI.parse(doc.uri).fsPath, defines: settings.macros });
	const pre: PreprocResult = {
		disabledRanges: full.disabledRanges,
		macros: full.macros,
		funcMacros: full.funcMacros,
		includes: full.includes,
		includeSymbols: new Map(),
		includeTargets: full.includeTargets,
		missingIncludes: full.missingIncludes,
		preprocDiagnostics: full.preprocDiagnostics,
		diagDirectives: full.diagDirectives,
		conditionalGroups: full.conditionalGroups,
	};
	// Populate includeSymbols by parsing resolved include files (best-effort)
	try {
		if (full.includeTargets && full.includeTargets.length > 0) {
			for (const it of full.includeTargets) {
				if (!it.resolved) continue;
				const info = parseIncludeSymbols(it.resolved);
				if (info) pre.includeSymbols!.set(it.resolved, info);
			}
		} else if (full.includes && full.includes.length > 0) {
			for (const file of full.includes) {
				const info = parseIncludeSymbols(file);
				if (info) pre.includeSymbols!.set(file, info);
			}
		}
	} catch { /* ignore include symbol extraction errors */ }
	const tokens = lex(doc, pre.disabledRanges);
	const ast: import('./ast').Script = parseScriptFromText(doc.getText(), doc.uri, { macros: settings.macros, includePaths: settings.includePaths });
	const analysis: Analysis = analyzeAst(doc, ast, defs, pre);
	const entry: PipelineCache = { version: currentVersion, pre, tokens, analysis, ast, macrosOnlyIncludes, configHash: currentHash };
	pipelineCache.set(key, entry);
	// Only fall back to legacy include indexing if macros-only prepass failed to provide includes
	if (!macrosOnlyIncludes || macrosOnlyIncludes.length === 0) indexIncludes(key, pre);
	return entry;
}

connection.onInitialize(async (params: InitializeParams): Promise<InitializeResult> => {
	// Read initializationOptions
	const initOpts = (params.initializationOptions || {}) as any;
	settings.definitionsPath = initOpts.definitionsPath || '';
	settings.includePaths = initOpts.includePaths || [];
	settings.macros = initOpts.macros || {};
	settings.logFile = initOpts.logFile || '';
	settings.debug = !!initOpts.debug;

	// Merge workspace folder(s) into includePaths by default
	try {
		const wfs = params.workspaceFolders || [];
		workspaceRootPaths = [];
		for (const wf of wfs) {
			const u = URI.parse(wf.uri);
			if (u.scheme === 'file') {
				const p = u.fsPath;
				if (p && !workspaceRootPaths.includes(p)) workspaceRootPaths.push(p);
			}
		}
		// Fallback to rootUri/rootPath when workspaceFolders is empty
		if (workspaceRootPaths.length === 0) {
			if (params.rootUri) {
				const u = URI.parse(params.rootUri);
				if (u.scheme === 'file') {
					const p = u.fsPath;
					if (p) workspaceRootPaths.push(p);
				}
			} else if ((params as any).rootPath) {
				const p = (params as any).rootPath as string;
				if (p) workspaceRootPaths.push(p);
			}
		}
		if (workspaceRootPaths.length > 0) {
			const merged = [...settings.includePaths, ...workspaceRootPaths];
			// de-duplicate while preserving order
			const seen = new Set<string>();
			settings.includePaths = merged.filter(p => (p && !seen.has(p) && (seen.add(p), true)));
		}
	} catch { /* ignore workspace folder resolution errors */ }
	if (settings.logFile) {
		try {
			require('node:fs').appendFileSync(settings.logFile, `initialized ${new Date().toISOString()}\n`);
		} catch {
			// ignore file logging errors in init
		}
	}

	try {
		const p = settings.definitionsPath && settings.definitionsPath.trim().length > 0
			? settings.definitionsPath
			: '';
		defs = await loadDefs(p || 'lsl-defs.json');
	} catch (e) {
		// loadDefs already falls back to bundled defs; ensure defs is set or rethrow
		if (!defs) throw e;
	}

	const result: InitializeResult = {
		capabilities: {
			textDocumentSync: TextDocumentSyncKind.Incremental,
			completionProvider: { resolveProvider: true, triggerCharacters: ['.', ',', '(', '"', '/'] },
			hoverProvider: true,
			signatureHelpProvider: { triggerCharacters: ['(', ','], retriggerCharacters: [',', ')'] },
			definitionProvider: true,
			referencesProvider: true,
			documentSymbolProvider: true,
			renameProvider: { prepareProvider: true },
			semanticTokensProvider: {
				legend: semanticTokensLegend,
				range: false,
				full: { delta: true }
			},
			documentLinkProvider: { resolveProvider: false },
			documentFormattingProvider: true,
			documentRangeFormattingProvider: true,
			documentOnTypeFormattingProvider: { firstTriggerCharacter: ';', moreTriggerCharacter: ['}', ',', ')', '\n'] },
			codeActionProvider: { codeActionKinds: [CodeActionKind.QuickFix] }
		}
	};
	return result;
});

connection.onInitialized(() => {
	connection.client.register(DidChangeConfigurationNotification.type, undefined);
});

connection.onDidChangeConfiguration(async change => {
	// Allow live reconfig
	const newSettings: any = change.settings?.lsl || {};
	if (newSettings.definitionsPath && newSettings.definitionsPath !== settings.definitionsPath) {
		settings.definitionsPath = newSettings.definitionsPath;
		defs = await loadDefs(settings.definitionsPath);
	}
	settings.includePaths = newSettings.includePaths ?? settings.includePaths;
	// Always ensure workspace roots remain part of include paths
	if (workspaceRootPaths.length > 0) {
		const merged = [...settings.includePaths, ...workspaceRootPaths];
		const seen = new Set<string>();
		settings.includePaths = merged.filter(p => (p && !seen.has(p) && (seen.add(p), true)));
	}
	settings.macros = newSettings.macros ?? settings.macros;
	settings.enableSemanticTokens = newSettings.enableSemanticTokens ?? settings.enableSemanticTokens;
	if (newSettings.format) {
		settings.format.enabled = newSettings.format.enabled ?? settings.format.enabled;
		settings.format.braceStyle = newSettings.format.braceStyle ?? settings.format.braceStyle;
	}
	if (typeof newSettings.debugLogging === 'boolean') settings.debug = newSettings.debugLogging;
});

documents.onDidChangeContent(async change => {
	// Invalidate cache entry for this document version and revalidate
	pipelineCache.delete(change.document.uri);
	await validateTextDocument(change.document);
});

documents.onDidClose(e => {
	pipelineCache.delete(e.document.uri);
});

async function validateTextDocument(doc: TextDocument) {
	if (!defs) return;

	const entry = getPipeline(doc);
	if (!entry) return;
	const { pre, analysis } = entry;

	const diags: Diagnostic[] = [];

	// Missing includes are not tracked in the new pipeline; include targets are still linkable when resolved.

	// Preprocessor diagnostics (malformed/stray/unmatched directives)
	for (const pd of pre.preprocDiagnostics || []) {
		diags.push({
			range: { start: doc.positionAt(pd.start), end: doc.positionAt(pd.end) },
			severity: DiagnosticSeverity.Warning,
			message: pd.message,
			source: 'lsl-lsp',
			code: pd.code || 'LSL-preproc'
		});
	}

	for (const d of analysis.diagnostics) {
		if (!settings.diag.unknownIdentifier && d.code === LSL_DIAGCODES.UNKNOWN_IDENTIFIER) continue;
		if (!settings.diag.unusedVariable && (d.code === LSL_DIAGCODES.UNUSED_VAR || d.code === LSL_DIAGCODES.UNUSED_LOCAL || d.code === LSL_DIAGCODES.UNUSED_PARAM)) continue;
		if (!settings.diag.wrongArity && d.code === LSL_DIAGCODES.WRONG_ARITY) continue;
		if (!settings.diag.unknownConstant && d.code === LSL_DIAGCODES.UNKNOWN_CONST) continue;

		diags.push({
			range: d.range,
			severity: d.severity ?? DiagnosticSeverity.Warning,
			message: d.message,
			source: 'lsl-lsp',
			code: d.code
		});
	}
	try {
		connection.sendDiagnostics({ uri: doc.uri, diagnostics: diags });
	} catch (e) {
		if (settings.logFile) {
			try { require('node:fs').appendFileSync(settings.logFile, `sendDiagnostics error: ${String(e)}\n`); } catch (err) { if (settings.debug) console.warn('[lsl-lsp] failed to append sendDiagnostics log', err); }
		}
		if (settings.debug) {
			console.warn('[lsl-lsp] sendDiagnostics error', e);
		}
		// swallow
	}

	// After diagnostics, send disabled ranges for editor decoration
	try {
		const ranges = (pre.disabledRanges || []).map(r => ({
			start: { line: doc.positionAt(r.start).line, character: doc.positionAt(r.start).character },
			end: { line: doc.positionAt(r.end).line, character: doc.positionAt(r.end).character }
		}));
		connection.sendNotification('lsl/disabledRanges', { uri: doc.uri, ranges });
	} catch {
		// non-fatal
	}
}

connection.onCompletion((params: CompletionParams, token): CompletionItem[] => {
	if (token?.isCancellationRequested) return [];
	const doc = documents.get(params.textDocument.uri); if (!doc || !defs) return [];
	const entry = getPipeline(doc); if (!entry) return [];
	return lslCompletions(doc, params, defs, entry.analysis, entry.pre, { includePaths: settings.includePaths });
});
connection.onCompletionResolve(resolveCompletion);

connection.onHover((params: HoverParams, token): Hover | null => {
	if (token?.isCancellationRequested) return null;
	const doc = documents.get(params.textDocument.uri); if (!doc || !defs) return null;
	const entry = getPipeline(doc); if (!entry) return null;
	return lslHover(doc, params, defs, entry.analysis, entry.pre);
});

connection.onSignatureHelp((params: SignatureHelpParams, token): SignatureHelp | null => {
	if (token?.isCancellationRequested) return null;
	const doc = documents.get(params.textDocument.uri); if (!doc || !defs) return null;
	const entry = getPipeline(doc); if (!entry) return null;
	return lslSignatureHelp(doc, params, defs, entry.analysis);
});

connection.languages.semanticTokens.on((params: SemanticTokensParams, token): SemanticTokens => {
	const doc = documents.get(params.textDocument.uri); if (!doc || !defs || !settings.enableSemanticTokens) return { data: [] };
	if (token?.isCancellationRequested) return { data: [] };
	const entry = getPipeline(doc); if (!entry) return { data: [] };
	const current = buildSemanticTokens(doc, entry.tokens, defs, entry.pre, entry.analysis);
	// Attach a simple resultId for delta support
	const resultId = String(getDocVersion(doc)) + ':' + Date.now();
	(current as any).resultId = resultId;
	entry.sem = current as any;
	return current;
});

connection.languages.semanticTokens.onDelta((params, token) => {
	const doc = documents.get(params.textDocument.uri); if (!doc || !defs || !settings.enableSemanticTokens) return { edits: [] };
	if (token?.isCancellationRequested) return { edits: [] };
	const entry = getPipeline(doc); if (!entry) return { edits: [] };
	const prev = entry.sem;
	const current = buildSemanticTokens(doc, entry.tokens, defs, entry.pre, entry.analysis) as SemanticTokens & { resultId?: string };
	const resultId = String(getDocVersion(doc)) + ':' + Date.now();
	current.resultId = resultId;
	// simplest replace-all edit
	const deleteCount = prev?.data?.length || 0;
	entry.sem = current;
	return { resultId, edits: [{ start: 0, deleteCount, data: current.data }] };
});

connection.onDocumentSymbol((params: DocumentSymbolParams, token) => {
	if (token?.isCancellationRequested) return [];
	const doc = documents.get(params.textDocument.uri); if (!doc || !defs) return [];
	const entry = getPipeline(doc); if (!entry) return [];
	return documentSymbols(entry.analysis);
});

connection.onDefinition((params, token): Definition | LocationLink[] | null => {
	if (token?.isCancellationRequested) return null;
	const doc = documents.get(params.textDocument.uri);
	if (!doc || !defs) return null;

	const entry = getPipeline(doc); if (!entry) return null;
	const defLoc = gotoDefinition(doc, params.position, entry.analysis, entry.pre, defs!);
	return (defLoc as Definition | null);
});

// Provide clickable links for include paths
connection.onDocumentLinks((params: DocumentLinkParams, token): DocumentLink[] => {
	const doc = documents.get(params.textDocument.uri);
	if (!doc || !defs) return [];
	if (token?.isCancellationRequested) return [];
	const entry = getPipeline(doc); if (!entry) return [];
	const pre = entry.pre;
	const links: DocumentLink[] = [];
	for (const it of pre.includeTargets || []) {
		if (it.resolved) {
			links.push({
				range: { start: doc.positionAt(it.start), end: doc.positionAt(it.end) },
				target: URI.file(it.resolved).toString()
			});
		}
	}
	return links;
});

// Formatting provider
connection.onDocumentFormatting((params: DocumentFormattingParams, token): TextEdit[] => {
	const doc = documents.get(params.textDocument.uri);
	if (!doc || !settings.format.enabled) return [];
	if (token?.isCancellationRequested) return [];
	const entry = getPipeline(doc); if (!entry) return [];
	return formatDocumentEdits(doc, entry.pre, settings.format);
});

// Range formatting provider
connection.onDocumentRangeFormatting((params: DocumentRangeFormattingParams, token): TextEdit[] => {
	const doc = documents.get(params.textDocument.uri);
	if (!doc || !settings.format.enabled) return [];
	if (token?.isCancellationRequested) return [];
	const entry = getPipeline(doc); if (!entry) return [];
	return formatRangeEdits(doc, entry.pre, settings.format, params.range);
});

// On-type formatting provider: format the current line on triggers and indent on newline
connection.onDocumentOnTypeFormatting((params: DocumentOnTypeFormattingParams, token): TextEdit[] => {
	const doc = documents.get(params.textDocument.uri);
	if (!doc || !settings.format.enabled) return [];
	if (token?.isCancellationRequested) return [];
	const entry = getPipeline(doc); if (!entry) return [];
	const pos = params.position;
	const ch = params.ch;
	// Special-case newline: just compute indentation for the next line based on braces
	if (ch === '\n') {
		const { unit } = detectIndent(doc.getText());
		const offset = doc.offsetAt(pos);
		const text = doc.getText();
		// Look back to determine current brace depth on previous line
		let i = offset - 1;
		let depth = 0;
		while (i >= 0 && text[i] !== '\n') {
			const c = text[i];
			if (c === '}') depth++; else if (c === '{') depth = Math.max(0, depth - 1);
			i--;
		}
		// If previous non-ws before the newline is '{', increase indent for the new line
		let j = offset - 1;
		while (j >= 0 && (text[j] === ' ' || text[j] === '\t' || text[j] === '\r' || text[j] === '\n')) j--;
		if (j >= 0 && text[j] === '{') depth++;
		// Insert indentation at the caret position (which is start of the new line)
		const indentText = depth > 0 ? unit.repeat(depth) : '';
		return indentText ? [{ range: { start: pos, end: pos }, newText: indentText }] : [];
	}
	// Otherwise, format just the current line
	const line = pos.line;
	const startOfLine = { line, character: 0 };
	const endOfLine = { line, character: Number.MAX_SAFE_INTEGER };
	const range: Range = { start: startOfLine, end: endOfLine };
	return formatRangeEdits(doc, entry.pre, settings.format, range);
});

// -----------------
// Rename providers
// -----------------
connection.onPrepareRename((params, token) => {
	if (token?.isCancellationRequested) return null;
	const doc = documents.get(params.textDocument.uri); if (!doc || !defs) return null;
	const entry = getPipeline(doc); if (!entry) return null;
	const offset = doc.offsetAt(params.position);
	return navPrepareRename(doc, offset, entry.analysis, entry.pre, defs);
});

connection.onRenameRequest((params, token) => {
	if (token?.isCancellationRequested) return { changes: {} } as any;
	const doc = documents.get(params.textDocument.uri); if (!doc || !defs) return { changes: {} } as any;
	const entry = getPipeline(doc); if (!entry) return { changes: {} } as any;
	const newName = params.newName || '';
	const offset = doc.offsetAt(params.position);
	return computeRenameEdits(doc, offset, newName, entry.analysis, entry.pre, defs, entry.tokens as any);
});

documents.listen(connection);
connection.listen();

// -----------------
// Lifecycle hooks
// -----------------
connection.onShutdown(async () => {
	try {
		// Log shutdown for easier restart diagnostics
		try {
			connection.console.log('[lsl-lsp] onShutdown: clearing caches');
			if (settings.logFile) {
				require('node:fs').appendFileSync(settings.logFile, `onShutdown ${new Date().toISOString()}\n`);
			}
		} catch {
			// ignore log errors
		}
		// Clear caches and detach include index to allow event loop to drain
		pipelineCache.clear();
		includeToDocs.clear();
	} catch {
		// ignore
	}
});

connection.onExit(() => {
	// Ensure process terminates; some environments may keep the event loop alive
	try {
		try {
			connection.console.log('[lsl-lsp] onExit: terminating process');
			if (settings.logFile) {
				require('node:fs').appendFileSync(settings.logFile, `onExit ${new Date().toISOString()}\n`);
			}
		} catch {
			// ignore log errors
		}
		process.exit(0);
	} catch {
		/* ignore */
	}
});

// --------------------
// References provider
// --------------------
connection.onReferences((params, token) => {
	if (token?.isCancellationRequested) return [];
	const doc = documents.get(params.textDocument.uri); if (!doc || !defs) return [];
	const entry = getPipeline(doc); if (!entry) return [];
	const offset = doc.offsetAt(params.position);
	const includeDecl = !!params.context?.includeDeclaration;
	return findAllReferences(doc, offset, includeDecl, entry.analysis, entry.pre, entry.tokens as any);
});

// Quick fix for suspicious assignment -> equality
connection.onCodeAction((params): CodeAction[] => {
	const doc = documents.get(params.textDocument.uri);
	if (!doc) return [];
	const actions: CodeAction[] = [];
	for (const d of params.context.diagnostics || []) {
		if (d.code === LSL_DIAGCODES.SUSPICIOUS_ASSIGNMENT) {
			const edit = TextEdit.replace(d.range as Range, '==');
			actions.push({
				title: 'Change "=" to "=="',
				kind: CodeActionKind.QuickFix,
				diagnostics: [d],
				edit: { changes: { [doc.uri]: [edit] } }
			});
		}
		if (d.code === LSL_DIAGCODES.REDUNDANT_CAST) {
			// Try to remove a leading (type) segment from the text within diagnostic range.
			const text = doc.getText(d.range as Range);
			// Capture any identifier as a potential type and validate via isType to avoid hardcoding lists.
			const m = /^\(\s*([A-Za-z_][A-Za-z0-9_]*)\s*\)\s*([\s\S]*)$/.exec(text);
			if (m && isType(m[1])) {
				const replacement = m[2] ?? '';
				const edit = TextEdit.replace(d.range as Range, replacement);
				actions.push({
					title: 'Remove redundant cast',
					kind: CodeActionKind.QuickFix,
					diagnostics: [d],
					edit: { changes: { [doc.uri]: [edit] } },
				});
			}
		}
	}
	return actions;
});

// Revalidate when includes change on disk (watched by client)
connection.onDidChangeWatchedFiles(ev => {
	for (const c of ev.changes) {
		// Only consider content changes or created/deleted
		if (c.type === FileChangeType.Changed || c.type === FileChangeType.Created || c.type === FileChangeType.Deleted) {
			const uri = c.uri;
			const dependents = includeToDocs.get(uri);
			if (!dependents) continue;
			for (const docUri of dependents) {
				const doc = documents.get(docUri);
				if (doc) {
					pipelineCache.delete(docUri);
					validateTextDocument(doc);
				}
			}
		}
	}
});
