#!/usr/bin/env node
import { fetch as undiciFetch } from 'undici';
import * as cheerio from 'cheerio';
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';

const WIKI_BASE = 'https://wiki.secondlife.com';
const CATEGORY_FUNCS = `${WIKI_BASE}/wiki/Category:LSL_Functions`;
const CATEGORY_CONSTS = `${WIKI_BASE}/wiki/Category:LSL_Constants`;
const CATEGORY_EVENTS = `${WIKI_BASE}/wiki/Category:LSL_Events`;
const PREFIX_FUNCS = `${WIKI_BASE}/w/index.php?title=Special:PrefixIndex&prefix=ll&namespace=0`;

// Simple cache + rate-limit configuration via env vars
const MIN_DELAY_MS = Number(process.env.CRAWLER_MIN_DELAY_MS || 250);
const CACHE_TTL_SEC = Number(process.env.CRAWLER_TTL_SECONDS || 24 * 60 * 60);
const CACHE_ENABLED = (process.env.CRAWLER_CACHE ?? '1') !== '0';
const VERBOSE = (process.env.CRAWLER_VERBOSE ?? '0') !== '0';
const CONCURRENCY = Math.max(1, Number(process.env.CRAWLER_CONCURRENCY || 8));
const PROGRESS_ENABLED = (process.env.CRAWLER_PROGRESS ?? '1') !== '0';

const CACHE_DIR = path.resolve(process.cwd(), 'out', 'cache');
let lastRequestAt = 0;

function cachePathFor(url: string) {
	const h = crypto.createHash('sha1').update(url).digest('hex');
	return path.join(CACHE_DIR, `${h}.html`);
}

async function ensureCacheDir() {
	await fs.mkdir(CACHE_DIR, { recursive: true }).catch(() => void 0);
}

async function readCache(file: string): Promise<string | null> {
	try {
		const st = await fs.stat(file);
		const ageSec = (Date.now() - st.mtimeMs) / 1000;
		if (ageSec <= CACHE_TTL_SEC) {
			const data = await fs.readFile(file, 'utf8');
			if (VERBOSE) console.error(`[cache] hit ${path.basename(file)} age=${ageSec.toFixed(0)}s`);
			return data;
		}
		if (VERBOSE) console.error(`[cache] stale ${path.basename(file)}`);
		return null;
	} catch { return null; }
}

async function writeCache(file: string, data: string) {
	try { await fs.writeFile(file, data, 'utf8'); } catch { /* ignore */ }
}

async function rateLimit() {
	const now = Date.now();
	const wait = Math.max(0, lastRequestAt + MIN_DELAY_MS - now);
	if (wait > 0) await new Promise(r => setTimeout(r, wait));
	lastRequestAt = Date.now();
}

// Run a promise-returning iterator over items with a fixed concurrency limit
async function mapLimit<T, R>(
	items: T[],
	limit: number,
	iter: (item: T, index: number) => Promise<R | null | undefined>,
	onProgress?: (index: number) => void
): Promise<R[]> {
	const out: R[] = [];
	let idx = 0;
	const worker = async () => {
		while (true) {
			const i = idx++;
			if (i >= items.length) break;
			try {
				const res = await iter(items[i], i);
				if (res != null) out.push(res as R);
			} catch {
				// iterator is expected to log its own errors; swallow to keep pool alive
			} finally {
				if (onProgress) onProgress(i);
			}
		}
	};
	const n = Math.min(Math.max(1, limit | 0), items.length || 1);
	await Promise.all(Array.from({ length: n }, () => worker()));
	return out;
}

// Simple in-terminal progress (stderr) with carriage return updates
function createProgress(label: string, total: number) {
	const enabled = PROGRESS_ENABLED && !!process.stderr.isTTY && total > 0;
	let done = 0;
	let last = 0;
	const render = () => {
		if (!enabled) return;
		const now = Date.now();
		if (now - last < 80 && done < total) return; // throttle ~12fps
		last = now;
		const pct = Math.min(100, Math.round((done / total) * 100));
		const cols = (process.stderr.columns ?? 80);
		const labelText = `[${label}] ${pct}% ${done}/${total}`;
		const barLen = Math.max(10, Math.min(30, cols - labelText.length - 5));
		const filled = Math.floor((pct / 100) * barLen);
		const bar = '█'.repeat(filled) + '░'.repeat(Math.max(0, barLen - filled));
		const line = `${labelText} ${bar}`;
		process.stderr.write(`\r${line.padEnd(cols - 1, ' ')}`);
		if (done >= total) process.stderr.write('\n');
	};
	return {
		tick(delta = 1) { done += delta; render(); },
		complete() { done = total; render(); }
	};
}

async function fetchHtml(url: string): Promise<string> {
	await ensureCacheDir();
	const cpath = cachePathFor(url);
	if (CACHE_ENABLED) {
		const cached = await readCache(cpath);
		if (cached != null) return cached;
	}
	await rateLimit();
	const res = await undiciFetch(url, { headers: { 'user-agent': 'lsl-lsp-crawler/0.1 (+https://github.com/you/lsl-lsp)' } });
	if (!res.ok) throw new Error(`Fetch failed ${res.status} ${res.statusText} for ${url}`);
	const text = await res.text();
	if (CACHE_ENABLED) await writeCache(cpath, text);
	return text;
}

function unique<T>(arr: T[]): T[] { return Array.from(new Set(arr)); }

export type LslDefs = {
	version: string;
	types: string[];
	keywords: string[];
	constants: { name: string; type: string; value?: number | string }[];
	events: { name: string; params: { name: string; type: string }[] }[];
	functions: { name: string; returns: string; params: { name: string; type: string; default?: string }[] }[];
};

async function listFunctionLinks(html: string): Promise<string[]> {
	const $ = cheerio.load(html);
	// On the category page, function links are in the content area; avoid nav/sidebar
	const links: string[] = [];
	$('#mw-content-text a').each((_: number, a: any) => {
		const href = $(a).attr('href');
		const title = $(a).attr('title') || '';
		if (!href) return;
		if (!href.startsWith('/wiki/')) return;
		// Filter to LSL function pages: their titles often look like "llSomething"
		if (/^ll[A-Z]/i.test(title) || /^ll[A-Z]/i.test($(a).text())) {
			links.push(WIKI_BASE + href);
		}
	});
	return unique(links).sort();
}

