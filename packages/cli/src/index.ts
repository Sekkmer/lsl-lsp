#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import bundledDefinitionsYaml from '../../../third_party/lsl-definitions/lsl_definitions.yaml';
import {
	type Defs,
	type Diag,
	type DocumentSymbol,
	type FormatSettings,
	type Hover,
	type Location,
	type MarkedString,
	type MarkupContent,
	type Position,
	type PreprocResult,
	type Range,
	type Script,
	type CoreToken,
	type DefFunction,
	TextDocument,
	analyzeAst,
	diagCodeFriendly,
	documentSymbols,
	fileUriToPath,
	filePathToUri,
	filterDiagnostics,
	formatDocumentEdits,
	gotoDefinition,
	loadDefs,
	loadDefsFromSource,
	lslHover,
	parseDisabledDiagList,
	parseDynamicMacroList,
	parseScriptFromText,
	preprocessForAst,
	optimizeScript,
	shrinkNameOptionsFromDefs,
	type OptimizeOptions,
	type SimpleType,
	type Value,
	type DynamicMacroMap,
} from '@lsl-lsp/core';

declare const CLI_VERSION: string;

type CommandName = 'check' | 'format' | 'optimize' | 'preprocess' | 'symbols' | 'definition' | 'hover' | 'dump-defs';

interface CliOptions {
	command: CommandName;
	files: string[];
	includePaths: string[];
	defaultIncludePath: boolean;
	definitionsPath: string;
	defines: Record<string, string | number | boolean>;
	dynamicMacros: DynamicMacroMap;
	disabledDiagnostics: Set<Diag['code']>;
	json: boolean;
	write: boolean;
	checkFormat: boolean;
	braceStyle: FormatSettings['braceStyle'];
}

interface PipelineResult {
	filePath: string;
	text: string;
	doc: TextDocument;
	ast: Script;
	pre: PreprocResult;
	analysis: ReturnType<typeof analyzeAst>;
	diagnostics: CliDiagnostic[];
}

type CliDiagnostic = Omit<Diag, 'code'> & { code: Diag['code'] | 'LSL-preproc' };

const USAGE = `Usage:
  lsl-lsp check [options] <file...>
  lsl-lsp format [options] [--write|--check] <file...>
  lsl-lsp optimize [options] [--write|--check|--json] <file...>
  lsl-lsp preprocess [options] [--json] <file...>
  lsl-lsp symbols [options] <file...>
  lsl-lsp definition [options] <file> <line> <column>
  lsl-lsp hover [options] <file> <line> <column>
  lsl-lsp dump-defs [options] [name...]

Line and column arguments are 1-based.

Options:
  -I, --include-path <path>      Add an include search path. Can be repeated.
      --no-default-include       Do not add the current working directory to include search paths.
  -D, --define <name[=value]>    Add a predefined macro. Can be repeated.
      --dynamic-macro <name:type>
                                  Preserve a dynamic macro as an unknown typed value.
      --definitions <path>       Use a custom definitions JSON/YAML file.
      --disable <code[,code]>    Suppress diagnostics by code or friendly name.
      --json                     Print supported command output as JSON.
      --brace-style <style>      Formatting brace style: same-line or next-line.
      --write                    Write formatted files in-place.
      --check                    Exit non-zero if formatting would change files.
  -h, --help                     Show this help.
  -v, --version                  Print CLI version.`;

async function main(argv: string[]): Promise<number> {
	const opts = parseArgs(argv);
	if (!opts) return 0;
	if (opts.files.length === 0 && opts.command !== 'dump-defs') throw new CliError('No input files provided.');

	if (opts.command === 'preprocess') return runPreprocess(opts);

	const defs = await loadCliDefs(opts.definitionsPath);
	if (opts.command === 'dump-defs') return runDumpDefs(opts, defs);
	if (opts.command === 'format') return runFormat(opts, defs);
	if (opts.command === 'optimize') return runOptimize(opts, defs);
	if (opts.command === 'symbols') return runSymbols(opts, defs);
	if (opts.command === 'definition') return runDefinition(opts, defs);
	if (opts.command === 'hover') return runHover(opts, defs);
	return runCheck(opts, defs);
}

