import { Hover, MarkupKind, Position } from 'vscode-languageserver/node';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { Defs } from './defs';
import type { DefFunction } from './defs';
import fs from 'node:fs';
import { Analysis } from './analysisTypes';
import type { PreprocResult } from './core/preproc';
import { isKeyword } from './ast/lexer';
import { isType } from './ast';

// Simple in-memory cache for include file contents to avoid repeated sync reads during hover bursts
const includeFileCache = new Map<string, string>();
function readIncludeFile(file: string): string | null {
	try {
		let txt = includeFileCache.get(file);
		if (txt == null) {
			txt = fs.readFileSync(file, 'utf8');
			includeFileCache.set(file, txt);
		}
		return txt;
	} catch { return null; }
}

function extractGenericLeadingComment(text: string, declStart: number): string | null {
	let i = declStart - 1;
	while (i >= 0 && /[ \t\r\n]/.test(text[i]!)) i--;
	if (i < 1) return null;
	if (text[i] === '/' && text[i - 1] === '*') {
		const end = i;
		const start = text.lastIndexOf('/*', i - 1);
		if (start >= 0) {
			const raw = text.slice(start + 2, end - 1);
			return raw.split(/\r?\n/).map(l => l.replace(/^[ \t]*\*?[ \t]?/, '').replace(/\s+$/,'')).join('\n').trim();
		}
	}
	const lines: string[] = [];
	let lineEnd = i;
	while (lineEnd >= 0) {
		let lineStart = lineEnd;
		while (lineStart >= 0 && text[lineStart] !== '\n') lineStart--;
		lineStart++;
		const line = text.slice(lineStart, lineEnd + 1);
		if (/^\s*\/\//.test(line)) {
			lines.unshift(line.replace(/^\s*\/\/+\s?/, '').trimEnd());
			lineEnd = lineStart - 2;
			continue;
		}
		break;
	}
	if (lines.length) return lines.join('\n').trim();
	return null;
}

function extractIncludeSymbolDoc(name: string, kind: 'func' | 'var' | 'macro', pre?: PreprocResult): string | null {
	if (!pre || !pre.includeTargets) return null;
	for (const inc of pre.includeTargets) {
		if (!inc.resolved) continue;
		const txt = readIncludeFile(inc.resolved);
		if (!txt) continue;
		let pattern: RegExp;
		const id = name.replace(/[.*+?^${}()|[\]\\]/g, r => `\\${r}`);
		// NOTE: We test one line at a time, so we don't need the 'm' flag here.  Use explicit \b word boundary.
		if (kind === 'func') {
			pattern = new RegExp(`^[\\t ]*[A-Za-z_][A-Za-z0-9_]*[\\t ]+${id}[\\t ]*\\(`);
		} else if (kind === 'macro') {
			// Match both object-like and function-like macros: #define NAME   or  #define NAME(...)
			pattern = new RegExp(`^\\s*#\\s*define\\s+${id}(?:\\b|\\(|$)`);
		} else {
			pattern = new RegExp(`^[\\t ]*[A-Za-z_][A-Za-z0-9_]*[\\t ]+${id}[\\t ]*(?:=|;|$)`);
		}
		const lines = txt.split(/\r?\n/);
		let offset = 0;
		for (const L of lines) {
			if (pattern.test(L)) {
				const declStart = offset;
				const doc = extractGenericLeadingComment(txt, declStart);
				if (doc) return doc;
				break;
			}
			offset += L.length + 1;
		}
	}
	return null;
}

function formatNumber(value: number): string {
	if (!Number.isFinite(value)) return String(value);
	if (Number.isInteger(value)) return value.toString();
	return value.toFixed(3).replace(/\.0+$/g, '').replace(/(\.\d*?)0+$/, '$1');
}

function appendFunctionMeta(parts: string[], functions: DefFunction[]): void {
	if (!functions || functions.length === 0) return;
	const energyEntry = functions.find(f => typeof f.energy === 'number');
	const sleepEntry = functions.find(f => typeof f.sleep === 'number');
	const experience = functions.some(f => f.experience === true);
	const metaSegments: string[] = [];
	if (energyEntry && typeof energyEntry.energy === 'number') metaSegments.push(`Energy: ${formatNumber(energyEntry.energy)}`);
	if (sleepEntry && typeof sleepEntry.sleep === 'number') metaSegments.push(`Sleep: ${formatNumber(sleepEntry.sleep)}s`);
	if (metaSegments.length) parts.push('', `**Cost:** ${metaSegments.join(' · ')}`);
	if (experience) parts.push('', '_Experience-only_');
}