async function listAllFunctionLinks(): Promise<string[]> {
	const all: string[] = [];
	let url: string | null = CATEGORY_FUNCS;
	while (url) {
		const html = await fetchHtml(url);
		const pageLinks = await listFunctionLinks(html);
		all.push(...pageLinks);
		// Find next page link (MediaWiki pagination uses link rel=next or span.mw-nextlink)
		const $ = cheerio.load(html);
		let next: string | null = null;
		const relNext = $('link[rel="next"]').attr('href');
		if (relNext) next = relNext.startsWith('http') ? relNext : (WIKI_BASE + relNext);
		if (!next) {
			const a = $('a.mw-nextlink').attr('href');
			if (a) next = a.startsWith('http') ? a : (WIKI_BASE + a);
		}
		url = next;
		if (VERBOSE) console.error(`[crawl] page done, next=${url ?? 'none'}`);
	}
	// Merge with PrefixIndex results to capture functions not listed in the category (redirects/aliases)
	try {
		const html = await fetchHtml(PREFIX_FUNCS);
		const $ = cheerio.load(html);
		$('#mw-content-text a').each((_: number, a: any) => {
			const href = $(a).attr('href');
			const text = ($(a).attr('title') || $(a).text() || '').trim();
			if (href && href.startsWith('/wiki/') && /^ll[A-Z]/i.test(text)) all.push(WIKI_BASE + href);
		});
	} catch (e) {
		if (VERBOSE) console.error('[crawl] prefix index fetch failed:', (e as Error).message);
	}
	return unique(all).sort();
}


async function listConstantLinks(html: string): Promise<string[]> {
	const $ = cheerio.load(html);
	const links: string[] = [];
	// Category members usually appear under .mw-category
	$('#mw-content-text .mw-category a, #mw-pages a').each((_: number, a: any) => {
		const href = $(a).attr('href');
		const title = $(a).attr('title') || '';
		if (!href) return;
		if (!href.startsWith('/wiki/')) return;
		const text = $(a).text().trim();
		// Most constants are uppercase tokens; don't over-filter—accept likely members
		if (/^[A-Z_][A-Z0-9_]*$/.test(title) || /^[A-Z_][A-Z0-9_]*$/.test(text)) {
			links.push(WIKI_BASE + href);
		} else {
			// As fallback, accept anything in the category listing and let page filter later
			links.push(WIKI_BASE + href);
		}
	});
	return unique(links).sort();
}

async function listAllConstantLinks(): Promise<string[]> {
	const all: string[] = [];
	const visited = new Set<string>();
	let url: string | null = CATEGORY_CONSTS;
	while (url) {
		if (visited.has(url)) break;
		visited.add(url);
		const html = await fetchHtml(url);
		const pageLinks = await listConstantLinks(html);
		all.push(...pageLinks);
		const $ = cheerio.load(html);
		let next: string | null = null;
		const candidates = [
			$('link[rel="next"]').attr('href'),
			$('a[rel="next"]').attr('href'),
			$('#mw-pages a.mw-nextlink').attr('href'),
			$('#mw-content-text a.mw-nextlink').attr('href'),
			$('#mw-pages a:contains("next page")').attr('href'),
			$('#mw-pages a:contains("next 200")').attr('href'),
			$('a:contains("next page")').attr('href'),
			$('a:contains("next 200")').attr('href')
		].filter(Boolean) as string[];
		for (const href of candidates) {
			if (href) { next = href.startsWith('http') ? href : (WIKI_BASE + href); break; }
		}
		url = next && !visited.has(next) ? next : null;
		if (VERBOSE) console.error(`[crawl] const page done, next=${url ?? 'none'}`);
	}
	// Seed known important constants that may be missing from category listings
	// (no manual seeds)
	return unique(all).sort();
}

async function listEventLinks(html: string): Promise<string[]> {
	const $ = cheerio.load(html);
	const links: string[] = [];
	$('#mw-content-text .mw-category a, #mw-pages a').each((_: number, a: any) => {
		const href = $(a).attr('href');
		const title = $(a).attr('title') || '';
		if (!href) return;
		if (!href.startsWith('/wiki/')) return;
		const text = $(a).text().trim();
		if (/^[a-z_][a-z0-9_]*$/.test(title) || /^[a-z_][a-z0-9_]*$/.test(text)) {
			links.push(WIKI_BASE + href);
		} else {
			links.push(WIKI_BASE + href);
		}
	});
	return unique(links).sort();
}

async function listAllEventLinks(): Promise<string[]> {
	const all: string[] = [];
	let url: string | null = CATEGORY_EVENTS;
	while (url) {
		const html = await fetchHtml(url);
		const pageLinks = await listEventLinks(html);
		all.push(...pageLinks);
		const $ = cheerio.load(html);
		let next: string | null = null;
		const relNext = $('link[rel="next"]').attr('href');
		if (relNext) next = relNext.startsWith('http') ? relNext : (WIKI_BASE + relNext);
		if (!next) {
			const a = $('a.mw-nextlink').attr('href');
			if (a) next = a.startsWith('http') ? a : (WIKI_BASE + a);
		}
		url = next;
		if (VERBOSE) console.error(`[crawl] event page done, next=${url ?? 'none'}`);
	}
	return unique(all).sort();
}

const TYPE_SET = new Set(['integer','float','string','key','vector','rotation','list','void']);

function canonicalizeLl(name: string | undefined): string | undefined {
	if (!name) return name;
	// Normalize common variants:
	// - Any case of 'll' -> 'll'
	// - Single leading 'l' before uppercase (typo) -> 'll'
	if (/^ll/i.test(name)) return 'll' + name.slice(2);
	if (/^l[A-Z]/.test(name)) return 'll' + name.slice(1);
	return name;
}

function normalizeConstantValue(t: string | null, raw: string | number | null): string | number | undefined {
	if (raw == null) return undefined;
	if (typeof raw === 'number') {
		if (t === 'integer') return Math.trunc(raw);
		return raw;
	}
	let s = String(raw).trim();
	// drop trailing semicolons
	s = s.replace(/;\s*$/, '');
	if (t === 'integer' || t === 'float') {
		const ss = s.replace(/[,_\s]/g, '');
		if (/^0x[0-9a-f]+$/i.test(ss)) {
			const n = parseInt(ss, 16);
			return t === 'integer' ? n : n;
		}
		const n = Number(ss);
		if (Number.isFinite(n)) return t === 'integer' ? Math.trunc(n) : n;
		return undefined;
	}
	if (t === 'string' || t === 'key') {
		if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith('\'') && s.endsWith('\''))) {
			s = s.slice(1, -1);
		}
		return s;
	}
	// vector/rotation/list: return as-is (without trailing semicolon)
	return s;
}