function runDumpDefs(opts: CliOptions, defs: Defs): number {
	const names = new Set(opts.files);
	const hasFilter = names.size > 0;
	const constants = defs.file.constants.filter(item => !hasFilter || names.has(item.name));
	const events = defs.file.events.filter(item => !hasFilter || names.has(item.name));
	const functions = defs.file.functions
		.map(item => filterFunctionForDump(item, names, hasFilter))
		.filter(item => item !== null);
	const payload = {
		version: defs.file.version,
		constants,
		events,
		functions,
	};
	process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
	return hasFilter && constants.length === 0 && events.length === 0 && functions.length === 0 ? 1 : 0;
}

function filterFunctionForDump(item: DefFunction, names: Set<string>, hasFilter: boolean): DefFunction | null {
	if (!hasFilter || names.has(item.name)) return item;
	const overloads = item.overloads?.filter(overload => names.has(overload.name)) ?? [];
	return overloads.length > 0 ? { ...item, overloads } : null;
}

async function runOptimize(opts: CliOptions, defs: Defs): Promise<number> {
	const results = await Promise.all(opts.files.map(file => analyzeFile(file, opts, defs)));
	const optimizeOptions = cliOptimizeOptions(defs, opts);
	const optimized = results.map(result => {
		const out = optimizeScript(result.ast, optimizeOptions);
		return { result, out };
	});

	if (opts.json) {
		process.stdout.write(`${JSON.stringify(optimized.map(({ result, out }) => ({
			uri: result.doc.uri,
			file: result.filePath,
			changed: out.code !== result.text,
			stable: out.stable,
			passes: out.passes,
			optimizedText: out.code,
		})), null, 2)}\n`);
		return optimized.some(item => !item.out.stable) ? 1 : 0;
	}

	if (opts.checkFormat) {
		for (const item of optimized) {
			if (item.out.code !== item.result.text) {
				process.stdout.write(`${item.result.filePath} would be optimized\n`);
			}
		}
		return optimized.some(item => item.out.code !== item.result.text) ? 1 : 0;
	}

	if (opts.write) {
		await Promise.all(optimized.map(async item => {
			if (item.out.code !== item.result.text) await fs.writeFile(item.result.filePath, item.out.code, 'utf8');
		}));
		return optimized.some(item => !item.out.stable) ? 1 : 0;
	}

	if (optimized.length !== 1) throw new CliError('Optimizing multiple files requires --write, --check, or --json.');
	process.stdout.write(optimized[0]!.out.code);
	if (!optimized[0]!.out.code.endsWith('\n')) process.stdout.write('\n');
	return optimized[0]!.out.stable ? 0 : 1;
}

function cliOptimizeOptions(defs: Defs, opts: CliOptions): OptimizeOptions {
	return {
		builtinConstants: builtinConstantValues(defs),
		builtinFunctionReturnTypes: builtinReturnTypes(defs),
		dynamicMacros: opts.dynamicMacros,
		bitwiseBooleanOps: true,
		dropDefaultInitializers: true,
		inlineConstantGlobals: true,
		inlineFunctions: true,
		integerPeepholes: true,
		listAdd: true,
		removeUnusedFunctions: true,
		shrinkNames: true,
		shrinkNameOptions: shrinkNameOptionsFromDefs(defs),
	};
}

function builtinConstantValues(defs: Defs): ReadonlyMap<string, Value> {
	const out = new Map<string, Value>();
	for (const [name, constant] of defs.consts) {
		const value = constant.value;
		switch (constant.type) {
			case 'integer':
				if (typeof value === 'number' || typeof value === 'boolean') {
					out.set(name, { kind: 'value', type: 'integer', value: Number(value) | 0 });
				}
				break;
			case 'float':
				if (typeof value === 'number') {
					out.set(name, { kind: 'value', type: 'float', value });
				}
				break;
			case 'string':
			case 'key':
				if (typeof value === 'string') {
					out.set(name, { kind: 'value', type: constant.type, value });
				}
				break;
			default:
				break;
		}
	}
	return out;
}

