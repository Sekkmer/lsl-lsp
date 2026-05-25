import * as path from 'node:path';
import * as fs from 'node:fs';
import * as vscode from 'vscode';
import { LanguageClient, LanguageClientOptions, ServerOptions, TransportKind, State, Trace } from 'vscode-languageclient/node';

let client: LanguageClient;

type RenderMode = 'preprocess' | 'optimize';
type RenderScriptResult = {
	ok: boolean;
	mode?: RenderMode;
	title?: string;
	content?: string;
	changed?: boolean;
	stable?: boolean;
	passes?: number;
	error?: string;
};

const generatedDocuments = new Map<string, string>();

class GeneratedDocumentProvider implements vscode.TextDocumentContentProvider {
	private readonly emitter = new vscode.EventEmitter<vscode.Uri>();
	readonly onDidChange = this.emitter.event;

	set(uri: vscode.Uri, content: string): void {
		generatedDocuments.set(uri.toString(), content);
		this.emitter.fire(uri);
	}

	provideTextDocumentContent(uri: vscode.Uri): string {
		return generatedDocuments.get(uri.toString()) ?? '';
	}

	dispose(): void {
		this.emitter.dispose();
	}
}

// Decoration for disabled ranges (dim text)
let disabledDecoration: vscode.TextEditorDecorationType | null = null;
// Cache disabled ranges per document URI as LSP-like ranges
const disabledRangesByUri = new Map<string, { start: { line: number; character: number }, end: { line: number; character: number } }[]>();

function ensureDecoration(): vscode.TextEditorDecorationType {
	if (!disabledDecoration) {
		disabledDecoration = vscode.window.createTextEditorDecorationType({
			opacity: '0.45',
			// Don't underline/overdraw; just dim text
			rangeBehavior: vscode.DecorationRangeBehavior.OpenOpen,
		});
	}
	return disabledDecoration;
}

function findMergeConflictBlocks(doc: vscode.TextDocument): vscode.Range[] {
	const out: vscode.Range[] = [];
	const lineCount = doc.lineCount;
	let i = 0;
	while (i < lineCount) {
		const text = doc.lineAt(i).text;
		if (/^<{7}/.test(text)) {
			const start = new vscode.Position(i, 0);
			let hasSep = false;
			let endLine = i;
			let j = i + 1;
			for (; j < lineCount; j++) {
				const t = doc.lineAt(j).text;
				if (!hasSep && /^={7}/.test(t)) hasSep = true;
				if (/^>{7}/.test(t)) { endLine = j; j++; break; }
			}
			const end = new vscode.Position(endLine, doc.lineAt(endLine).text.length);
			out.push(new vscode.Range(start, end));
			i = Math.max(i + 1, j);
			continue;
		}
		i++;
	}
	return out;
}

function subtractRanges(doc: vscode.TextDocument, base: vscode.Range[], subtract: vscode.Range[]): vscode.Range[] {
	if (!subtract.length) return base;
	const result: vscode.Range[] = [];
	for (const a of base) {
		let segments: vscode.Range[] = [a];
		for (const b of subtract) {
			const newSegs: vscode.Range[] = [];
			for (const s of segments) {
				if (s.end.isBeforeOrEqual(b.start) || s.start.isAfterOrEqual(b.end)) {
					newSegs.push(s);
					continue;
				}
				const aStart = doc.offsetAt(s.start);
				const aEnd = doc.offsetAt(s.end);
				const bStart = doc.offsetAt(b.start);
				const bEnd = doc.offsetAt(b.end);
				// Left part if any
				if (aStart < bStart) {
					newSegs.push(new vscode.Range(doc.positionAt(aStart), doc.positionAt(Math.max(aStart, Math.min(aEnd, bStart)))));
				}
				// Right part if any
				if (bEnd < aEnd) {
					newSegs.push(new vscode.Range(doc.positionAt(Math.min(aEnd, Math.max(aStart, bEnd))), doc.positionAt(aEnd)));
				}
			}
			segments = newSegs;
		}
		for (const s of segments) if (!s.isEmpty) result.push(s);
	}
	return result;
}

function applyDisabledDecorationsForEditor(editor: vscode.TextEditor) {
	const uri = editor.document.uri.toString();
	const data = disabledRangesByUri.get(uri);
	const deco = ensureDecoration();
	if (!data || data.length === 0) {
		editor.setDecorations(deco, []);
		return;
	}
	const doc = editor.document;
	const conflicts = findMergeConflictBlocks(doc);
	const ranges = data.map(r => new vscode.Range(new vscode.Position(r.start.line, r.start.character), new vscode.Position(r.end.line, r.end.character)));
	const filtered = subtractRanges(doc, ranges, conflicts);
	editor.setDecorations(deco, filtered);
}

