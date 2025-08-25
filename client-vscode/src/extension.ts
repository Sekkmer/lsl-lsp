import * as path from 'node:path';
import * as fs from 'node:fs';
import * as vscode from 'vscode';
import { LanguageClient, LanguageClientOptions, ServerOptions, TransportKind, State, Trace } from 'vscode-languageclient/node';

let client: LanguageClient;

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
	await client.start();
	// Set trace level from config
	switch (traceLevel) {
		case 'off': client.setTrace(Trace.Off); break;
		case 'messages': client.setTrace(Trace.Messages); break;
		case 'verbose': client.setTrace(Trace.Verbose); break;
	}
	status.text = 'LSL: running';
	context.subscriptions.push({ dispose: () => client.stop() });
}

export function deactivate(): Thenable<void> | undefined {
	return client ? client.stop() : undefined;
}
