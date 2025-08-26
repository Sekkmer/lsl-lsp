import { Hover, MarkupKind, Position } from 'vscode-languageserver/node';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { Defs } from './defs';
import { Analysis } from './parser';
import { PreprocResult } from './preproc';

export function lslHover(doc: TextDocument, params: { position: Position }, defs: Defs, analysis?: Analysis, pre?: PreprocResult): Hover | null {
	const off = doc.offsetAt(params.position);
	const text = doc.getText();

	// If hovering over an include target, show resolution summary
	if (pre && pre.includeTargets && pre.includeTargets.length > 0) {
		for (const it of pre.includeTargets) {
			if (off >= it.start && off <= it.end) {
				if (it.resolved && pre.includeSymbols.has(it.resolved)) {
					const info = pre.includeSymbols.get(it.resolved)!;
					const counts = [
						`${info.functions.size} function${info.functions.size === 1 ? '' : 's'}`,
						`${info.macroObjs.size + info.macroFuncs.size} macro${(info.macroObjs.size + info.macroFuncs.size) === 1 ? '' : 's'}`,
						`${info.globals.size} global${info.globals.size === 1 ? '' : 's'}`
					].join(', ');
					const body = ['```lsl', `#include ${it.file}`, '```', `\nLoaded from: ${it.resolved}\nSymbols: ${counts}`].join('\n');
					return { contents: { kind: MarkupKind.Markdown, value: body } };
				}
				const body = ['```lsl', `#include ${it.file}`, '```', '\nNot found in configured includePaths'].join('\n');
				return { contents: { kind: MarkupKind.Markdown, value: body } };
			}
		}
	}
	let s = off; while (s > 0 && /[A-Za-z0-9_]/.test(text[s-1])) s--;
	let e = off; while (e < text.length && /[A-Za-z0-9_]/.test(text[e])) e++;
	const w = text.slice(s, e);
	if (!w) return null;

	// Preprocessor macro hover (#define NAME VALUE)
	if (pre && pre.macros && Object.prototype.hasOwnProperty.call(pre.macros, w)) {
		const val = (pre.macros as any)[w];
		// If the macro is a simple literal (number/string/bool), show just the computed value
		if (typeof val === 'number') {
			return { contents: { kind: MarkupKind.Markdown, value: ['```lsl', String(val), '```'].join('\n') } };
		}
		if (typeof val === 'string') {
			return { contents: { kind: MarkupKind.Markdown, value: ['```lsl', JSON.stringify(val), '```'].join('\n') } };
		}
		if (typeof val === 'boolean') {
			return { contents: { kind: MarkupKind.Markdown, value: ['```lsl', val ? '1' : '0', '```'].join('\n') } };
		}
		// Otherwise, render the define line
		const valueStr = val != null ? String(val) : '';
		const code = ['```lsl', `#define ${w}${valueStr ? ' ' + valueStr : ''}`, '```'].join('\n');
		return { contents: { kind: MarkupKind.Markdown, value: code } };
	}
	// Function-like macro hover: show signature and body without evaluation
	if (pre && pre.funcMacros && Object.prototype.hasOwnProperty.call(pre.funcMacros, w)) {
		const body = (pre.funcMacros as any)[w] as string; // like "(a,b) expr"
		const code = ['```lsl', `#define ${w}${body ? ' ' + body : ''}`, '```'].join('\n');
		return { contents: { kind: MarkupKind.Markdown, value: code } };
	}
	// Special macro __LINE__: show the current line number in this document
	if (w === '__LINE__') {
		const line = doc.positionAt(doc.offsetAt(params.position)).line + 1;
		return { contents: { kind: MarkupKind.Markdown, value: ['```lsl', String(line), '```'].join('\n') } };
	}

	if (defs.consts.has(w)) {
		const c = defs.consts.get(w)!;
		let valStr = '';
		if (Object.prototype.hasOwnProperty.call(c, 'value')) {
			const v = (c as any).value;
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
		if (c.doc) parts.push('', c.doc);
		const wikiLink = (c as any).wiki || `https://wiki.secondlife.com/wiki/${encodeURIComponent(c.name)}`;
		parts.push('', `[Wiki](${wikiLink})`);
		const body = parts.join('\n');
		return { contents: { kind: MarkupKind.Markdown, value: body } };
	}
	if (defs.funcs.has(w)) {
		const fs = defs.funcs.get(w)!;
		const lines = fs.map(fn => `${fn.returns} ${fn.name}(${fn.params.map(p=>`${p.type} ${p.name}`).join(', ')})`);
		const code = ['```lsl', ...lines, '```'].join('\n');
		const docstr = fs[0].doc ?? '';
		// Collect any parameter docs; prefer first overload having docs
		let paramDocs = '';
		for (const f of fs) {
			const withDocs = (f.params || []).filter(p => p.doc && p.doc.trim().length > 0);
			if (withDocs.length > 0) {
				const bullets = withDocs.map(p => `- ${p.name}: ${p.doc}`);
				paramDocs = bullets.join('\n');
				break;
			}
		}
		const parts = [code];
		if (docstr) parts.push('', docstr);
		if (paramDocs) parts.push('', 'Parameters:', paramDocs);
		const wiki = (fs.find(f => (f as any).wiki) as any)?.wiki || `https://wiki.secondlife.com/wiki/${encodeURIComponent(fs[0].name)}`;
		parts.push('', `[Wiki](${wiki})`);
		return { contents: { kind: MarkupKind.Markdown, value: parts.join('\n') } };
	}
	// Include-provided function hover
	if (pre && pre.includeSymbols && pre.includeSymbols.size > 0) {
		for (const info of pre.includeSymbols.values()) {
			const f = info.functions.get(w);
			if (f) {
				const sig = `${f.returns} ${f.name}(${f.params.map(p=>`${p.type}${p.name ? ' ' + p.name : ''}`).join(', ')})`;
				return { contents: { kind: MarkupKind.Markdown, value: ['```lsl', sig, '```'].join('\n') } };
			}
		}
	}
	// User-defined function hover (from analysis)
	if (analysis && analysis.functions.has(w)) {
		const d = analysis.functions.get(w)!;
		const sig = `${d.type ?? 'void'} ${d.name}(${(d.params || []).map(p=>`${p.type ?? 'any'} ${p.name}`).join(', ')})`;
		return { contents: { kind: MarkupKind.Markdown, value: ['```lsl', sig, '```'].join('\n') } };
	}
	// Variables and parameters: show declared type
	if (analysis) {
		const offPos = doc.offsetAt(params.position);
		// If hovering directly on a declaration
		const at = analysis.symbolAt(offPos);
		if (at && (at.kind === 'var' || at.kind === 'param')) {
			const sig = `${at.type ?? 'any'} ${at.name}`;
			return { contents: { kind: MarkupKind.Markdown, value: ['```lsl', sig, '```'].join('\n') } };
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
			return { contents: { kind: MarkupKind.Markdown, value: ['```lsl', sig, '```'].join('\n') } };
		}
	}
	if (defs.events.has(w)) {
		const ev = defs.events.get(w)!;
		const sig = `event ${ev.name}(${ev.params.map(p=>`${p.type} ${p.name}`).join(', ')})`;
		const code = ['```lsl', sig, '```'].join('\n');
		const paramDocs = (ev.params || []).filter(p => p.doc && p.doc.trim().length > 0).map(p => `- ${p.name}: ${p.doc}`).join('\n');
		const parts = [code];
		if (ev.doc) parts.push('', ev.doc);
		if (paramDocs) parts.push('', 'Parameters:', paramDocs);
		const wiki = (ev as any).wiki || `https://wiki.secondlife.com/wiki/${encodeURIComponent(ev.name)}`;
		parts.push('', `[Wiki](${wiki})`);
		return { contents: { kind: MarkupKind.Markdown, value: parts.join('\n') } };
	}
	if (defs.types.has(w)) {
		const code = ['```lsl', `type ${w}`, '```'].join('\n');
		return { contents: { kind: MarkupKind.Markdown, value: code } };
	}
	return null;
}