export function lslHover(doc: TextDocument, params: { position: Position }, defs: Defs, analysis?: Analysis, pre?: PreprocResult): Hover | null {
	const fmtDoc = (s?: string) => (typeof s === 'string' ? s.replace(/\\r\\n|\\n/g, '\n') : s);
	const off = doc.offsetAt(params.position);
	const text = doc.getText();

	let s = off; while (s > 0 && /[A-Za-z0-9_]/.test(text[s-1])) s--;
	let e = off; while (e < text.length && /[A-Za-z0-9_]/.test(text[e])) e++;
	const w = text.slice(s, e);
	if (!w) return null;

	// Keywords: do not produce hover for language keywords
	if (isKeyword(w)) {
		return null;
	}

	// Preprocessor macro hover (#define NAME VALUE)
	if (pre && pre.macros && Object.prototype.hasOwnProperty.call(pre.macros, w)) {
		const val = pre.macros[w as keyof typeof pre.macros];
		const from = macroSourceFile(doc, pre, w);
		const includeDoc = extractIncludeSymbolDoc(w, 'macro', pre);
		// If macro is an alias to a known function name, show target function signature(s)
		if (typeof val === 'string') {
			const alias = String(val).trim();
			if (/^[A-Za-z_]\w*$/.test(alias) && defs.funcs.has(alias)) {
				const fs = defs.funcs.get(alias)!;
				const sigLines = fs.map(fn => `${fn.returns} ${fn.name}(${fn.params.map(p=>`${p.type} ${p.name}`).join(', ')})`);
				const code = ['```lsl', ...sigLines, '```'].join('\n');
				const withWiki = fs.find(f => !!f.wiki);
				const wiki = withWiki?.wiki || `https://wiki.secondlife.com/wiki/${encodeURIComponent(fs[0].name)}`;
				const parts = [code];
				appendFunctionMeta(parts, fs);
				parts.push('', `Alias: #define ${w} ${alias}`, '', `[Wiki](${wiki})`);
				if (from) parts.push('', `From: ${from}`);
				if (includeDoc) parts.push('', includeDoc);
				return { contents: { kind: MarkupKind.Markdown, value: parts.join('\n') } };
			}
		}
		// If the macro is a simple literal (number/string/bool), show just the computed value
		if (typeof val === 'number') {
			const parts = ['```lsl', String(val), '```'];
			if (from) parts.push('', `From: ${from}`);
			if (includeDoc) parts.push('', includeDoc);
			return { contents: { kind: MarkupKind.Markdown, value: parts.join('\n') } };
		}
		if (typeof val === 'string') {
			const sVal = String(val);
			const t = sVal.trim();
			const isPureQuoted = (/^"([^"\\]|\\.)*"$/).test(t) || (/^'([^'\\]|\\.)*'$/).test(t);
			// Pure quoted literal: render literal as-is (avoid JSON.stringify double-quoting)
			if (isPureQuoted) {
				const parts = ['```lsl', sVal, '```'];
				if (from) parts.push('', `From: ${from}`);
				if (includeDoc) parts.push('', includeDoc);
				return { contents: { kind: MarkupKind.Markdown, value: parts.join('\n') } };
			}
			// Otherwise: show define form so expressions (including quoted pieces) are clear
			{
				const parts = ['```lsl', `#define ${w}${sVal ? ' ' + sVal : ''}`, '```'];
				if (from) parts.push('', `From: ${from}`);
				if (includeDoc) parts.push('', includeDoc);
				return { contents: { kind: MarkupKind.Markdown, value: parts.join('\n') } };
			}
		}
		if (typeof val === 'boolean') {
			const parts = ['```lsl', val ? '1' : '0', '```'];
			if (from) parts.push('', `From: ${from}`);
			if (includeDoc) parts.push('', includeDoc);
			return { contents: { kind: MarkupKind.Markdown, value: parts.join('\n') } };
		}
		// Otherwise, render the define line
		const valueStr = val != null ? String(val) : '';
		const parts = ['```lsl', `#define ${w}${valueStr ? ' ' + valueStr : ''}`, '```'];
		if (from) parts.push('', `From: ${from}`);
		if (includeDoc) parts.push('', includeDoc);
		return { contents: { kind: MarkupKind.Markdown, value: parts.join('\n') } };
	}
	// Function-like macro hover: show signature and body without evaluation
	if (pre && pre.funcMacros && Object.prototype.hasOwnProperty.call(pre.funcMacros, w)) {
		const body = pre.funcMacros[w] as string | undefined; // like "(a,b) expr"
		const from = macroSourceFile(doc, pre, w);
		const parts = ['```lsl', `#define ${w}${body ? ' ' + body : ''}`, '```'];
		if (from) parts.push('', `From: ${from}`);
		const includeDoc = extractIncludeSymbolDoc(w, 'macro', pre);
		if (includeDoc) parts.push('', includeDoc);
		return { contents: { kind: MarkupKind.Markdown, value: parts.join('\n') } };
	}
	// Special macro __LINE__: show the current line number in this document
	if (w === '__LINE__') {
		const line = doc.positionAt(doc.offsetAt(params.position)).line + 1;
		return { contents: { kind: MarkupKind.Markdown, value: ['```lsl', String(line), '```'].join('\n') } };
	}

	// If cursor is inside a function call, show the active parameter's doc (resolve through alias macro if needed)
	const callCtx = findEnclosingCall(text, off);
	if (callCtx) {
		let lookupName: string | null = null;
		if (defs.funcs.has(callCtx.name)) lookupName = callCtx.name;
		else if (pre && pre.macros && Object.prototype.hasOwnProperty.call(pre.macros, callCtx.name)) {
			const v = pre.macros[callCtx.name as keyof typeof pre.macros];
			if (typeof v === 'string') {
				const cand = v.trim();
				if (/^[A-Za-z_]\w*$/.test(cand) && defs.funcs.has(cand)) lookupName = cand;
			}
		}
		if (lookupName) {
			const fs = defs.funcs.get(lookupName)!;
			const sigLines = fs.map(fn => `${fn.returns} ${fn.name}(${fn.params.map(p=>`${p.type} ${p.name}`).join(', ')})`);
			const code = ['```lsl', ...sigLines, '```'].join('\n');
			const withWiki = fs.find(f => !!f.wiki);
			const wiki = withWiki?.wiki || `https://wiki.secondlife.com/wiki/${encodeURIComponent(fs[0].name)}`;
			const parts = [code];
			appendFunctionMeta(parts, fs);
			parts.push('', `[Wiki](${wiki})`);
			if (lookupName !== callCtx.name) parts.push('', `Alias: ${callCtx.name} → ${lookupName}`);
			// Show the current parameter doc if available
			const best = fs.find(f => (f.params?.length || 0) > callCtx.index) || fs[0];
			const p = best.params?.[callCtx.index];
			if (p && p.doc) {
				parts.push('', `Parameter: ${p.name}`, fmtDoc(p.doc) as string);
			}
			return { contents: { kind: MarkupKind.Markdown, value: parts.join('\n') } };
		}
	}

	if (defs.consts.has(w)) {
		const c = defs.consts.get(w)!;
		let valStr = '';
		if (Object.prototype.hasOwnProperty.call(c, 'value')) {
			const v = c.value;
			if (typeof v === 'number' && Number.isInteger(v)) {
				const hex = '0x' + (v >>> 0).toString(16).toUpperCase();
				valStr = ` = ${v} /* ${hex} */`;
			} else if (typeof v === 'number') {
				valStr = ` = ${v}`;
			} else if (typeof v === 'boolean') {
				valStr = ` = ${v ? 1 : 0}`;
			} else if (typeof v === 'string') {
				valStr = ` = ${JSON.stringify(v)}`;
			} else if (v != null) {
				valStr = ` = ${String(v)}`;
			}
		}
		const sig = `// constant\n${c.type} ${c.name}${valStr}`;
		const parts = [ '```lsl', sig, '```' ];
		const wikiLink = c.wiki || `https://wiki.secondlife.com/wiki/${encodeURIComponent(c.name)}`;
		parts.push('', `[Wiki](${wikiLink})`);
		if (c.doc) parts.push('', fmtDoc(c.doc) as string);
		const body = parts.join('\n');
		return { contents: { kind: MarkupKind.Markdown, value: body } };
	}
	if (defs.funcs.has(w)) {
		const fs = defs.funcs.get(w)!;
		const lines = fs.map(fn => `${fn.returns} ${fn.name}(${fn.params.map(p=>`${p.type} ${p.name}`).join(', ')})`);
		const code = ['```lsl', ...lines, '```'].join('\n');
		const docstr = fmtDoc(fs[0].doc) ?? '';
		// Collect any parameter docs; prefer first overload having docs
		let paramDocs = '';
		for (const f of fs) {
			const withDocs = (f.params || []).filter(p => p.doc && p.doc.trim().length > 0);
			if (withDocs.length > 0) {
				const bullets = withDocs.map(p => `- ${p.name}: ${fmtDoc(p.doc)}`);
				paramDocs = bullets.join('\n');
				break;
			}
		}
		const parts = [code];
		appendFunctionMeta(parts, fs);
		const wiki = fs.find(f => f.wiki)?.wiki || `https://wiki.secondlife.com/wiki/${encodeURIComponent(fs[0].name)}`;
		parts.push('', `[Wiki](${wiki})`);
		if (docstr) parts.push('', docstr);
		if (paramDocs) parts.push('', 'Parameters:', withParamDocFormatting(paramDocs));
		return { contents: { kind: MarkupKind.Markdown, value: parts.join('\n') } };
	}
	// User-defined function hover (from analysis)
	if (analysis && analysis.functions.has(w)) {
		const d = analysis.functions.get(w)!;
		const sig = `${d.type ?? 'void'} ${d.name}(${(d.params || []).map(p=>`${p.type ?? 'any'} ${p.name}`).join(', ')})`;
		const parts = ['```lsl', sig, '```'];
		// Try to extract a leading JSDoc-style block comment (/** ... */) immediately before the decl
		// Prefer the start of the full declaration (header) when available to avoid hitting parameter name token
		const startPos = d.fullRange?.start ?? d.range.start;
		const declStart = doc.offsetAt(startPos);
		const jsdoc = extractLeadingJsDoc(doc.getText(), declStart);
		if (jsdoc) parts.push('', jsdoc);
		else {
			// Fallback: search include headers for a preceding comment
			const incDoc = extractIncludeSymbolDoc(w, 'func', pre);
			if (incDoc) parts.push('', incDoc);
		}
		return { contents: { kind: MarkupKind.Markdown, value: parts.join('\n') } };
	}
	// Variables and parameters: show declared type, and if it's an event parameter with docs, include them
	if (analysis) {
		const offPos = doc.offsetAt(params.position);
		// If hovering directly on a declaration
		const at = analysis.symbolAt(offPos);
		if (at && (at.kind === 'var' || at.kind === 'param')) {
			const sig = `${at.type ?? 'any'} ${at.name}`;
			const parts = ['```lsl', sig, '```'];
			// Try to attach event parameter doc if available (based on enclosing declaration)
			if (at.kind === 'param') {
				const declOff = doc.offsetAt(at.range.start);
				const ctx = findEnclosingParamDecl(doc.getText(), declOff);
				if (ctx && defs.events.has(ctx.name)) {
					const ev = defs.events.get(ctx.name)!;
					const pd = ev.params?.[ctx.index];
					if (pd && pd.doc) {
						parts.push('', `Parameter: ${pd.name}`, fmtDoc(pd.doc) as string);
					}
				}
			}
			// Fallback include doc for global vars
			if (at.kind === 'var') {
				const incDoc = extractIncludeSymbolDoc(w, 'var', pre);
				if (incDoc) parts.push('', incDoc);
			}
			return { contents: { kind: MarkupKind.Markdown, value: parts.join('\n') } };
		}
		// Otherwise, try to resolve by name and nearest declaration before this offset
		const decls = analysis.decls.filter(d => (d.kind === 'var' || d.kind === 'param') && d.name === w);
		if (decls.length > 0) {
			const off = offPos;
			let best = decls[0];
			let bestStart = -1;
			for (const d of decls) {
				const s = doc.offsetAt(d.range.start);
				if (s <= off && s > bestStart) { best = d; bestStart = s; }
			}
			const sig = `${best.type ?? 'any'} ${best.name}`;
			const parts = ['```lsl', sig, '```'];
			if (best.kind === 'param') {
				const declOff = doc.offsetAt(best.range.start);
				const ctx = findEnclosingParamDecl(doc.getText(), declOff);
				if (ctx && defs.events.has(ctx.name)) {
					const ev = defs.events.get(ctx.name)!;
					const pd = ev.params?.[ctx.index];
					if (pd && pd.doc) {
						parts.push('', `Parameter: ${pd.name}`, fmtDoc(pd.doc) as string);
					}
				}
			}
			if (best.kind === 'var') {
				const incDoc = extractIncludeSymbolDoc(w, 'var', pre);
				if (incDoc) parts.push('', incDoc);
			}
			return { contents: { kind: MarkupKind.Markdown, value: parts.join('\n') } };
		}
	}
	if (defs.events.has(w)) {
		const ev = defs.events.get(w)!;
		const sig = `event ${ev.name}(${ev.params.map(p=>`${p.type} ${p.name}`).join(', ')})`;
		const code = ['```lsl', sig, '```'].join('\n');
		const paramDocs = (ev.params || []).filter(p => p.doc && p.doc.trim().length > 0).map(p => `- ${p.name}: ${p.doc}`).join('\n');
		const parts = [code];
		const wiki = ev.wiki || `https://wiki.secondlife.com/wiki/${encodeURIComponent(ev.name)}`;
		parts.push('', `[Wiki](${wiki})`);
		if (ev.doc) parts.push('', fmtDoc(ev.doc) as string);
		if (paramDocs) parts.push('', 'Parameters:', withParamDocFormatting(paramDocs));
		return { contents: { kind: MarkupKind.Markdown, value: parts.join('\n') } };
	}
	if (isType(w)) {
		const code = ['```lsl', `type ${w}`, '```'].join('\n');
		return { contents: { kind: MarkupKind.Markdown, value: code } };
	}
	return null;
}

