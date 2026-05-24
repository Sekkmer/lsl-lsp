export interface Position {
	line: number;
	character: number;
}

export interface Range {
	start: Position;
	end: Position;
}

export interface Location {
	uri: string;
	range: Range;
}

export interface TextEdit {
	range: Range;
	newText: string;
}

export enum DiagnosticSeverity {
	Error = 1,
	Warning = 2,
	Information = 3,
	Hint = 4,
}

export enum CompletionItemKind {
	Text = 1,
	Method = 2,
	Function = 3,
	Constructor = 4,
	Field = 5,
	Variable = 6,
	Class = 7,
	Interface = 8,
	Module = 9,
	Property = 10,
	Unit = 11,
	Value = 12,
	Enum = 13,
	Keyword = 14,
	Snippet = 15,
	Color = 16,
	File = 17,
	Reference = 18,
	Folder = 19,
	EnumMember = 20,
	Constant = 21,
	Struct = 22,
	Event = 23,
	Operator = 24,
	TypeParameter = 25,
}

export interface Command {
	title: string;
	command: string;
	arguments?: unknown[];
}

export interface CompletionItem {
	label: string;
	kind?: CompletionItemKind;
	detail?: string;
	documentation?: string | MarkupContent;
	insertText?: string;
	insertTextFormat?: 1 | 2;
	data?: unknown;
	command?: Command;
	sortText?: string;
	filterText?: string;
}

export interface CompletionParams {
	textDocument: { uri: string };
	position: Position;
}

export interface ParameterInformation {
	label: string | [number, number];
	documentation?: string | MarkupContent;
}

export const ParameterInformation = {
	create(label: string | [number, number], documentation?: string | MarkupContent): ParameterInformation {
		return documentation === undefined ? { label } : { label, documentation };
	},
};

export interface SignatureInformation {
	label: string;
	documentation?: string | MarkupContent;
	parameters?: ParameterInformation[];
}

export const SignatureInformation = {
	create(label: string, documentation?: string | MarkupContent, ...parameters: ParameterInformation[]): SignatureInformation {
		return {
			label,
			...(documentation === undefined ? {} : { documentation }),
			...(parameters.length ? { parameters } : {}),
		};
	},
};

export interface SignatureHelp {
	signatures: SignatureInformation[];
	activeSignature?: number;
	activeParameter?: number;
}

export enum MarkupKind {
	PlainText = 'plaintext',
	Markdown = 'markdown',
}

export type MarkedString = string | { language: string; value: string };

export interface MarkupContent {
	kind: MarkupKind | 'plaintext' | 'markdown';
	value: string;
}

export interface Hover {
	contents: MarkedString | MarkedString[] | MarkupContent;
	range?: Range;
}

export enum SymbolKind {
	File = 1,
	Module = 2,
	Namespace = 3,
	Package = 4,
	Class = 5,
	Method = 6,
	Property = 7,
	Field = 8,
	Constructor = 9,
	Enum = 10,
	Interface = 11,
	Function = 12,
	Variable = 13,
	Constant = 14,
	String = 15,
	Number = 16,
	Boolean = 17,
	Array = 18,
	Object = 19,
	Key = 20,
	Null = 21,
	EnumMember = 22,
	Struct = 23,
	Event = 24,
	Operator = 25,
	TypeParameter = 26,
}

export interface DocumentSymbol {
	name: string;
	detail?: string;
	kind: SymbolKind;
	range: Range;
	selectionRange: Range;
	children?: DocumentSymbol[];
}

export const DocumentSymbol = {
	create(
		name: string,
		detail: string | undefined,
		kind: SymbolKind,
		range: Range,
		selectionRange: Range,
		children?: DocumentSymbol[],
	): DocumentSymbol {
		return {
			name,
			...(detail === undefined ? {} : { detail }),
			kind,
			range,
			selectionRange,
			...(children === undefined ? {} : { children }),
		};
	},
};

export interface SemanticTokensLegend {
	tokenTypes: string[];
	tokenModifiers: string[];
}

export interface SemanticTokens {
	resultId?: string;
	data: number[];
}

export class SemanticTokensBuilder {
	private readonly tokens: Array<{ line: number; character: number; length: number; tokenType: number; tokenModifiers: number }> = [];

	push(line: number, character: number, length: number, tokenType: number, tokenModifiers: number): void {
		if (length <= 0) return;
		this.tokens.push({ line, character, length, tokenType, tokenModifiers });
	}

