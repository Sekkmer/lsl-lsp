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
import { preprocess, PreprocResult } from './preproc';
import { lex } from './lexer';
import { Analysis, LSL_DIAGCODES } from './analysisTypes';
import { semanticTokensLegend, buildSemanticTokens } from './semtok';
import { lslCompletions, resolveCompletion, lslSignatureHelp } from './completions';
import { lslHover } from './hover';
import { formatDocumentEdits, type FormatSettings, formatRangeEdits, detectIndent } from './format';
import { documentSymbols, gotoDefinition } from './symbols';
import { DocumentLink, DocumentLinkParams, DocumentFormattingParams, TextEdit, CodeAction, CodeActionKind, Range,
	DocumentRangeFormattingParams, DocumentOnTypeFormattingParams
} from 'vscode-languageserver/node';
import { URI } from 'vscode-uri';
import { prepareRename as navPrepareRename, computeRenameEdits, findAllReferences } from './navigation';
import { parseScriptFromText } from './ast/parser';
import { analyzeAst } from './ast/analyze';
import { isType } from './ast';

const connection: Connection = createConnection(ProposedFeatures.all);
const documents = new TextDocuments(TextDocument);

let defs: Defs | null = null;
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
};
const pipelineCache = new Map<string, PipelineCache>(); // key: doc.uri
// Reverse include index: include file URI -> set of doc URIs that include it
const includeToDocs = new Map<string, Set<string>>();

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

function getDocVersion(doc: TextDocument): number {
	return (doc as any).version ?? 0;
}

function getPipeline(doc: TextDocument): PipelineCache | null {
	if (!defs) return null;
	const key = doc.uri;
	const currentVersion = getDocVersion(doc);
	const hit = pipelineCache.get(key);
	if (hit && hit.version === currentVersion) return hit;

	const pre: PreprocResult = preprocess(doc, settings.macros, settings.includePaths, connection);
	const tokens = lex(doc, pre.disabledRanges);
	const ast: import('./ast').Script = parseScriptFromText(doc.getText(), doc.uri, { macros: settings.macros, includePaths: settings.includePaths });
	const analysis: Analysis = analyzeAst(doc, ast, defs, pre);
	const entry: PipelineCache = { version: currentVersion, pre, tokens, analysis, ast };
	pipelineCache.set(key, entry);
	indexIncludes(key, pre);
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

	// Missing includes from preprocessor
	for (const mi of pre.missingIncludes) {
		diags.push({
			range: { start: doc.positionAt(mi.start), end: doc.positionAt(mi.end) },
			severity: DiagnosticSeverity.Warning,
			message: `#include not found: ${mi.file}`,
			source: 'lsl-lsp',
			code: 'LSL-include'
		});
	}

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
		if (!settings.diag.unusedVariable && d.code === LSL_DIAGCODES.UNUSED_VAR) continue;
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
}

connection.onCompletion((params: CompletionParams, token): CompletionItem[] => {
	if (token?.isCancellationRequested) return [];
	const doc = documents.get(params.textDocument.uri); if (!doc || !defs) return [];
	const entry = getPipeline(doc); if (!entry) return [];
	return lslCompletions(doc, params, defs, entry.tokens, entry.analysis, entry.pre, { includePaths: settings.includePaths });
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
	return lslSignatureHelp(doc, params, defs, entry.tokens);
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