function builtinReturnTypes(defs: Defs): ReadonlyMap<string, SimpleType> {
	const out = new Map<string, SimpleType>();
	for (const [name, overloads] of defs.funcs) {
		let returnType: SimpleType | undefined;
		let mixed = false;
		for (const overload of overloads) {
			const next = toSimpleType(overload.returns);
			if (!next) {
				mixed = true;
				break;
			}
			if (returnType && returnType !== next) {
				mixed = true;
				break;
			}
			returnType = next;
		}
		if (!mixed && returnType) out.set(name, returnType);
	}
	return out;
}

function toSimpleType(type: string): SimpleType | null {
	if (type === 'integer' || type === 'float' || type === 'string' || type === 'key' || type === 'vector' || type === 'rotation' || type === 'list' || type === 'void') return type;
	if (type === 'quaternion') return 'rotation';
	return null;
}

async function loadCliDefs(definitionsPath: string): Promise<Defs> {
	if (definitionsPath.trim()) return loadDefs(definitionsPath);
	return loadDefsFromSource(bundledDefinitionsYaml, '<bundled lsl_definitions.yaml>');
}

async function runCheck(opts: CliOptions, defs: Defs): Promise<number> {
	const results = await Promise.all(opts.files.map(file => analyzeFile(file, opts, defs)));
	if (opts.json) {
		const payload = results.map(({ doc, diagnostics }) => ({
			uri: doc.uri,
			file: fileUriLabel(doc.uri),
			diagnostics: diagnostics.map(diagnosticToJson),
		}));
		process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
	} else {
		for (const result of results) {
			for (const diag of result.diagnostics) {
				process.stdout.write(`${formatDiagnostic(fileUriLabel(result.doc.uri), diag)}\n`);
			}
		}
	}
	return results.some(result => result.diagnostics.length > 0) ? 1 : 0;
}

async function runFormat(opts: CliOptions, defs: Defs): Promise<number> {
	const results = await Promise.all(opts.files.map(file => analyzeFile(file, opts, defs)));
	let changed = false;
	const formatted = results.map(result => {
		const next = applyTextEdits(result.doc, formatDocumentEdits(result.doc, result.pre, {
			enabled: true,
			braceStyle: opts.braceStyle,
		}));
		if (next !== result.doc.getText()) changed = true;
		return { result, text: next };
	});

	if (opts.checkFormat) {
		for (const item of formatted) {
			if (item.text !== item.result.doc.getText()) {
				process.stdout.write(`${fileUriLabel(item.result.doc.uri)} would be reformatted\n`);
			}
		}
		return changed ? 1 : 0;
	}

	if (opts.write) {
		await Promise.all(formatted.map(async item => {
			if (item.text !== item.result.doc.getText()) await fs.writeFile(fileUriLabel(item.result.doc.uri), item.text, 'utf8');
		}));
		return 0;
	}

	if (formatted.length !== 1) throw new CliError('Formatting multiple files requires --write or --check.');
	process.stdout.write(formatted[0]!.text);
	return 0;
}

async function runPreprocess(opts: CliOptions): Promise<number> {
	const results = await Promise.all(opts.files.map(file => preprocessFile(file, opts)));
	if (opts.json) {
		process.stdout.write(`${JSON.stringify(results.map(preprocessToJson), null, 2)}\n`);
		return results.some(result => (result.pre.preprocDiagnostics?.length ?? 0) > 0 || (result.pre.missingIncludes?.length ?? 0) > 0) ? 1 : 0;
	}

	if (results.length !== 1) throw new CliError('Preprocessing multiple files requires --json.');
	process.stdout.write(results[0]!.expandedText);
	if (!results[0]!.expandedText.endsWith('\n')) process.stdout.write('\n');
	return (results[0]!.pre.preprocDiagnostics?.length ?? 0) > 0 || (results[0]!.pre.missingIncludes?.length ?? 0) > 0 ? 1 : 0;
}