function parseParams(raw: string) {
	const out: { name: string; type: string; default?: string }[] = [];
	const parts = raw.split(',').map(s => s.trim()).filter(Boolean);
	for (const p of parts) {
		// pattern: <type> <name> [= <default>]
		const m = /^(\w+)\s+(\w+)(?:\s*=\s*(.*))?$/.exec(p);
		if (m) {
			const [, type, name, def] = m;
			if (TYPE_SET.has(type)) {
				out.push({ name, type, ...(def ? { default: def.trim() } : {}) });
			}
		} else {
			// ignore non-typed example args
		}
	}
	return out;
}

function tryParseSignature(line: string) {
	let s = line.trim().replace(/;\s*$/, '');
	// normalize optional leading 'function'
	s = s.replace(/^function\s+/, '');
	// also allow cases where 'function' appears mid-line (badly wrapped examples)
	const mLead = /\bfunction\s+(\w+)\s+(l{1,2}\w+)\s*\(([^)]*)\)/i.exec(line);
	if (mLead) {
		const [, returns, name, paramsRaw] = mLead;
		const params = paramsRaw.trim() ? parseParams(paramsRaw) : [];
		return { name, returns, params };
	}
	// with return type at start
	let m = /^(\w+)\s+(l{1,2}\w+)\s*\(([^)]*)\)$/.exec(s);
	if (m) {
		const [, returns, name, paramsRaw] = m;
		const params = paramsRaw.trim() ? parseParams(paramsRaw) : [];
		return { name, returns, params };
	}
	// without return type
	m = /^(l{1,2}\w+)\s*\(([^)]*)\)$/.exec(s);
	if (m) {
		const [, name, paramsRaw] = m;
		const params = paramsRaw.trim() ? parseParams(paramsRaw) : [];
		if (params.length > 0) return { name, returns: 'void', params };
	}
	return null;
}

// Heuristic: split a call argument list into top-level arguments, ignoring commas in (), [], {}, <> pairs
function splitTopLevelArgs(argText: string): string[] {
	const args: string[] = [];
	let buf = '';
	let pd = 0, bd = 0, cd = 0, vd = 0; // paren, bracket, brace, angle
	let inStr: '"'|'\''|null = null;
	for (let i = 0; i < argText.length; i++) {
		const ch = argText[i];
		if (inStr) {
			buf += ch;
			if (ch === '\\') { i++; if (i < argText.length) buf += argText[i]; continue; }
			if (ch === inStr) inStr = null;
			continue;
		}
		if (ch === '"' || ch === '\'') { inStr = ch as any; buf += ch; continue; }
		if (ch === '(') { pd++; buf += ch; continue; }
		if (ch === ')') { if (pd > 0) pd--; buf += ch; continue; }
		if (ch === '[') { bd++; buf += ch; continue; }
		if (ch === ']') { if (bd > 0) bd--; buf += ch; continue; }
		if (ch === '{') { cd++; buf += ch; continue; }
		if (ch === '}') { if (cd > 0) cd--; buf += ch; continue; }
		if (ch === '<') { vd++; buf += ch; continue; }
		if (ch === '>') { if (vd > 0) vd--; buf += ch; continue; }
		if (ch === ',' && pd === 0 && bd === 0 && cd === 0 && vd === 0) {
			const part = buf.trim(); if (part) args.push(part); buf = ''; continue;
		}
		buf += ch;
	}
	const last = buf.trim(); if (last) args.push(last);
	return args;
}

function inferTypeFromArg(arg: string): string {
	const s = arg.trim();
	if (!s) return 'any' as any;
	if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith('\'') && s.endsWith('\''))) return 'string';
	if (/^0x[0-9a-f]+$/i.test(s) || /^[+-]?\d+$/.test(s)) return 'integer';
	if (/^[+-]?(?:\d+\.?\d*|\d*\.\d+)(?:[eE][+-]?\d+)?$/.test(s)) return 'float';
	if (s.startsWith('[') && s.endsWith(']')) return 'list';
	if (s.startsWith('<') && s.endsWith('>')) return 'vector';
	// Common LSL boolean constants resolve to integer
	if (/\b(TRUE|FALSE)\b/.test(s)) return 'integer';
	// Default heuristics: for json-related functions, assume string for first arg and list for later when path-like
	return 'string';
}