// Find a JSDoc-style block comment (/** ... */) immediately preceding the declaration start offset.
// Returns cleaned Markdown text or null if not found.
function extractLeadingJsDoc(text: string, declStart: number): string | null {
	// Walk back over whitespace/newlines
	let i = declStart - 1;
	while (i >= 0 && /[ \t\r\n]/.test(text[i]!)) i--;
	// Expect the text to end with */ of a block comment
	if (i < 1 || text[i] !== '/' || text[i - 1] !== '*') return null;
	// Find the matching /*
	const start = text.lastIndexOf('/*', i - 1);
	if (start < 0) return null;
	// Check it is /** ... */ specifically
	if (text[start + 2] !== '*') return null;
	// Ensure there is only whitespace between this comment and declStart
	// (already ensured by initial back-scan), so proceed to extract
	const bodyStart = start + 3; // after /**
	const bodyEnd = i - 1; // position of '*' before '/'
	const raw = text.slice(Math.max(bodyStart, 0), Math.max(bodyStart, 0) <= bodyEnd ? bodyEnd + 1 : bodyStart);
	return cleanJsDoc(raw);
}

function cleanJsDoc(raw: string): string {
	const lines = raw.split(/\r?\n/);
	const cleaned = lines.map(l => {
		// Trim leading spaces then an optional leading '*'
		const m = /^[ \t]*\*?[ \t]?(.*)$/.exec(l);
		return (m ? m[1] : l).replace(/\s+$/g, '');
	});
	// Normalize CRLF already handled by split; trim surrounding blank lines
	while (cleaned.length && cleaned[0].trim() === '') cleaned.shift();
	while (cleaned.length && cleaned[cleaned.length - 1].trim() === '') cleaned.pop();
	return cleaned.join('\n');
}

