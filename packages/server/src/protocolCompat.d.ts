import type {
	CompletionItem as CoreCompletionItem,
	DocumentSymbol as CoreDocumentSymbol,
	Hover as CoreHover,
	Location as CoreLocation,
	MarkupContent as CoreMarkupContent,
	ParameterInformation as CoreParameterInformation,
	Position as CorePosition,
	Range as CoreRange,
	SemanticTokens as CoreSemanticTokens,
	SemanticTokensLegend as CoreSemanticTokensLegend,
	SignatureHelp as CoreSignatureHelp,
	SignatureInformation as CoreSignatureInformation,
	TextDocument as CoreTextDocument,
	TextEdit as CoreTextEdit,
} from '@lsl-lsp/core';
import {
	CompletionItemKind as CoreCompletionItemKind,
	DiagnosticSeverity as CoreDiagnosticSeverity,
	MarkupKind as CoreMarkupKind,
	SymbolKind as CoreSymbolKind,
} from '@lsl-lsp/core';
import type {
	CompletionItem as LspCompletionItem,
	DocumentSymbol as LspDocumentSymbol,
	Hover as LspHover,
	Location as LspLocation,
	MarkupContent as LspMarkupContent,
	ParameterInformation as LspParameterInformation,
	Position as LspPosition,
	Range as LspRange,
	SemanticTokens as LspSemanticTokens,
	SemanticTokensLegend as LspSemanticTokensLegend,
	SignatureHelp as LspSignatureHelp,
	SignatureInformation as LspSignatureInformation,
	TextEdit as LspTextEdit,
} from 'vscode-languageserver/node';
import {
	CompletionItemKind as LspCompletionItemKind,
	DiagnosticSeverity as LspDiagnosticSeverity,
	MarkupKind as LspMarkupKind,
	SymbolKind as LspSymbolKind,
} from 'vscode-languageserver/node';
import type { TextDocument as LspTextDocument } from 'vscode-languageserver-textdocument';

type Satisfies<T extends U, U> = T;
type EnumNamedKeys<T> = {
	[K in Extract<keyof T, string>]: T[K] extends string | number ? K : never;
}[Extract<keyof T, string>];
type ExactEnumKeys<Actual, Expected> =
	[Exclude<EnumNamedKeys<Actual>, EnumNamedKeys<Expected>>, Exclude<EnumNamedKeys<Expected>, EnumNamedKeys<Actual>>] extends [never, never]
		? true
		: false;
type EnumValuesEquivalent<Actual, Expected> = ExactEnumKeys<Actual, Expected> extends true
	? false extends {
		[K in EnumNamedKeys<Actual>]: K extends EnumNamedKeys<Expected>
			? Actual[K] extends Expected[K]
				? Expected[K] extends Actual[K]
					? true
					: false
				: false
			: false;
	}[EnumNamedKeys<Actual>]
		? false
		: true
	: false;

type __satisfies__Position = Satisfies<CorePosition, LspPosition>;
type __satisfies__Range = Satisfies<CoreRange, LspRange>;
type __satisfies__TextEdit = Satisfies<CoreTextEdit, LspTextEdit>;
type __satisfies__Location = Satisfies<CoreLocation, LspLocation>;
type __satisfies__CompletionItem = Satisfies<CoreCompletionItem, LspCompletionItem>;
type __satisfies__MarkupContent = Satisfies<CoreMarkupContent, LspMarkupContent>;
type __satisfies__Hover = Satisfies<CoreHover, LspHover>;
type __satisfies__ParameterInformation = Satisfies<CoreParameterInformation, LspParameterInformation>;
type __satisfies__SignatureInformation = Satisfies<CoreSignatureInformation, LspSignatureInformation>;
type __satisfies__SignatureHelp = Satisfies<CoreSignatureHelp, LspSignatureHelp>;
type __satisfies__SemanticTokens = Satisfies<CoreSemanticTokens, LspSemanticTokens>;
type __satisfies__SemanticTokensLegend = Satisfies<CoreSemanticTokensLegend, LspSemanticTokensLegend>;
type __satisfies__DocumentSymbol = Satisfies<CoreDocumentSymbol, LspDocumentSymbol>;
type __satisfies__TextDocument = Satisfies<LspTextDocument, CoreTextDocument>;
type __satisfies__DiagnosticSeverity = Satisfies<EnumValuesEquivalent<typeof CoreDiagnosticSeverity, typeof LspDiagnosticSeverity>, true>;
type __satisfies__CompletionItemKind = Satisfies<EnumValuesEquivalent<typeof CoreCompletionItemKind, typeof LspCompletionItemKind>, true>;
type __satisfies__MarkupKind = Satisfies<EnumValuesEquivalent<typeof CoreMarkupKind, typeof LspMarkupKind>, true>;
type __satisfies__SymbolKind = Satisfies<EnumValuesEquivalent<typeof CoreSymbolKind, typeof LspSymbolKind>, true>;