export async function parseFunctionPage(html: string, expectedName?: string) {
	const $ = cheerio.load(html);
	const title = $('#firstHeading').text().trim();
	// Build a robust name pattern: accept raw title, underscore variant, and canonical 'll' prefixed variant
	function escapeRegExp(s: string) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
	const raw = title;
	const rawUnderscore = raw.replace(/\s+/g, '_');
	const canon = canonicalizeLl(raw) || raw.replace(/^Ll/, 'll');
	const canonUnderscore = canon.replace(/\s+/g, '_');
	const nearMiss = (s: string) => (/^ll/i.test(s) ? 'l' + s.slice(2) : s);
	let nameAlternatives = [raw, rawUnderscore, canon, canonUnderscore]
		.flatMap(s => [s, nearMiss(s)])
		.map(escapeRegExp)
		.join('|');
	if (expectedName) {
		const exp = expectedName;
		const expUnderscore = exp.replace(/\s+/g, '_');
		nameAlternatives += `|${[exp, expUnderscore].flatMap(s => [s, nearMiss(s)]).map(escapeRegExp).join('|')}`;
	}
	const nameRegex = new RegExp(`\\b(${nameAlternatives})\\s*\\(`, 'i');

	const allCandidates: string[] = [];
	const typedCandidates: string[] = [];
	$('table.infobox pre, table.infobox code, #mw-content-text pre, #mw-content-text code, tt').each((_: number, el: any) => {
		const txt = $(el).text();
		if (!txt) return;
		for (const rawLine of txt.split(/\r?\n/)) {
			const line = rawLine.trim();
			if (!line) continue;
			if (!/[()]/.test(line)) continue;
			// Accept typical ll* lines, or nameRegex lines (to catch single-'l' variants)
			if (!(/\bll\w*\s*\(/i.test(line) || nameRegex.test(line))) continue;
			// Prefer lines that include our target name (title or expected), but allow other ll* lines if none match
			const _matchesName = nameRegex.test(line);
			allCandidates.push(line);
			if (Array.from(TYPE_SET).some(t => new RegExp(`\\b${t}\\b`, 'i').test(line))) typedCandidates.push(line);
		}
	});
	// De-dup while preserving order
	const uniq = (arr: string[]) => Array.from(new Set(arr));
	const primary = uniq(typedCandidates);
	const secondary = uniq(allCandidates.filter(l => !typedCandidates.includes(l)));

	// Stronger heuristic: prefer declaration-like lines first
	const expected = canonicalizeLl(expectedName || title) || '';
	const declLike = uniq(allCandidates).filter(l => /^(\s*function\b)/i.test(l) || /^\s*(?:integer|float|string|key|vector|rotation|list|void)\s+l{1,2}\w+\s*\(/i.test(l));

	let parsed: { name: string; returns: string; params: { name: string; type: string; default?: string }[] } | null = null;
	// If expectedName provided, bias towards candidates that contain it
	const prefer = (arr: string[]) => expectedName ? arr.filter(l => new RegExp(`\\b${expectedName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`).test(l)).concat(arr.filter(l => !new RegExp(`\\b${expectedName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`).test(l))) : arr;
	// First, try typed candidates that explicitly contain our name
	const namePrefer = (arr: string[]) => arr.filter(l => nameRegex.test(l)).concat(arr.filter(l => !nameRegex.test(l)));
	// Try decl-like first
	let quality = 0; // 3: decl-like typed, 2: typed candidate, 1: fallback usage/inferred
	for (const line of namePrefer(declLike)) {
		const p = tryParseSignature(line);
		if (p) {
			const canonExpected = canonicalizeLl(expected);
			if (!canonExpected || p.name.toLowerCase() === canonExpected.toLowerCase()) { parsed = p; quality = 3; break; }
		}
	}
	if (!parsed) for (const line of namePrefer(prefer(primary))) {
		const p = tryParseSignature(line);
		if (p) {
			const canonExpected = canonicalizeLl(expected);
			if (!canonExpected || p.name.toLowerCase() === canonExpected.toLowerCase()) { parsed = p; quality = 2; break; }
		}
	}
	if (!parsed) {
		for (const line of namePrefer(prefer(secondary))) {
			const p = tryParseSignature(line);
			if (p) {
				const canonExpected = canonicalizeLl(expected);
				if (!canonExpected || p.name.toLowerCase() === canonExpected.toLowerCase()) { parsed = p; quality = 2; break; }
			}
		}
	}
	if (!parsed) {
		for (const line of namePrefer(primary.concat(secondary))) {
			const s = line.trim().replace(/;\s*$/, '').replace(/^function\s+/, '');
			// 1) Pure signature without return type (function usage-like but standalone)
			const m = /^(l{1,2}\w+)\s*\(([^)]*)\)$/.exec(s);
			if (m) {
				const [, name, paramsRaw] = m;
				const params = paramsRaw.trim() ? parseParams(paramsRaw) : [];
				parsed = { name: canonicalizeLl(name)!, returns: 'void', params };
				quality = 1;
				break;
			}
			// 1b) If the line contains our target name, extract its specific arg list (ignore other calls)
			const mName = nameRegex.exec(s);
			if (mName) {
				const name = canonicalizeLl(mName[1])!;
				const idx = s.indexOf('(', mName.index);
				if (idx !== -1) {
					// scan to matching ')'
					let pd = 0; let i = idx; let end = -1;
					for (; i < s.length; i++) {
						const ch = s[i];
						if (ch === '(') pd++;
						else if (ch === ')') { pd--; if (pd === 0) { end = i; break; } }
					}
					if (end > idx) {
						const argsText = s.slice(idx + 1, end);
						const args = splitTopLevelArgs(argsText);
						if (args.length > 0) {
							const params = args.map((a, k) => ({ name: `arg${k+1}`, type: inferTypeFromArg(a) }));
							parsed = { name, returns: 'string', params };
							quality = 1;
							break;
						}
					}
				}
			}
			// 2) Extract from usage: something like llJsonGetValue(expr, [path]) inside a larger line
			const m2 = /(l{1,2}\w+)\s*\((.*)\)/.exec(s);
			if (m2) {
				const [, name, argsText] = m2;
				const args = splitTopLevelArgs(argsText);
				if (args.length > 0) {
					const params = args.map((a, idx) => ({ name: `arg${idx+1}`, type: inferTypeFromArg(a) }));
					parsed = { name: canonicalizeLl(name)!, returns: 'string', params };
					quality = 1;
					break;
				}
			}
		}
	}
	if (parsed) {
		// Normalize title-cased "LlFoo" to canonical "llFoo"
		const canonParsedName = canonicalizeLl(parsed.name)!;
		parsed = { ...parsed, name: canonParsedName };
		const canonExpected = canonicalizeLl(expectedName);
		if (canonExpected && /^ll\w+/i.test(canonExpected) && parsed.name.toLowerCase() !== canonExpected.toLowerCase()) {
			parsed = { ...parsed, name: canonExpected };
		}
	}
	if (parsed && (!parsed.returns || !TYPE_SET.has(parsed.returns))) {
		let ret: string | null = null;
		$('*').each((_: number, el: any) => {
			const text = $(el).text().trim();
			if (/^Returns?:/i.test(text)) {
				const next = $(el).next().text() || text.replace(/^Returns?:/i, '').trim();
				for (const t of TYPE_SET) { if (new RegExp(`\\b${t}\\b`, 'i').test(next)) { ret = t; break; } }
			}
		});
		if (ret) parsed.returns = ret;
	}
	// Best-effort signature string
	const signature = (primary[0] ?? secondary[0] ?? '') || '';
	return { title, signature, function: parsed, quality };
}

export async function parseConstantPage(html: string) {
	const $ = cheerio.load(html);
	const rawTitle = $('#firstHeading').text().trim();
	const _title = rawTitle;
	const nameUnderscore = rawTitle.replace(/\s+/g, '_');
	function escapeRegExp(s: string) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
	const namePattern = `${escapeRegExp(rawTitle)}|${escapeRegExp(nameUnderscore)}`;
	// Try infobox rows like: Type, Value
	let type: string | null = null;
	let value: string | number | null = null;
	$('table.infobox tr').each((_: number, tr: any) => {
		const cells = $(tr).find('th,td');
		if (cells.length >= 2) {
			const key = $(cells[0]).text().trim();
			const val = $(cells[cells.length - 1]).text().trim();
			if (/^Type$/i.test(key)) {
				const t = val.split(/\s+/)[0].toLowerCase();
				if (TYPE_SET.has(t)) type = t;
			}
			if (/^Value$/i.test(key)) {
				const vtxt = val.replace(/\[.*?\]/g, '').trim();
				value = vtxt;
			}
		}
	});
	// Fallback: look in first code/pre block for patterns like 'integer CONST = 42;'
	if (!type || value == null) {
		$('pre, code').each((_: number, el: any) => {
			if (type && value != null) return;
			const txt = $(el).text();
			const m = new RegExp(`(integer|float|string|key|vector|rotation|list)\\s+(${namePattern})\\s*=\\s*([^;]+);`, 'i').exec(txt || '');
			if (m) {
				const [, t, _nm, v] = m;
				type = (type ?? t.toLowerCase());
				value = v.trim();
			}
		});
	}
	// Fallback: scan mw-content-text for lines with Type: and Value:
	if (!type) {
		const body = $('#mw-content-text').text();
		const m = /Type\s*:\s*(integer|float|string|key|vector|rotation|list)/i.exec(body);
		if (m) type = m[1].toLowerCase();
	}
	// Fallback: detect type from categories (e.g., LSL Integer/Float/String Constants)
	if (!type) {
		const cats = $('#catlinks a').map((_: number, a: any) => $(a).text().toLowerCase()).get().join(' ');
		for (const t of TYPE_SET) {
			if (/(integer|float|string|key|vector|rotation|list)/.test(t)) {
				// no-op: t already valid
			}
			if (new RegExp(`\\b${t}\\b`).test(cats)) { type = t; break; }
		}
		// also search phrases like 'integer constants'
		if (!type) {
			if (/integer constant/.test(cats)) type = 'integer';
			else if (/float constant/.test(cats)) type = 'float';
			else if (/string constant/.test(cats)) type = 'string';
			else if (/key constant/.test(cats)) type = 'key';
			else if (/vector constant/.test(cats)) type = 'vector';
			else if (/rotation constant/.test(cats)) type = 'rotation';
			else if (/list constant/.test(cats)) type = 'list';
		}
	}
	// Fallback: intro paragraph mentioning '<type> constant'
	if (!type) {
		const intro = $('.mw-parser-output > p').first().text().toLowerCase();
		const m = /(integer|float|string|key|vector|rotation|list)[^\n.]{0,40}\bconstant/.exec(intro);
		if (m) type = m[1];
	}
	// Fallback: code snippet with type and name but without value
	if (!type) {
		const code = $('pre, code').first().text();
		const m2 = new RegExp(`(integer|float|string|key|vector|rotation|list)\\s+(${namePattern})\\b`, 'i').exec(code || '');
		if (m2) type = m2[1].toLowerCase();
	}
	if (value == null) {
		const body = $('#mw-content-text').text();
		const m = new RegExp(`(${namePattern})\\s*=\\s*([^\n;]+)`, 'i').exec(body);
		if (m) {
			value = m[2].trim();
		}
	}
	// Try to infer type from value if still unknown
	if (!type && value != null) {
		const s = String(value).trim();
		if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith('\'') && s.endsWith('\''))) {
			type = 'string';
		} else if (/^0x[0-9a-f]+$/i.test(s) || /^[+-]?\d+$/.test(s)) {
			type = 'integer';
		} else if (/^[+-]?(?:\d+\.?\d*|\d*\.\d+)(?:[eE][+-]?\d+)?$/.test(s)) {
			type = 'float';
		} else if (/^<\s*[+-]?\d+(?:\.\d+)?\s*,\s*[+-]?\d+(?:\.\d+)?\s*,\s*[+-]?\d+(?:\.\d+)?\s*>$/.test(s)) {
			type = 'vector';
		} else if (/^<\s*[+-]?\d+(?:\.\d+)?\s*,\s*[+-]?\d+(?:\.\d+)?\s*,\s*[+-]?\d+(?:\.\d+)?\s*,\s*[+-]?\d+(?:\.\d+)?\s*>$/.test(s)) {
			type = 'rotation';
		} else if (/^\[.*\]$/.test(s)) {
			type = 'list';
		}
	}
	// Last resort: treat ALL_CAPS identifiers as integer constants when type is unknown
	if (!type) {
		if (/^[A-Z_][A-Z0-9_]*$/.test(nameUnderscore)) type = 'integer'; else return null;
	}
	const normalized = normalizeConstantValue(type, value);
	return { name: nameUnderscore, type, value: normalized };
}