async function runSymbols(opts: CliOptions, defs: Defs): Promise<number> {
	const results = await Promise.all(opts.files.map(file => analyzeFile(file, opts, defs)));
	const payload = results.map(result => ({
		uri: result.doc.uri,
		file: fileUriLabel(result.doc.uri),
		symbols: documentSymbols(result.analysis).map(symbolToJson),
	}));
	process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
	return 0;
}

async function runDefinition(opts: CliOptions, defs: Defs): Promise<number> {
	const target = parsePositionArgs(opts);
	const result = await analyzeFile(target.file, opts, defs);
	const location = gotoDefinition(result.doc, target.position, result.analysis, result.pre, defs, { filePathToUri });
	process.stdout.write(`${JSON.stringify(locationToJson(location), null, 2)}\n`);
	return location ? 0 : 1;
}

async function runHover(opts: CliOptions, defs: Defs): Promise<number> {
	const target = parsePositionArgs(opts);
	const result = await analyzeFile(target.file, opts, defs);
	const hover = lslHover(result.doc, { position: target.position }, defs, result.analysis, result.pre);
	process.stdout.write(`${JSON.stringify(hoverToJson(hover), null, 2)}\n`);
	return hover ? 0 : 1;
}

async function analyzeFile(file: string, opts: CliOptions, defs: Defs): Promise<PipelineResult> {
	const { filePath, text, doc, full } = await readAndPreprocessFile(file, opts);
	const pre = toPreprocResult(full);
	const ast: Script = parseScriptFromText(text, doc.uri, {
		macros: { ...full.macros, ...opts.defines },
		dynamicMacros: opts.dynamicMacros,
		includePaths: opts.includePaths,
		pre: full,
	});
	const analysis = analyzeAst(doc, ast, defs, pre);
	const diagnostics = collectDiagnostics(doc, pre, analysis.diagnostics, opts);
	return { filePath, text, doc, ast, pre, analysis, diagnostics };
}

interface PreprocessFileResult {
	filePath: string;
	doc: TextDocument;
	pre: PreprocResult;
	expandedText: string;
}

async function preprocessFile(file: string, opts: CliOptions): Promise<PreprocessFileResult> {
	const { filePath, doc, full } = await readAndPreprocessFile(file, opts);
	const pre = toPreprocResult(full);
	return {
		filePath,
		doc,
		pre,
		expandedText: renderExpandedTokens(pre.expandedTokens ?? []),
	};
}

async function readAndPreprocessFile(file: string, opts: CliOptions) {
	const filePath = path.resolve(file);
	const text = await fs.readFile(filePath, 'utf8');
	const doc = TextDocument.create(filePathToUri(filePath), 'lsl', 1, text);
	const full = preprocessForAst(text, {
		includePaths: [...opts.includePaths],
		fromPath: filePath,
		defines: { ...opts.defines },
		dynamicMacros: opts.dynamicMacros,
	});
	return { filePath, text, doc, full };
}

function toPreprocResult(full: ReturnType<typeof preprocessForAst>): PreprocResult {
	const pre: PreprocResult = {
		disabledRanges: full.disabledRanges,
		inactiveRanges: full.inactiveRanges,
		macros: full.macros,
		dynamicMacros: full.dynamicMacros,
		funcMacros: full.funcMacros,
		macroDefs: full.macroDefs,
		includes: full.includes,
		includeTargets: full.includeTargets,
		missingIncludes: full.missingIncludes,
		preprocDiagnostics: full.preprocDiagnostics,
		diagDirectives: full.diagDirectives,
		conditionalGroups: full.conditionalGroups,
		expandedTokens: full.expandedTokens,
	};
	return pre;
}

