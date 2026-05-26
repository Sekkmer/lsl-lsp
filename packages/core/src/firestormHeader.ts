const FIRESTORM_HEADER_START = '//start_unprocessed_text\n/*';
const FIRESTORM_HEADER_END = '*/\n//end_unprocessed_text';

export interface FirestormHeaderOptions {
	programVersion?: string;
	lastCompiled?: string;
	runtime?: 'mono' | 'lsl2';
}

export interface FirestormHeaderDecodeResult {
	originalSource: string;
	body: string;
	headerEndOffset: number;
}

export function detectFirestormRuntimeDirective(source: string): 'mono' | 'lsl2' {
	if (source.includes('//mono\n')) return 'mono';
	if (source.includes('//lsl2\n')) return 'lsl2';
	return 'mono';
}

export function encodeFirestormPreprocessorHeader(source: string, opts: FirestormHeaderOptions = {}): string {
	const normalized = decodeFirestormPreprocessorHeader(source)?.originalSource ?? source;
	const escaped = normalized.replace(/([/*])(?=[/*|])/g, '$1|');
	const runtime = opts.runtime ?? detectFirestormRuntimeDirective(source);
	const lines = [
		`${FIRESTORM_HEADER_START}${escaped}${FIRESTORM_HEADER_END}`,
		'//nfo_preprocessor_version 0',
		`//program_version ${opts.programVersion ?? 'lsl-lsp'}`,
		`//last_compiled ${opts.lastCompiled ?? 'unknown'}`,
		runtime === 'lsl2' ? '//lsl2' : '//mono',
	];
	return `${lines.join('\n')}\n`;
}

export function wrapWithFirestormPreprocessorHeader(source: string, body: string, opts: FirestormHeaderOptions = {}): string {
	const header = encodeFirestormPreprocessorHeader(source, opts);
	return `${header}\n${body}`;
}

export function decodeFirestormPreprocessorHeader(text: string): FirestormHeaderDecodeResult | null {
	if (!text.startsWith(FIRESTORM_HEADER_START)) return null;
	const end = text.indexOf(FIRESTORM_HEADER_END, FIRESTORM_HEADER_START.length);
	if (end < 0) return null;
	const encoded = text.slice(FIRESTORM_HEADER_START.length, end);
	const headerEndOffset = end + FIRESTORM_HEADER_END.length;
	const originalSource = encoded.replace(/([/*])\|/g, '$1');
	const body = text.slice(skipHeaderMetadata(text, headerEndOffset));
	return { originalSource, body, headerEndOffset };
}

function skipHeaderMetadata(text: string, offset: number): number {
	let cursor = offset;
	while (cursor < text.length) {
		const lineEnd = text.indexOf('\n', cursor);
		const end = lineEnd < 0 ? text.length : lineEnd + 1;
		const line = text.slice(cursor, lineEnd < 0 ? text.length : lineEnd).trim();
		if (
			line === ''
			|| line === '//mono'
			|| line === '//lsl2'
			|| line.startsWith('//nfo_preprocessor_version ')
			|| line.startsWith('//program_version ')
			|| line.startsWith('//last_compiled ')
		) {
			cursor = end;
			continue;
		}
		break;
	}
	return cursor;
}