// Extract multiple constant definitions from arbitrary HTML (function/event pages)
function extractConstantsFromHtml(html: string): { name: string; type: string; value?: string | number }[] {
	const $ = cheerio.load(html);
	const found: { name: string; type: string; value?: string | number }[] = [];
	const pushConst = (name: string, type: string | null, value: string | number | null) => {
		if (!name || !/^[A-Z_][A-Z0-9_]*$/.test(name)) return;
		// Try infer type if missing
		let t = type;
		if (!t && value != null) {
			const s = String(value).trim();
			if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith('\'') && s.endsWith('\''))) t = 'string';
			else if (/^0x[0-9a-f]+$/i.test(s) || /^[+-]?\d+$/.test(s)) t = 'integer';
			else if (/^[+-]?(?:\d+\.?\d*|\d*\.\d+)(?:[eE][+-]?\d+)?$/.test(s)) t = 'float';
		}
		if (!t) t = 'integer';
		const normalized = normalizeConstantValue(t, value);
		found.push({ name, type: t, ...(normalized !== undefined ? { value: normalized } : {}) });
	};
	// Look at code-like blocks for typed definitions and #defines
	$('pre, code, tt').each((_: number, el: any) => {
		const txt = $(el).text();
		if (!txt) return;
		for (const raw of txt.split(/\r?\n/)) {
			const line = raw.trim();
			if (!line) continue;
			let m = /^(integer|float|string|key|vector|rotation|list)\s+([A-Z_][A-Z0-9_]*)\s*=\s*([^;]+);?/.exec(line);
			if (m) { pushConst(m[2], m[1].toLowerCase(), m[3]); continue; }
			m = /^#\s*define\s+([A-Z_][A-Z0-9_]*)\s+([^\s]+)\s*$/.exec(line);
			if (m) { pushConst(m[1], null, m[2]); continue; }
		}
	});
	// Specific fallback for LINKSETDATA_* constants appearing inline
	const body = $('#mw-content-text').text();
	if (body && /LINKSETDATA_/.test(body)) {
		// With explicit assignments
		const re = /(LINKSETDATA_[A-Z0-9_]+)\s*=\s*([0-9xXa-fA-F+-]+)/g;
		let mm: RegExpExecArray | null;
		while ((mm = re.exec(body))) {
			pushConst(mm[1], 'integer', mm[2]);
		}
		// Also collect bare mentions like "Returns LINKSETDATA_OK" with unknown value
		const names = new Set<string>();
		for (const txt of [body, $('pre, code, tt').map((_: number, el: any) => $(el).text()).get().join('\n')]) {
			const re2 = /\b(LINKSETDATA_[A-Z0-9_]+)\b/g;
			let m2: RegExpExecArray | null;
			while ((m2 = re2.exec(txt))) names.add(m2[1]);
		}
		for (const n of names) pushConst(n, 'integer', null);
	}
	// Dedupe by name
	const map = new Map<string, { name: string; type: string; value?: string | number }>();
	for (const c of found) if (!map.has(c.name)) map.set(c.name, c);
	return Array.from(map.values());
}