	build(): SemanticTokens {
		this.tokens.sort((a, b) => a.line - b.line || a.character - b.character);
		const data: number[] = [];
		let prevLine = 0;
		let prevChar = 0;
		for (const t of this.tokens) {
			const deltaLine = t.line - prevLine;
			const deltaStart = deltaLine === 0 ? t.character - prevChar : t.character;
			data.push(deltaLine, deltaStart, t.length, t.tokenType, t.tokenModifiers);
			prevLine = t.line;
			prevChar = t.character;
		}
		return { data };
	}
}

export interface TextDocument {
	readonly uri: string;
	readonly languageId: string;
	readonly version: number;
	getText(range?: Range): string;
	positionAt(offset: number): Position;
	offsetAt(position: Position): number;
}

class CoreTextDocument implements TextDocument {
	private readonly lineOffsets: number[];

	constructor(
		readonly uri: string,
		readonly languageId: string,
		readonly version: number,
		private readonly text: string,
	) {
		this.lineOffsets = computeLineOffsets(text);
	}

	getText(range?: Range): string {
		if (!range) return this.text;
		return this.text.slice(this.offsetAt(range.start), this.offsetAt(range.end));
	}

	positionAt(offset: number): Position {
		const clamped = Math.max(0, Math.min(offset, this.text.length));
		let low = 0;
		let high = this.lineOffsets.length;
		while (low < high) {
			const mid = Math.floor((low + high) / 2);
			if (this.lineOffsets[mid]! > clamped) high = mid;
			else low = mid + 1;
		}
		const line = Math.max(0, low - 1);
		return { line, character: clamped - this.lineOffsets[line]! };
	}

	offsetAt(position: Position): number {
		const line = Math.max(0, Math.min(position.line, this.lineOffsets.length - 1));
		const lineOffset = this.lineOffsets[line]!;
		const nextLineOffset = line + 1 < this.lineOffsets.length ? this.lineOffsets[line + 1]! : this.text.length;
		return Math.max(lineOffset, Math.min(lineOffset + position.character, nextLineOffset));
	}
}

export const TextDocument = {
	create(uri: string, languageId: string, version: number, text: string): TextDocument {
		return new CoreTextDocument(uri, languageId, version, text);
	},
};

function computeLineOffsets(text: string): number[] {
	const offsets = [0];
	for (let i = 0; i < text.length; i++) {
		if (text.charCodeAt(i) === 10) offsets.push(i + 1);
	}
	return offsets;
}

export function filePathToUri(filePath: string): string {
	const unc = /^[/\\]{2}([^/\\]+)[/\\]([^/\\]+)(.*)$/.exec(filePath);
	if (unc) {
		const [, authority, share, rest] = unc;
		const pathSegments = [share, ...splitPathSegments(rest ?? '')].map(encodePathSegment).join('/');
		return `file://${encodeAuthority(authority)}/${pathSegments}`;
	}

	const windowsDrive = /^([A-Za-z]):[/\\]?(.*)$/.exec(filePath);
	if (windowsDrive) {
		const [, drive, rest] = windowsDrive;
		const encodedDrive = `${drive.toLowerCase()}%3A`;
		const pathSegments = splitPathSegments(rest ?? '').map(encodePathSegment);
		return `file:///${[encodedDrive, ...pathSegments].join('/')}`;
	}

	let resolved = filePath;
	if (!resolved.startsWith('/')) resolved = `/${resolved}`;
	const pathSegments = splitPathSegments(resolved).map(encodePathSegment).join('/');
	return `file:///${pathSegments}`;
}

export function fileUriToPath(uri: string): string | undefined {
	try {
		const u = new URL(uri);
		if (u.protocol !== 'file:') return undefined;
		const pathSegments = splitPathSegments(u.pathname).map(decodeURIComponent);
		if (u.hostname) return `\\\\${decodeURIComponent(u.hostname)}\\${pathSegments.join('\\')}`;

		const decodedPathname = decodeURIComponent(u.pathname);
		const windowsDrive = /^\/?([A-Za-z]):(?:\/|\\)?(.*)$/.exec(decodedPathname);
		if (windowsDrive) {
			const [, drive, rest] = windowsDrive;
			const restPath = rest ? rest.replaceAll('/', '\\') : '';
			return `${drive.toLowerCase()}:\\${restPath}`;
		}

		return decodedPathname;
	} catch {
		return undefined;
	}
}

function splitPathSegments(pathValue: string): string[] {
	return pathValue.split(/[\\/]+/).filter(Boolean);
}

function encodePathSegment(segment: string): string {
	return encodeURIComponent(segment);
}

function encodeAuthority(authority: string): string {
	return encodeURIComponent(authority);
}