function collectDiagnostics(doc: TextDocument, pre: PreprocResult, diagnostics: Diag[], opts: CliOptions): CliDiagnostic[] {
	const out: CliDiagnostic[] = [];
	const docPath = fileUriToPath(doc.uri);
	for (const pd of pre.preprocDiagnostics || []) {
		if (pd.file && pd.file !== '<unknown>' && docPath && pd.file !== docPath) continue;
		out.push({
			range: { start: doc.positionAt(pd.start), end: doc.positionAt(pd.end) },
			message: pd.message,
			code: 'LSL-preproc',
		});
	}
	out.push(...filterDiagnostics(diagnostics, opts.disabledDiagnostics));
	return out;
}

function applyTextEdits(doc: TextDocument, edits: ReadonlyArray<{ range: Range; newText: string }>): string {
	let text = doc.getText();
	const sorted = [...edits].sort((a, b) => doc.offsetAt(b.range.start) - doc.offsetAt(a.range.start));
	for (const edit of sorted) {
		const start = doc.offsetAt(edit.range.start);
		const end = doc.offsetAt(edit.range.end);
		text = `${text.slice(0, start)}${edit.newText}${text.slice(end)}`;
	}
	return text;
}

function formatDiagnostic(file: string, diag: CliDiagnostic): string {
	const line = diag.range.start.line + 1;
	const column = diag.range.start.character + 1;
	const friendly = diag.code === 'LSL-preproc' ? null : diagCodeFriendly(diag.code);
	const code = friendly ? `${friendly}/${diag.code}` : diag.code;
	return `${file}:${line}:${column}: ${severityLabel(diag.severity)} ${code}: ${diag.message}`;
}

function diagnosticToJson(diag: CliDiagnostic): object {
	return {
		range: diag.range,
		severity: severityLabel(diag.severity),
		code: diag.code,
		friendlyCode: diag.code === 'LSL-preproc' ? null : diagCodeFriendly(diag.code),
		message: diag.message,
	};
}

function preprocessToJson(result: PreprocessFileResult): object {
	const pre = result.pre;
	return {
		uri: result.doc.uri,
		file: result.filePath,
		expandedText: result.expandedText,
		macros: pre.macros,
		dynamicMacros: pre.dynamicMacros ?? {},
		functionMacros: pre.funcMacros,
		includes: pre.includes,
		includeTargets: pre.includeTargets ?? [],
		missingIncludes: pre.missingIncludes ?? [],
		diagnostics: (pre.preprocDiagnostics ?? []).map(d => ({
			range: { start: result.doc.positionAt(d.start), end: result.doc.positionAt(d.end) },
			code: d.code ?? 'LSL-preproc',
			message: d.message,
		})),
		disabledRanges: pre.disabledRanges.map(r => ({
			range: { start: result.doc.positionAt(r.start), end: result.doc.positionAt(r.end) },
		})),
	};
}

function symbolToJson(symbol: DocumentSymbol): object {
	return {
		name: symbol.name,
		detail: symbol.detail,
		kind: symbol.kind,
		range: symbol.range,
		selectionRange: symbol.selectionRange,
		children: symbol.children?.map(symbolToJson) ?? [],
	};
}

function locationToJson(location: Location | null): object | null {
	if (!location) return null;
	return {
		uri: location.uri,
		file: fileUriLabel(location.uri),
		range: location.range,
	};
}

function hoverToJson(hover: Hover | null): object | null {
	if (!hover) return null;
	return {
		contents: hoverContentsToJson(hover.contents),
		range: hover.range,
	};
}

function hoverContentsToJson(contents: Hover['contents']): unknown {
	if (typeof contents === 'string') return contents;
	if (Array.isArray(contents)) return contents.map(markedStringToJson);
	if ('kind' in contents && 'value' in contents) {
		return { kind: contents.kind, value: contents.value };
	}
	return markedStringToJson(contents);
}

function markedStringToJson(value: MarkedString | MarkupContent): unknown {
	if (typeof value === 'string') return value;
	return value;
}