export async function activate(context: vscode.ExtensionContext) {
	// In dev, prefer a fixed repo server path relative to the extension folder,
	// so it works even when VS Code opens a different workspace.
	const extDir = context.extensionUri.fsPath; // .../packages/client-vscode
	const packagesDir = path.resolve(extDir, '..');
	const repoRootFromExtension = path.resolve(extDir, '..', '..');
	const fixedRepoServer = path.join(packagesDir, 'server', 'out', 'index.js');
	const wsRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
	// Workspace-derived fallbacks (useful if running the extension from a packaged .vsix)
	const workspacePackagesServer = wsRoot ? path.join(wsRoot, 'packages', 'server', 'out', 'index.js') : '';
	const workspaceServer = wsRoot ? path.join(wsRoot, 'server', 'out', 'index.js') : '';
	const siblingRepoServer = wsRoot ? path.join(path.resolve(wsRoot, '..'), 'server', 'out', 'index.js') : '';
	const candidateOrder = [fixedRepoServer,
		// Prefer sibling when the workspace is the extension folder (client-vscode), otherwise prefer primary
		...(wsRoot && path.basename(wsRoot) === 'client-vscode'
			? [siblingRepoServer, workspacePackagesServer, workspaceServer]
			: [workspacePackagesServer, workspaceServer, siblingRepoServer])
	];
	const devPath = candidateOrder.find(p => p && fs.existsSync(p)) || '';

	// Debug/trace configuration
	const cfg = vscode.workspace.getConfiguration('lsl');
	const debugEnabled = !!cfg.get<boolean>('debugLogging');
	const traceLevel = cfg.get<'off' | 'messages' | 'verbose'>('trace', 'off');
	const debugChannel = vscode.window.createOutputChannel('LSL Debug');
	const traceChannel = vscode.window.createOutputChannel('LSL Language Server Trace');

	const log = (...args: unknown[]) => { if (debugEnabled) debugChannel.appendLine(args.map(String).join(' ')); };
	if (devPath) log('[LSL] candidate server path ->', devPath);

	const serverModule = devPath
		? devPath
		: vscode.Uri.joinPath(context.extensionUri, 'server', 'out', 'index.js').fsPath;
	const isUsingWorkspaceServer = devPath && serverModule === devPath;
	if (isUsingWorkspaceServer) {
		log('[LSL] Using workspace server at', serverModule);
	} else {
		// Use bundled server when packaging; it's now self-contained (esbuild-bundled).
		if (!fs.existsSync(serverModule)) {
			vscode.window.showWarningMessage('LSL: Bundled server not found. If developing locally, run the repo task: build server.');
		}
		log('[LSL] Using bundled server at', serverModule);
	}

	const serverOptions: ServerOptions = {
		run: { module: serverModule, transport: TransportKind.ipc },
		debug: { module: serverModule, transport: TransportKind.ipc, options: { execArgv: ['--nolazy', '--inspect=6009'] } }
	};

	function resolveDefinitionsPath(input: unknown): string {
		const firstWs = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
		let p = typeof input === 'string' && input.trim().length > 0 ? input.trim() : '';
		const resolveCandidates = (base: string, ...segments: string[]): string | undefined => {
			const prefix = path.join(base, ...segments);
			const yamlPath = path.join(prefix, 'lsl_definitions.yaml');
			if (requireExists(yamlPath)) return yamlPath;
			return undefined;
		};
		// Expand ${workspaceFolder}
		if (p && firstWs) p = p.replace('${workspaceFolder}', firstWs);
		// Make absolute if needed
		if (p && !path.isAbsolute(p)) p = firstWs ? path.join(firstWs, p) : path.join(context.extensionUri.fsPath, p);
		// If not provided or file missing, try built server definition bundles.
		const packagesRootFromExt = path.resolve(context.extensionUri.fsPath, '..');
		const repoRootFromExt = path.resolve(context.extensionUri.fsPath, '..', '..');
		if (!p || !requireExists(p)) {
			if (firstWs) {
				const wsPackagesServer = resolveCandidates(firstWs, 'packages', 'server', 'out');
				if (wsPackagesServer) return wsPackagesServer;
				const wsServer = resolveCandidates(firstWs, 'server', 'out');
				if (wsServer) return wsServer;
			}
			// When running the extension from its folder (Run Extension), also try the sibling package server output.
			const packageSiblingServer = resolveCandidates(packagesRootFromExt, 'server', 'out');
			if (packageSiblingServer) return packageSiblingServer;
			const repoPackageServer = resolveCandidates(repoRootFromExt, 'packages', 'server', 'out');
			if (repoPackageServer) return repoPackageServer;
			// Keep the old-layout fallback for local checkouts that have not moved yet.
			const repoSiblingServer = resolveCandidates(repoRootFromExt, 'server', 'out');
			if (repoSiblingServer) return repoSiblingServer;
			// Fall back to the extension-bundled server output.
			const extServer = resolveCandidates(context.extensionUri.fsPath, 'server', 'out');
			if (extServer) return extServer;
		}
		return p;
	}

	function resolveIncludePaths(input: unknown): string[] {
		const firstWs = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
		const asArray: string[] = Array.isArray(input)
			? input as string[]
			: (typeof input === 'string' && input.trim().length > 0 ? [input.trim()] : []);
		const out: string[] = [];
		for (let p of asArray) {
			if (!p) continue;
			// Expand ${workspaceFolder}
			if (firstWs) p = p.replace('${workspaceFolder}', firstWs);
			// Make absolute if needed
			if (!path.isAbsolute(p)) p = firstWs ? path.join(firstWs, p) : path.join(context.extensionUri.fsPath, p);
			out.push(p);
		}
		return out;
	}

	function requireExists(file: string): boolean {
		try { require('node:fs').accessSync(file); return true; } catch { return false; }
	}
	const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
	status.text = 'LSL: starting…';
	status.tooltip = 'LSL Language Server';
	status.command = 'lsl.showServerLogs';
	status.show();
	// Compute a stable log file path under the workspace (or temp)
	const rootForLogs = fs.existsSync(fixedRepoServer)
		? repoRootFromExtension
		: (wsRoot
			? (path.basename(wsRoot) === 'client-vscode'
				? path.resolve(wsRoot, '..', '..')
				: path.basename(wsRoot) === 'packages'
					? path.resolve(wsRoot, '..')
					: wsRoot)
			: undefined);
	const logDir = rootForLogs ? path.join(rootForLogs, '.vscode') : require('node:os').tmpdir();
	try { fs.mkdirSync(logDir, { recursive: true }); } catch (e) { log('[LSL] Failed to create log dir', logDir, e); }
	const logFile = path.join(logDir, 'lsl-lsp-server.log');
	try { fs.appendFileSync(logFile, `\n=== LSL LSP launch ${new Date().toISOString()} ===\n`); } catch (e) { log('[LSL] Failed to touch log file', logFile, e); }

	function getServerSettings() {
		const currentCfg = vscode.workspace.getConfiguration('lsl');
		return {
			definitionsPath: resolveDefinitionsPath(currentCfg.get('definitionsPath')),
			includePaths: resolveIncludePaths(currentCfg.get('includePaths')),
			macros: currentCfg.get('macros'),
			dynamicMacros: currentCfg.get('dynamicMacros'),
			optimize: currentCfg.get('optimize'),
			measure: { inlayHints: currentCfg.get('measure.inlayHints') },
			logFile,
			diagnostics: { disable: currentCfg.get('diagnostics.disable') },
			debug: !!currentCfg.get<boolean>('debugLogging')
		};
	}

	const clientOptions: LanguageClientOptions = {
		documentSelector: [{ language: 'lsl' }],
		initializationOptions: getServerSettings(),
		traceOutputChannel: traceChannel,
		synchronize: {
			fileEvents: vscode.workspace.createFileSystemWatcher('**/*.{lsl,lsli,lslp}')
		}
	};

	client = new LanguageClient('lslLsp', 'LSL Language Server', serverOptions, clientOptions);
	const generatedProvider = new GeneratedDocumentProvider();
	const generatedProviderRegistration = vscode.workspace.registerTextDocumentContentProvider('lsl-output', generatedProvider);

	function outputUri(title: string): vscode.Uri {
		const safeTitle = title.replace(/[\\/:*?"<>|#%]/g, '_');
		return vscode.Uri.from({
			scheme: 'lsl-output',
			path: `/${safeTitle}`,
			query: `v=${Date.now()}`,
		});
	}

	async function openRenderedScript(mode: RenderMode): Promise<void> {
		const editor = vscode.window.activeTextEditor;
		if (!editor || editor.document.languageId !== 'lsl') {
			vscode.window.showWarningMessage('LSL: open an LSL document first.');
			return;
		}
		if (client.state !== State.Running) {
			vscode.window.showWarningMessage('LSL: language server is not running.');
			return;
		}
		try {
			const result = await client.sendRequest<RenderScriptResult>('lsl/renderScript', {
				uri: editor.document.uri.toString(),
				mode,
			});
			if (!result.ok || result.content === undefined || !result.title) {
				vscode.window.showErrorMessage(`LSL: ${result.error || 'failed to render script'}`);
				return;
			}
			const uri = outputUri(result.title);
			generatedProvider.set(uri, result.content);
			let doc = await vscode.workspace.openTextDocument(uri);
			if (doc.languageId !== 'lsl') doc = await vscode.languages.setTextDocumentLanguage(doc, 'lsl');
			await vscode.window.showTextDocument(doc, { viewColumn: vscode.ViewColumn.Beside, preview: false });
		} catch (e) {
			vscode.window.showErrorMessage('LSL: failed to render script: ' + (e instanceof Error ? e.message : String(e)));
		}
	}

	// Commands for quick debug
	const showLogsCmd = vscode.commands.registerCommand('lsl.showServerLogs', () => traceChannel.show(true));
	const showClientLogsCmd = vscode.commands.registerCommand('lsl.showClientLogs', () => {
		const ch: vscode.OutputChannel | undefined = (client as unknown as { outputChannel?: vscode.OutputChannel })?.outputChannel;
		ch?.show(true);
	});
	const restartCmd = vscode.commands.registerCommand('lsl.restartServer', async () => {
		if (client) { await client.stop(); await client.start(); }
	});
	const clearCachesCmd = vscode.commands.registerCommand('lsl.clearCaches', async () => {
		if (!client) return;
		try {
			await client.sendRequest('lsl/clearCaches');
			vscode.window.showInformationMessage('LSL: caches cleared');
		} catch (e) {
			vscode.window.showErrorMessage('LSL: failed to clear caches: ' + (e instanceof Error ? e.message : String(e)));
		}
	});
	const buildServerCmd = vscode.commands.registerCommand('lsl.buildServer', async () => {
		await vscode.commands.executeCommand('workbench.action.tasks.runTask', 'build server');
	});
	const openPreprocessedCmd = vscode.commands.registerCommand('lsl.openPreprocessedScript', () => openRenderedScript('preprocess'));
	const openOptimizedCmd = vscode.commands.registerCommand('lsl.openOptimizedScript', () => openRenderedScript('optimize'));
	context.subscriptions.push(showLogsCmd, showClientLogsCmd, restartCmd, clearCachesCmd, buildServerCmd, openPreprocessedCmd, openOptimizedCmd, generatedProviderRegistration, generatedProvider, status, debugChannel, traceChannel);

	client.onDidChangeState(({ newState }) => {
		if (newState === State.Running) {
			status.text = 'LSL: running';
		} else if (newState === State.Stopped) {
			status.text = 'LSL: stopped';
			vscode.window.showErrorMessage('LSL server stopped. View logs or rebuild the server?', 'Open Logs', 'Rebuild', 'Restart')
				.then(async sel => {
					if (sel === 'Open Logs') traceChannel.show(true);
					else if (sel === 'Rebuild') await vscode.commands.executeCommand('workbench.action.tasks.runTask', 'build server');
					else if (sel === 'Restart' && client) { await client.stop(); await client.start(); }
				});
		}
	});

	// Listen for disabled ranges and decorate editors
	client.onNotification('lsl/disabledRanges', async (payload: { uri: string, ranges: { start: { line: number; character: number }, end: { line: number; character: number } }[] }) => {
		try {
			disabledRangesByUri.set(payload.uri, payload.ranges || []);
			// Apply to any visible editor with this URI
			for (const ed of vscode.window.visibleTextEditors) {
				if (ed.document.uri.toString() === payload.uri) applyDisabledDecorationsForEditor(ed);
			}
		} catch {
			/* ignore */
		}
	});

	// Update decorations when visible editors change or document content changes (to re-evaluate conflict blocks)
	context.subscriptions.push(vscode.window.onDidChangeVisibleTextEditors(eds => {
		for (const ed of eds) applyDisabledDecorationsForEditor(ed);
	}));
	context.subscriptions.push(vscode.workspace.onDidChangeTextDocument(ev => {
		for (const ed of vscode.window.visibleTextEditors) {
			if (ed.document === ev.document) applyDisabledDecorationsForEditor(ed);
		}
	}));
	context.subscriptions.push(vscode.workspace.onDidChangeConfiguration(async ev => {
		if (!ev.affectsConfiguration('lsl') || client.state !== State.Running) return;
		await client.sendNotification('workspace/didChangeConfiguration', {
			settings: { lsl: getServerSettings() }
		});
	}));

	await client.start();
	// Set trace level from config
	switch (traceLevel) {
		case 'off': client.setTrace(Trace.Off); break;
		case 'messages': client.setTrace(Trace.Messages); break;
		case 'verbose': client.setTrace(Trace.Verbose); break;
	}
	status.text = 'LSL: running';
	context.subscriptions.push({ dispose: () => {
		client.stop();
		if (disabledDecoration) disabledDecoration.dispose();
	}});
}

export function deactivate(): Thenable<void> | undefined {
	if (disabledDecoration) { disabledDecoration.dispose(); disabledDecoration = null; }
	return client ? client.stop() : undefined;
}