export async function parseEventPage(html: string) {
	const $ = cheerio.load(html);
	const rawTitle = $('#firstHeading').text().trim();
	const nameUnderscore = rawTitle.replace(/\s+/g, '_');
	const nameLowerUnderscore = nameUnderscore.toLowerCase();
	const displayNamePattern = `${rawTitle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}|${nameUnderscore.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`;
	let params: { name: string; type: string }[] | null = null;

	// Collect candidate lines from code/pre/tt that contain the event name and a param list
	const candidates: string[] = [];
	$('table.infobox pre, table.infobox code, #mw-content-text pre, #mw-content-text code, tt').each((_: number, el: any) => {
		const txt = $(el).text();
		if (!txt) return;
		for (const line of txt.split(/\r?\n/)) {
			if (new RegExp(`\\b(${displayNamePattern})\\s*\\(`, 'i').test(line) && Array.from(TYPE_SET).some(t => new RegExp(`\\b${t}\\b`).test(line))) {
				candidates.push(line.trim());
			}
		}
	});
	// Try to parse a signature line like: eventName(type a, type b)
	const nameRegex = new RegExp(`\\b(${displayNamePattern})\\s*\\(([^)]*)\\)` , 'i');
	for (const line of candidates) {
		const m = nameRegex.exec(line);
		if (m) {
			const paramsRaw = m[2].trim();
			const ps = paramsRaw ? parseParams(paramsRaw) : [];
			params = ps.map(p => ({ name: p.name, type: p.type }));
			break;
		}
	}
	// Fallback: scan entire code/pre blocks if not found
	if (!params) {
		$('pre, code').each((_: number, el: any) => {
			if (params) return;
			const txt = $(el).text();
			const m = nameRegex.exec(txt || '');
			if (m) {
				const paramsRaw = m[2].trim();
				const ps = paramsRaw ? parseParams(paramsRaw) : [];
				params = ps.map(p => ({ name: p.name, type: p.type }));
			}
		});
	}
	// Fallback: zero-arg events might appear without types nearby; accept empty params if name appears with ()
	if (!params) {
		const body = $('#mw-content-text').text();
		if (new RegExp(`\\b(${displayNamePattern})\\s*\\(\\s*\\)`, 'i').test(body)) params = [];
	}
	if (!params) return null;
	return { name: nameLowerUnderscore, params };
}

function getAllTypes(): string[] {
	// Stable order similar to common/lsl-defs.json
	const order = ['integer','float','string','key','vector','rotation','list','void'];
	return order.filter(t => TYPE_SET.has(t));
}

function getKeywords(): string[] {
	// Minimal set; can be extended later
	return ['if','else','for','while','do','return','state','default','jump','label'];
}

