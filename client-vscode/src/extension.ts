import * as path from 'node:path';
import * as fs from 'node:fs';
import * as vscode from 'vscode';
import { LanguageClient, LanguageClientOptions, ServerOptions, TransportKind, State, Trace } from 'vscode-languageclient/node';

let client: LanguageClient;

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
	const extDir = context.extensionUri.fsPath; // .../client-vscode
	const fixedRepoServer = path.join(path.resolve(extDir, '..'), 'server', 'out', 'index.js');
	const wsRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
	// Workspace-derived fallbacks (useful if running the extension from a packaged .vsix)
	const primaryRepoServer = wsRoot ? path.join(wsRoot, 'server', 'out', 'index.js') : '';
	const siblingRepoServer = wsRoot ? path.join(path.resolve(wsRoot, '..'), 'server', 'out', 'index.js') : '';
	const candidateOrder = [fixedRepoServer,
		// Prefer sibling when the workspace is the extension folder (client-vscode), otherwise prefer primary
		...(wsRoot && path.basename(wsRoot) === 'client-vscode' ? [siblingRepoServer, primaryRepoServer] : [primaryRepoServer, siblingRepoServer])
	];
	const devPath = candidateOrder.find(p => p && fs.existsSync(p)) || '';

	// Debug/trace configuration
	const cfg = vscode.workspace.getConfiguration('lsl');
	const debugEnabled = !!cfg.get<boolean>('debugLogging');
	const traceLevel = cfg.get<'off' | 'messages' | 'verbose'>('trace', 'off');
	const debugChannel = vscode.window.createOutputChannel('LSL Debug');
	const traceChannel = vscode.window.createOutputChannel('LSL Language Server Trace');

	const log = (...args: any[]) => { if (debugEnabled) debugChannel.appendLine(args.map(String).join(' ')); };
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
		// Expand ${workspaceFolder}
		if (p && firstWs) p = p.replace('${workspaceFolder}', firstWs);
		// Make absolute if needed
		if (p && !path.isAbsolute(p)) p = firstWs ? path.join(firstWs, p) : path.join(context.extensionUri.fsPath, p);
		// If not provided or file missing, try workspace common/lsl-defs.json
		if (!p || !requireExists(p)) {
			if (firstWs) {
				const wsCommon = path.join(firstWs, 'common', 'lsl-defs.json');
				if (requireExists(wsCommon)) return wsCommon;
			}
			// When running the extension from its folder (Run Extension), also try the sibling repo common
			const repoRootFromExt = path.resolve(context.extensionUri.fsPath, '..');
			const siblingCommon = path.join(repoRootFromExt, 'common', 'lsl-defs.json');
			if (requireExists(siblingCommon)) return siblingCommon;
			const repoCrawler = path.join(repoRootFromExt, 'crawler', 'out', 'lsl-defs.json');
			if (requireExists(repoCrawler)) return repoCrawler;
			// Fall back to extension-bundled common
			const extCommon = path.join(context.extensionUri.fsPath, 'common', 'lsl-defs.json');
			if (requireExists(extCommon)) return extCommon;
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
		? path.resolve(extDir, '..')
		: (wsRoot ? (path.basename(wsRoot) === 'client-vscode' ? path.resolve(wsRoot, '..') : wsRoot) : undefined);
	const logDir = rootForLogs ? path.join(rootForLogs, '.vscode') : require('node:os').tmpdir();
	try { fs.mkdirSync(logDir, { recursive: true }); } catch (e) { log('[LSL] Failed to create log dir', logDir, e); }
	const logFile = path.join(logDir, 'lsl-lsp-server.log');
	try { fs.appendFileSync(logFile, `\n=== LSL LSP launch ${new Date().toISOString()} ===\n`); } catch (e) { log('[LSL] Failed to touch log file', logFile, e); }

	const clientOptions: LanguageClientOptions = {
		documentSelector: [{ language: 'lsl' }],
		initializationOptions: {
			definitionsPath: resolveDefinitionsPath(cfg.get('definitionsPath')),
			includePaths: resolveIncludePaths(cfg.get('includePaths')),
			macros: cfg.get('macros'),
			logFile,
			debug: debugEnabled
		},
		traceOutputChannel: traceChannel,
		synchronize: {
			configurationSection: 'lsl',
			fileEvents: vscode.workspace.createFileSystemWatcher('**/*.{lsl,lsli,lslp}')
		}
	};

	client = new LanguageClient('lslLsp', 'LSL Language Server', serverOptions, clientOptions);

	// Commands for quick debug
	const showLogsCmd = vscode.commands.registerCommand('lsl.showServerLogs', () => traceChannel.show(true));
	const showClientLogsCmd = vscode.commands.registerCommand('lsl.showClientLogs', () => {
		const ch: vscode.OutputChannel | undefined = (client as unknown as { outputChannel?: vscode.OutputChannel })?.outputChannel;
		ch?.show(true);
	});
	const restartCmd = vscode.commands.registerCommand('lsl.restartServer', async () => {
		if (client) { await client.stop(); await client.start(); }
	});
	const buildServerCmd = vscode.commands.registerCommand('lsl.buildServer', async () => {
		await vscode.commands.executeCommand('workbench.action.tasks.runTask', 'build server');
	});
	context.subscriptions.push(showLogsCmd, showClientLogsCmd, restartCmd, buildServerCmd, status, debugChannel, traceChannel);

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