function renderExpandedTokens(tokens: ReadonlyArray<CoreToken>): string {
	let out = '';
	let indent = 0;
	let atLineStart = true;
	let previous: CoreToken | undefined;
	for (const token of tokens) {
		if (token.kind === 'eof') continue;
		if (token.value === '}') {
			if (!atLineStart) {
				out = out.trimEnd();
				out += '\n';
			}
			indent = Math.max(0, indent - 1);
		}
		if (atLineStart) {
			out += '\t'.repeat(indent);
		} else if (previous && needsSpace(previous, token)) {
			out += ' ';
		}
		out += token.value;
		atLineStart = false;
		if (token.value === '{') {
			indent++;
			out += '\n';
			atLineStart = true;
		} else if (token.value === ';' || token.value === '}') {
			out += '\n';
			atLineStart = true;
		}
		previous = token;
	}
	return out.trimEnd();
}

function needsSpace(left: CoreToken, right: CoreToken): boolean {
	const leftWord = left.kind === 'id' || left.kind === 'keyword' || left.kind === 'number' || left.kind === 'string';
	const rightWord = right.kind === 'id' || right.kind === 'keyword' || right.kind === 'number' || right.kind === 'string';
	if (leftWord && rightWord) return true;
	if (left.value === ')' && (right.kind === 'id' || right.kind === 'keyword' || right.kind === 'number' || right.kind === 'string')) return true;
	if (right.value === '(') return left.kind === 'keyword';
	if (right.value === '{') return true;
	if (left.value === '{' || left.value === ';' || left.value === '}') return true;
	if (right.value === '}' || right.value === ';' || right.value === ',' || right.value === ')' || right.value === ']') return false;
	if (left.value === '(' || left.value === '[' || left.value === '<') return false;
	return left.kind === 'op' || right.kind === 'op';
}

function severityLabel(severity: Diag['severity']): string {
	switch (severity) {
		case 1: return 'error';
		case 2: return 'warning';
		case 3: return 'information';
		case 4: return 'hint';
		default: return 'warning';
	}
}

function fileUriLabel(uri: string): string {
	if (!uri.startsWith('file://')) return uri;
	return fileUriToPath(uri) ?? uri;
}

function parsePositionArgs(opts: CliOptions): { file: string; position: Position } {
	if (opts.files.length !== 3) throw new CliError(`${opts.command} requires <file> <line> <column>.`);
	const line = parsePositiveInteger(opts.files[1]!, 'line');
	const column = parsePositiveInteger(opts.files[2]!, 'column');
	return {
		file: opts.files[0]!,
		position: { line: line - 1, character: column - 1 },
	};
}

function parsePositiveInteger(raw: string, label: string): number {
	if (!/^\d+$/.test(raw)) throw new CliError(`${label} must be a positive integer.`);
	const value = Number(raw);
	if (!Number.isSafeInteger(value) || value < 1) throw new CliError(`${label} must be a positive integer.`);
	return value;
}