async function assembleDefs(): Promise<LslDefs> {
	const version = new Date().toISOString().slice(0, 10);
	// Functions
	const funcLinks = await listAllFunctionLinks();
	const pFunc = createProgress('functions', funcLinks.length);
	const functionsRaw: { fn: LslDefs['functions'][number]; q: number }[] = await mapLimit(funcLinks, CONCURRENCY, async (url, _i) => {
		try {
			const page = await fetchHtml(url);
			const slug = canonicalizeLl(url.replace(/^.*\//, ''));
			const info = await parseFunctionPage(page, slug);
			if (info.function) return { fn: info.function, q: info.quality ?? 0 } as any;
		} catch (e) {
			console.error(`[warn] function failed ${url}:`, (e as Error).message);
		}
		return null;
	}, () => pFunc.tick());
	pFunc.complete();
	// Dedupe and sort functions
	const funcMap = new Map<string, { f: LslDefs['functions'][number]; q: number }>();
	for (const item of functionsRaw) {
		const f = item.fn;
		const prev = funcMap.get(f.name);
		if (!prev) { funcMap.set(f.name, { f, q: item.q }); continue; }
		// Prefer higher quality (declaration-based) parses
		if (item.q > prev.q) { funcMap.set(f.name, { f, q: item.q }); continue; }
		if (item.q === prev.q) {
			// Prefer entry with more parameters (more complete parse)
			if ((f.params?.length || 0) > (prev.f.params?.length || 0)) { funcMap.set(f.name, { f, q: item.q }); continue; }
			// If equal params, prefer one with a more specific return type (not void)
			if ((f.params?.length || 0) === (prev.f.params?.length || 0)) {
				const rank = (t: string) => t && t !== 'void' ? 1 : 0;
				if (rank(f.returns) > rank(prev.f.returns)) { funcMap.set(f.name, { f, q: item.q }); continue; }
			}
		}
	}
	const functionsOut = Array.from(funcMap.values()).map(v => v.f).sort((a, b) => a.name.localeCompare(b.name));

	// Constants
	const constLinks = await listAllConstantLinks();
	const pConst = createProgress('constants', constLinks.length);
	const constants: LslDefs['constants'] = await mapLimit(constLinks, CONCURRENCY, async (url, _i) => {
		try {
			const page = await fetchHtml(url);
			const info = await parseConstantPage(page);
			if (info) return info;
		} catch (e) {
			console.error(`[warn] constant failed ${url}:`, (e as Error).message);
		}
		return null;
	}, () => pConst.tick());
	pConst.complete();
	// Build a map to merge constants from multiple sources; prefer entries that have a concrete value
	const constMap = new Map<string, LslDefs['constants'][number]>();
	for (const c of constants) {
		const existing = constMap.get(c.name);
		if (!existing) {
			constMap.set(c.name, c);
		} else if (existing.value === undefined && c.value !== undefined) {
			constMap.set(c.name, c);
		}
	}

	// Events
	const eventLinks = await listAllEventLinks();
	const pEvent = createProgress('events', eventLinks.length);
	const events: LslDefs['events'] = await mapLimit(eventLinks, CONCURRENCY, async (url, _i) => {
		try {
			const page = await fetchHtml(url);
			const info = await parseEventPage(page);
			if (info) return info;
		} catch (e) {
			console.error(`[warn] event failed ${url}:`, (e as Error).message);
		}
		return null;
	}, () => pEvent.tick());
	pEvent.complete();
	// Dedupe and sort events
	const eventMap = new Map<string, LslDefs['events'][number]>();
	for (const ev of events) if (!eventMap.has(ev.name)) eventMap.set(ev.name, ev);
	const eventsOut = Array.from(eventMap.values()).sort((a, b) => a.name.localeCompare(b.name));

	// Inline constants from function pages
	const pInlineFunc = createProgress('inline-consts(funcs)', funcLinks.length);
	const inlineConstFromFuncs = await mapLimit(funcLinks, CONCURRENCY, async (url, _i) => {
		try {
			const page = await fetchHtml(url);
			const found = extractConstantsFromHtml(page);
			return found;
		} catch (e) {
			console.error(`[warn] inline consts (func) failed ${url}:`, (e as Error).message);
		}
		return null;
	}, () => pInlineFunc.tick());
	pInlineFunc.complete();
	for (const arr of inlineConstFromFuncs) {
		for (const c of arr) {
			const existing = constMap.get(c.name);
			if (!existing) {
				constMap.set(c.name, c);
			} else if (existing.value === undefined && c.value !== undefined) {
				constMap.set(c.name, c);
			}
		}
	}

	// Inline constants from event pages
	const pInlineEvent = createProgress('inline-consts(events)', eventLinks.length);
	const inlineConstFromEvents = await mapLimit(eventLinks, CONCURRENCY, async (url, _i) => {
		try {
			const page = await fetchHtml(url);
			const found = extractConstantsFromHtml(page);
			return found;
		} catch (e) {
			console.error(`[warn] inline consts (event) failed ${url}:`, (e as Error).message);
		}
		return null;
	}, () => pInlineEvent.tick());
	pInlineEvent.complete();
	for (const arr of inlineConstFromEvents) {
		for (const c of arr) {
			const existing = constMap.get(c.name);
			if (!existing) {
				constMap.set(c.name, c);
			} else if (existing.value === undefined && c.value !== undefined) {
				constMap.set(c.name, c);
			}
		}
	}

	// Finalize constants
	const constantsOut = Array.from(constMap.values()).sort((a, b) => a.name.localeCompare(b.name));

	return {
		version,
		types: getAllTypes(),
		keywords: getKeywords(),
		constants: constantsOut,
		events: eventsOut,
		functions: functionsOut,
	};
}

async function main() {
	const which = process.argv[2] ?? 'list';
	if (which === 'list') {
		const html = await fetchHtml(CATEGORY_FUNCS);
		const links = await listFunctionLinks(html);
		console.log(JSON.stringify({ count: links.length, links }, null, 2));
	} else if (which.startsWith('get:')) {
		const slug = which.slice(4);
		const url = slug.startsWith('http') ? slug : `${WIKI_BASE}/wiki/${slug}`;
		const html = await fetchHtml(url);
		const info = await parseFunctionPage(html);
		console.log(JSON.stringify(info, null, 2));
	} else if (which.startsWith('funcjson:')) {
		const slug = which.slice(9);
		const url = slug.startsWith('http') ? slug : `${WIKI_BASE}/wiki/${slug}`;
		const html = await fetchHtml(url);
		const info = await parseFunctionPage(html, slug.startsWith('http') ? undefined : canonicalizeLl(slug));
		if (!info.function) {
			console.error('Could not parse function signature');
			process.exit(1);
		}
		console.log(JSON.stringify(info.function, null, 2));
	} else if (which.startsWith('funcdebug:')) {
		const slug = which.slice('funcdebug:'.length);
		const url = slug.startsWith('http') ? slug : `${WIKI_BASE}/wiki/${slug}`;
		const html = await fetchHtml(url);
		// Inline minimal copy of candidate extraction for debug output
		const $ = cheerio.load(html);
		const TYPE_SET_DBG = TYPE_SET;
		function _esc(s: string){return s.replace(/\n/g,'\\n');}
		const title = $('#firstHeading').text().trim();
		const candidates: string[] = [];
		const typed: string[] = [];
		$('table.infobox pre, table.infobox code, #mw-content-text pre, #mw-content-text code, tt').each((_: number, el: any) => {
			const txt = $(el).text();
			if (!txt) return;
			for (const rawLine of txt.split(/\r?\n/)) {
				const line = rawLine.trim();
				if (!line) continue;
				if (!/[()]/.test(line)) continue;
				if (!/\bll\w*\s*\(/i.test(line)) continue;
				candidates.push(line);
				if (Array.from(TYPE_SET_DBG).some(t => new RegExp(`\\b${t}\\b`, 'i').test(line))) typed.push(line);
			}
		});
		const parsed = candidates.map(l => ({ line: l, parsed: tryParseSignature(l) }));
		console.log(JSON.stringify({ title, candidates, typed, parsed }, null, 2));
	} else if (which.startsWith('functions')) {
		// Crawl first N functions into lsl-defs-like { functions: [...] }
		// Usage: functions or functions:10
		const m = /^functions(?::(\d+))?$/.exec(which);
		const limit = m && m[1] ? parseInt(m[1], 10) : 10;
		const html = await fetchHtml(CATEGORY_FUNCS);
		const links = await listFunctionLinks(html);
		const out: { name: string; returns: string; params: { name: string; type: string; default?: string }[] }[] = [];
		for (let i = 0; i < Math.min(limit, links.length); i++) {
			const url = links[i];
			const page = await fetchHtml(url);
			const info = await parseFunctionPage(page, canonicalizeLl(url.replace(/^.*\//, '')));
			if (info.function) out.push(info.function);
			// polite delay
			await new Promise(r => setTimeout(r, 200));
		}
		console.log(JSON.stringify({ version: 'crawl-dev', functions: out }, null, 2));
	} else if (which === 'functions-all') {
		// Crawl all functions in the category and write to out/lsl-defs.functions.json
		const links = await listAllFunctionLinks();
		const p = createProgress('functions', links.length);
		const out = await mapLimit(links, CONCURRENCY, async (url, _i) => {
			try {
				const page = await fetchHtml(url);
				const info = await parseFunctionPage(page, canonicalizeLl(url.replace(/^.*\//, '')));
				if (info.function) return info.function;
			} catch (e) {
				console.error(`[warn] failed ${url}:`, (e as Error).message);
			}
			return null;
		}, () => p.tick());
		p.complete();
		out.sort((a, b) => a.name.localeCompare(b.name));
		await fs.mkdir(path.resolve('out'), { recursive: true }).catch(() => void 0);
		const file = path.resolve('out', 'lsl-defs.functions.json');
		await fs.writeFile(file, JSON.stringify({ version: 'crawl-dev', functions: out }, null, 2), 'utf8');
		console.log(`Wrote ${out.length} functions to ${file}`);
	} else if (which.startsWith('constjson:')) {
		const slug = which.slice(10);
		const url = slug.startsWith('http') ? slug : `${WIKI_BASE}/wiki/${slug}`;
		const html = await fetchHtml(url);
		const info = await parseConstantPage(html);
		if (!info) { console.error('Could not parse constant'); process.exit(1); }
		console.log(JSON.stringify(info, null, 2));
	} else if (which.startsWith('extract-consts:')) {
		// Debug helper: extract inline constants from an arbitrary page (function/event/constant) and print them
		const slug = which.slice('extract-consts:'.length);
		const url = slug.startsWith('http') ? slug : `${WIKI_BASE}/wiki/${slug}`;
		const html = await fetchHtml(url);
		const found = extractConstantsFromHtml(html);
		console.log(JSON.stringify(found, null, 2));
	} else if (which === 'constants-list' || which.startsWith('constants-list:')) {
		const m = /^constants-list(?::(\d+))?$/.exec(which)!;
		const limit = m && m[1] ? parseInt(m[1], 10) : 20;
		const html = await fetchHtml(CATEGORY_CONSTS);
		const links = await listConstantLinks(html);
		console.log(JSON.stringify({ count: links.length, sample: links.slice(0, limit) }, null, 2));
	} else if (which === 'constants-all-list') {
		const links = await listAllConstantLinks();
		console.log(JSON.stringify({ count: links.length }, null, 2));
	} else if (which === 'constants-all') {
		const links = await listAllConstantLinks();
		const p = createProgress('constants', links.length);
		const out = await mapLimit(links, CONCURRENCY, async (url, _i) => {
			try {
				const page = await fetchHtml(url);
				const info = await parseConstantPage(page);
				if (info) return info;
			} catch (e) {
				console.error(`[warn] failed ${url}:`, (e as Error).message);
			}
			return null;
		}, () => p.tick());
		p.complete();
		out.sort((a, b) => a.name.localeCompare(b.name));
		await fs.mkdir(path.resolve('out'), { recursive: true }).catch(() => void 0);
		const file = path.resolve('out', 'lsl-defs.constants.json');
		await fs.writeFile(file, JSON.stringify({ version: 'crawl-dev', constants: out }, null, 2), 'utf8');
		console.log(`Wrote ${out.length} constants to ${file}`);
	} else if (which.startsWith('constants')) {
		const m = /^constants(?::(\d+))?$/.exec(which);
		const limit = m && m[1] ? parseInt(m[1], 10) : 10;
		const html = await fetchHtml(CATEGORY_CONSTS);
		const links = await listConstantLinks(html);
		const out: { name: string; type: string; value?: string | number }[] = [];
		for (let i = 0; i < Math.min(limit, links.length); i++) {
			const url = links[i];
			const page = await fetchHtml(url);
			const info = await parseConstantPage(page);
			if (info) out.push(info);
			await new Promise(r => setTimeout(r, 150));
		}
		console.log(JSON.stringify({ version: 'crawl-dev', constants: out }, null, 2));
	} else if (which === 'events-all') {
		const links = await listAllEventLinks();
		const p = createProgress('events', links.length);
		const out = await mapLimit(links, CONCURRENCY, async (url, _i) => {
			try {
				const page = await fetchHtml(url);
				const info = await parseEventPage(page);
				if (info) return info;
			} catch (e) {
				console.error(`[warn] failed ${url}:`, (e as Error).message);
			}
			return null;
		}, () => p.tick());
		p.complete();
		out.sort((a, b) => a.name.localeCompare(b.name));
		await fs.mkdir(path.resolve('out'), { recursive: true }).catch(() => void 0);
		const file = path.resolve('out', 'lsl-defs.events.json');
		await fs.writeFile(file, JSON.stringify({ version: 'crawl-dev', events: out }, null, 2), 'utf8');
		console.log(`Wrote ${out.length} events to ${file}`);
	} else if (which.startsWith('eventjson:')) {
		const slug = which.slice(10);
		const url = slug.startsWith('http') ? slug : `${WIKI_BASE}/wiki/${slug}`;
		const html = await fetchHtml(url);
		const info = await parseEventPage(html);
		if (!info) { console.error('Could not parse event'); process.exit(1); }
		console.log(JSON.stringify(info, null, 2));
	} else if (which.startsWith('events')) {
		const m = /^events(?::(\d+))?$/.exec(which);
		const limit = m && m[1] ? parseInt(m[1], 10) : 10;
		const html = await fetchHtml(CATEGORY_EVENTS);
		const links = await listEventLinks(html);
		const out: { name: string; params: { name: string; type: string }[] }[] = [];
		for (let i = 0; i < Math.min(limit, links.length); i++) {
			const url = links[i];
			const page = await fetchHtml(url);
			const info = await parseEventPage(page);
			if (info) out.push(info);
			await new Promise(r => setTimeout(r, 150));
		}
		console.log(JSON.stringify({ version: 'crawl-dev', events: out }, null, 2));
	} else if (which === 'defs-all') {
		const defs = await assembleDefs();
		await fs.mkdir(path.resolve('out'), { recursive: true }).catch(() => void 0);
		const file = path.resolve('out', 'lsl-defs.json');
		await fs.writeFile(file, JSON.stringify(defs, null, 2), 'utf8');
		console.log(`Wrote defs to ${file}`);
	} else {
		console.error('Usage:\n  lsl-crawler list\n  lsl-crawler get:llFunctionName\n  lsl-crawler funcjson:llFunctionName\n  lsl-crawler functions[:N]\n  lsl-crawler functions-all\n  lsl-crawler constjson:CONST\n  lsl-crawler constants[:N]\n  lsl-crawler constants-all\n  lsl-crawler eventjson:EVENT\n  lsl-crawler events[:N]\n  lsl-crawler events-all\n  lsl-crawler defs-all');
		process.exitCode = 2;
	}
}

if (import.meta.url === `file://${process.argv[1]}`) {
	main().catch(err => { console.error(err); process.exit(1); });
}