// Try to find an enclosing function call around the given offset and return the call name and argument index
function findEnclosingCall(text: string, offset: number): { name: string; index: number } | null {
	const n = text.length;
	let i = offset;
	// Walk backward to find matching '('
	let depth = 0;
	for (i = offset; i >= 0; i--) {
		const ch = text[i];
		if (ch === ')') depth++;
		else if (ch === '(') {
			if (depth === 0) break; else depth--;
		}
	}
	if (i < 0 || text[i] !== '(') return null;
	const parenPos = i;
	// Extract identifier before '('
	let j = parenPos - 1;
	while (j >= 0 && /\s/.test(text[j]!)) j--;
	const end = j;
	while (j >= 0 && /[A-Za-z0-9_]/.test(text[j]!)) j--;
	const name = text.slice(j + 1, end + 1);
	if (!/^[A-Za-z_]\w*$/.test(name)) return null;
	// Count commas from just after '(' to the hover offset, respecting nesting and strings
	let argIndex = 0;
	let k = parenPos + 1;
	let pd = 0, bd = 0, cd = 0;
	let inStr: '"' | '\'' | null = null;
	for (; k < Math.min(offset, n); k++) {
		const ch = text[k];
		if (inStr) {
			if (ch === '\\') { k++; continue; }
			if (ch === inStr) inStr = null;
			continue;
		}
		if (ch === '"' || ch === '\'') { inStr = ch; continue; }
		if (ch === '(') pd++;
		else if (ch === ')') { if (pd > 0) pd--; }
		else if (ch === '[') bd++;
		else if (ch === ']') { if (bd > 0) bd--; }
		else if (ch === '{') cd++;
		else if (ch === '}') { if (cd > 0) cd--; }
		else if (ch === ',' && pd === 0 && bd === 0 && cd === 0) argIndex++;
	}
	return { name, index: argIndex };
}
// Given an offset known to be within a parameter identifier in a declaration "name(type a, type b)",
// find the declaring identifier before '(' and the index of the parameter by counting commas.
function findEnclosingParamDecl(text: string, offset: number): { name: string; index: number } | null {
	const n = text.length;
	let i = offset;
	// Walk backward to nearest '('
	let depth = 0;
	for (i = offset; i >= 0; i--) {
		const ch = text[i];
		if (ch === ')') depth++;
		else if (ch === '(') {
			if (depth === 0) break; else depth--;
		}
	}
	if (i < 0 || text[i] !== '(') return null;
	const parenPos = i;
	// Identifier before '('
	let j = parenPos - 1;
	while (j >= 0 && /\s/.test(text[j]!)) j--;
	const end = j;
	while (j >= 0 && /[A-Za-z0-9_]/.test(text[j]!)) j--;
	const name = text.slice(j + 1, end + 1);
	if (!/^[A-Za-z_]\w*$/.test(name)) return null;
	// Count commas from '(' to offset, ignoring nested pairs
	let idx = 0;
	let k = parenPos + 1;
	let pd = 0, bd = 0, cd = 0;
	let inStr: '"' | '\'' | null = null;
	for (; k < Math.min(offset, n); k++) {
		const ch = text[k];
		if (inStr) {
			if (ch === '\\') { k++; continue; }
			if (ch === inStr) inStr = null;
			continue;
		}
		if (ch === '"' || ch === '\'') { inStr = ch; continue; }
		if (ch === '(') pd++;
		else if (ch === ')') { if (pd > 0) pd--; }
		else if (ch === '[') bd++;
		else if (ch === ']') { if (bd > 0) bd--; }
		else if (ch === '{') cd++;
		else if (ch === '}') { if (cd > 0) cd--; }
		else if (ch === ',' && pd === 0 && bd === 0 && cd === 0) idx++;
	}
	return { name, index: idx };
}
// When parameter docs contain line breaks, indent continuation lines in bullets for nicer Markdown rendering
function withParamDocFormatting(bullets: string): string {
	// For each line that starts with "- name: ", indent subsequent wrapped lines by two spaces
	// Simple approach: replace "\n" with "\n	" to keep wrapped lines under the bullet
	return bullets.replace(/\n/g, '\n	');
}

// Detect if a macro is locally defined in the current document
function hasLocalMacroDefine(doc: TextDocument, name: string): boolean {
	const text = doc.getText();
	if (!text.includes('#define')) return false;
	const lines = text.split(/\r?\n/);
	for (const L of lines) {
		const m = /^\s*#\s*define\s+([A-Za-z_]\w*)/.exec(L);
		if (m && m[1] === name) return true;
	}
	return false;
}

// If macro comes from an include, return its source file path; otherwise null
function macroSourceFile(doc: TextDocument, pre: PreprocResult | undefined, name: string): string | null {
	if (!pre) return null;
	// Prefer local defines: no need to add From: for local
	if (hasLocalMacroDefine(doc, name)) return null;
	return null;
}