function parseArgs(argv: string[]): CliOptions | null {
	const args = [...argv];
	if (args.length === 0 || args[0] === '--help' || args[0] === '-h') {
		process.stdout.write(`${USAGE}\n`);
		return null;
	}
	if (args[0] === '--version' || args[0] === '-v') {
		process.stdout.write(`${CLI_VERSION}\n`);
		return null;
	}

	const first = args[0];
	const command: CommandName = isCommandName(first) ? (args.shift() as CommandName) : 'check';
	const opts: CliOptions = {
		command,
		files: [],
		includePaths: [],
		defaultIncludePath: true,
		definitionsPath: '',
		defines: {},
		dynamicMacros: {},
		disabledDiagnostics: new Set(),
		json: false,
		write: false,
		checkFormat: false,
		braceStyle: 'same-line',
	};

	for (let i = 0; i < args.length; i++) {
		const arg = args[i]!;
		if (arg === '--') {
			opts.files.push(...args.slice(i + 1));
			break;
		}
		if (arg === '--help' || arg === '-h') {
			process.stdout.write(`${USAGE}\n`);
			return null;
		}
		if (arg === '--json') {
			opts.json = true;
			continue;
		}
		if (arg === '--write') {
			opts.write = true;
			continue;
		}
		if (arg === '--check') {
			opts.checkFormat = true;
			continue;
		}
		if (arg === '-I' || arg === '--include-path') {
			opts.includePaths.push(path.resolve(expectValue(args, ++i, arg)));
			continue;
		}
		if (arg.startsWith('-I') && arg.length > 2) {
			opts.includePaths.push(path.resolve(arg.slice(2)));
			continue;
		}
		if (arg === '--no-default-include') {
			opts.defaultIncludePath = false;
			continue;
		}
		if (arg === '-D' || arg === '--define') {
			addDefine(opts.defines, expectValue(args, ++i, arg));
			continue;
		}
		if (arg.startsWith('-D') && arg.length > 2) {
			addDefine(opts.defines, arg.slice(2));
			continue;
		}
		if (arg === '--dynamic-macro') {
			Object.assign(opts.dynamicMacros, parseDynamicMacroList(expectValue(args, ++i, arg)));
			continue;
		}
		if (arg === '--definitions') {
			opts.definitionsPath = expectValue(args, ++i, arg);
			continue;
		}
		if (arg === '--disable') {
			opts.disabledDiagnostics = parseDisabledDiagList(expectValue(args, ++i, arg));
			continue;
		}
		if (arg === '--brace-style') {
			const style = expectValue(args, ++i, arg);
			if (style !== 'same-line' && style !== 'next-line') throw new CliError(`Invalid brace style: ${style}`);
			opts.braceStyle = style;
			continue;
		}
		if (arg.startsWith('-')) throw new CliError(`Unknown option: ${arg}`);
		opts.files.push(arg);
	}

	if (opts.write && opts.checkFormat) throw new CliError('--write and --check cannot be used together.');
	if (opts.json && opts.command === 'format') throw new CliError('--json is not supported by format.');
	if ((opts.write || opts.checkFormat) && opts.command !== 'format' && opts.command !== 'optimize') throw new CliError('--write and --check are only supported by format and optimize.');
	if (opts.defaultIncludePath) opts.includePaths.unshift(process.cwd());
	return opts;
}

function isCommandName(value: string | undefined): value is CommandName {
	return value === 'check' || value === 'format' || value === 'optimize' || value === 'preprocess' || value === 'symbols' || value === 'definition' || value === 'hover' || value === 'dump-defs';
}

function addDefine(defines: Record<string, string | number | boolean>, raw: string): void {
	const eq = raw.indexOf('=');
	const name = eq >= 0 ? raw.slice(0, eq) : raw;
	if (!/^[A-Za-z_]\w*$/.test(name)) throw new CliError(`Invalid macro name: ${name}`);
	defines[name] = eq >= 0 ? parseDefineValue(raw.slice(eq + 1)) : true;
}

function parseDefineValue(raw: string): string | number | boolean {
	if (raw === 'true') return true;
	if (raw === 'false') return false;
	if (/^-?\d+(?:\.\d+)?$/.test(raw)) return Number(raw);
	return raw;
}

function expectValue(args: string[], index: number, option: string): string {
	const value = args[index];
	if (!value || value.startsWith('-')) throw new CliError(`${option} requires a value.`);
	return value;
}

class CliError extends Error {}

main(process.argv.slice(2)).then(code => {
	process.exitCode = code;
}).catch(err => {
	if (err instanceof CliError) {
		process.stderr.write(`lsl-lsp: ${err.message}\n`);
		process.stderr.write('Run `lsl-lsp --help` for usage.\n');
		process.exitCode = 2;
		return;
	}
	process.stderr.write(`${err instanceof Error ? err.stack || err.message : String(err)}\n`);
	process.exitCode = 1;
});
