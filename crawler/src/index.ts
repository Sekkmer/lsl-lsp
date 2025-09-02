#!/usr/bin/env node
import { fetch as undiciFetch } from 'undici';
import * as cheerio from 'cheerio';
import type { Element } from 'domhandler';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
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

// Resolve paths relative to the crawler package directory, not process.cwd(),
// so running from monorepo root won't pollute the root with an "out" folder.
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = path.resolve(__dirname, '..');
const CACHE_DIR = path.join(PKG_ROOT, 'out', 'cache');
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
	constants: { name: string; type: string; value?: number | string; doc?: string; deprecated?: boolean; wiki?: string }[];
	events: { name: string; params: { name: string; type: string; doc?: string }[]; doc?: string; wiki?: string }[];
	functions: { name: string; returns: string; params: { name: string; type: string; default?: string; doc?: string }[]; doc?: string; deprecated?: boolean; wiki?: string }[];
};

async function listFunctionLinks(html: string): Promise<string[]> {
	const $ = cheerio.load(html);
	// On the category page, function links are in the content area; avoid nav/sidebar
	const links: string[] = [];
	$('#mw-content-text a').each((_: number, a) => {
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
		$('#mw-content-text a').each((_: number, a) => {
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
	$('#mw-content-text .mw-category a, #mw-pages a').each((_: number, a) => {
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
	$('#mw-content-text .mw-category a, #mw-pages a').each((_: number, a) => {
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

const TYPE_SET = new Set(['integer', 'float', 'string', 'key', 'vector', 'rotation', 'list', 'void']);
// Only real LSL functions match this (e.g., llGetPos, llList2CSV). No underscores/hyphens/punctuation.
const VALID_FUNC_NAME = /^ll[A-Za-z0-9]+$/;

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

// --- Viewer keywords (LLSD XML) integration ---
const VIEWER_KEYWORDS_URL = process.env.LSL_VIEWER_KEYWORDS_URL || 'https://raw.githubusercontent.com/secondlife/viewer/master/indra/newview/app_settings/keywords_lsl_default.xml';

type ViewerFunction = { returns: string; params: { name: string; type: string; doc?: string }[]; doc?: string; deprecated?: boolean };
type ViewerConstant = { type: string; value?: number | string; doc?: string; deprecated?: boolean };
type ViewerEvent = { params: { name: string; type: string; doc?: string }[]; doc?: string };
type ViewerKeywords = {
	functions: Map<string, ViewerFunction>;
	constants: Map<string, ViewerConstant>;
	events: Map<string, ViewerEvent>;
};

function getDocFrom(obj: Record<string, unknown>): string | undefined {
	if (!obj || typeof obj !== 'object') return undefined;
	const keys = ['tooltip', 'desc', 'description', 'help', 'help_text'];
	for (const k of keys) {
		const v = (obj as Record<string, unknown>)[k];
		if (typeof v === 'string' && v.trim().length > 0) return v.trim();
	}
	return undefined;
}

type LLSD = string | number | boolean | null | LLSD[] | { [key: string]: LLSD };
function llsdGet(llsd: LLSD, next: string | number): LLSD {
	if (Array.isArray(llsd)) {
		if (typeof next === 'number' && next >= 0 && next < llsd.length) {
			return llsd[next];
		}
		return null;
	}
	if (typeof llsd === 'object' && llsd !== null) {
		return llsd[next];
	}
	return null;
}
function llsdGetObj(llsd: LLSD, next: string | number): { [key: string]: LLSD } | null {
	const obj = llsdGet(llsd, next);
	return (typeof obj === 'object' && obj !== null && !Array.isArray(obj)) ? obj : null;
}
function isMap(v: LLSD): v is { [key: string]: LLSD } { return typeof v === 'object' && v !== null && !Array.isArray(v); }
function toStringLLSD(v: LLSD | undefined): string { if (v == null) return ''; if (typeof v === 'string') return v; if (typeof v === 'number' || typeof v === 'boolean') return String(v); return ''; }
function isTruthyLLSD(v: LLSD | undefined): boolean { return v === true || v === 'true' || v === 1 || v === '1'; }

function parseLLSD(xml: string): LLSD {
	// Use cheerio in XML mode to preserve order; LLSD <map> alternates <key>name</key><value>
	const $ = cheerio.load(xml, { xmlMode: true });
	const root = $('llsd > map').get(0);

	function parseValue(node: typeof root): LLSD {
		const tag = (node && node.name || '').toLowerCase();
		if (tag === 'map') return parseMap(node);
		if (tag === 'array') return $(node).children().toArray().map(ch => parseValue(ch));
		if (tag === 'string' || tag === 'uuid') return $(node).text();
		if (tag === 'integer') { const t = $(node).text().trim(); const n = Number(t); return Number.isFinite(n) ? Math.trunc(n) : t; }
		if (tag === 'real') { const t = $(node).text().trim(); const n = Number(t); return Number.isFinite(n) ? n : t; }
		if (tag === 'boolean') { const t = $(node).text().trim().toLowerCase(); return t === 'true' || t === '1'; }
		if (tag === 'undef') return null;
		if (tag === 'key') return $(node).text();
		// Unknown: return text
		return $(node).text();
	}

	function parseMap(node: Element | undefined) {
		const obj: Record<string, LLSD> = {};
		const kids = $(node).children().toArray();
		for (let i = 0; i < kids.length; i++) {
			const k = kids[i];
			if (!k || k.name !== 'key') continue;
			const name = $(k).text();
			const v = kids[i + 1];
			if (!v) { obj[name] = null; continue; }
			obj[name] = parseValue(v);
			i++;
		}
		return obj;
	}


	if (!root) throw new Error('Invalid LLSD xml: root <llsd><map> not found');
	return parseMap(root);
}

async function fetchViewerKeywords(): Promise<ViewerKeywords> {
	const xml = await fetchHtml(VIEWER_KEYWORDS_URL);
	const top = parseLLSD(xml);
	const functions = new Map<string, ViewerFunction>();
	const constants = new Map<string, ViewerConstant>();
	const events = new Map<string, ViewerEvent>();
	// Events are nested under top.events map
	{
		const evs = llsdGetObj(top, 'events');
		if (evs) {
			for (const [ename, edataRaw] of Object.entries(evs)) {
				const ps: { name: string; type: string; doc?: string }[] = [];
				const argsVal = isMap(edataRaw) ? (edataRaw['arguments'] as LLSD) : undefined;
				if (Array.isArray(argsVal)) {
					for (const item of argsVal) {
						if (!isMap(item)) continue;
						const first = Object.entries(item as Record<string, LLSD>)[0] || [undefined, undefined];
						const pname = first[0] as string | undefined;
						const pinfo = first[1] as LLSD | undefined;
						if (!pname || !pinfo || !isMap(pinfo)) continue;
						const ptype = toStringLLSD(pinfo['type']).toLowerCase();
						const pdoc = getDocFrom(pinfo as unknown as Record<string, unknown>);
						ps.push({ name: pname, type: TYPE_SET.has(ptype) ? ptype : (ptype || 'string'), ...(pdoc ? { doc: pdoc } : {}) });
					}
				}
				const edoc = isMap(edataRaw) ? getDocFrom(edataRaw as unknown as Record<string, unknown>) : undefined;
				events.set(ename.toLowerCase(), { params: ps, ...(edoc ? { doc: edoc } : {}) });
			}
		}
	}
	// Top-level entries: functions (ll*)
	{
		const topMap: Record<string, LLSD> = isMap(top) ? (top as Record<string, LLSD>) : {};
		for (const [k, v] of Object.entries(topMap)) {
			if (k === 'events' || k === 'controls' || k === 'llsd-lsl-syntax-version' || k === 'default' || k === 'constants' || k === 'functions') continue;
			if (!isMap(v)) continue;
			if (/^ll/i.test(k) && (Object.prototype.hasOwnProperty.call(v, 'return') || Object.prototype.hasOwnProperty.call(v, 'arguments'))) {
				const returns = toStringLLSD(v['return'] || 'void').toLowerCase();
				const arrVal = v['arguments'];
				const arr = Array.isArray(arrVal) ? arrVal : [];
				const ps: { name: string; type: string; doc?: string }[] = [];
				for (const item of arr) {
					if (!isMap(item)) continue;
					const [pname, pinfo] = Object.entries(item as Record<string, LLSD>)[0] || [undefined, undefined];
					if (!pname || !pinfo || !isMap(pinfo)) continue;
					const ptype = toStringLLSD(pinfo['type']).toLowerCase();
					const pdoc = getDocFrom(pinfo as unknown as Record<string, unknown>);
					ps.push({ name: pname, type: TYPE_SET.has(ptype) ? ptype : (ptype || 'string'), ...(pdoc ? { doc: pdoc } : {}) });
				}
				// Some viewer builds may nest function entries deeper; perform a recursive fallback scan
				const seen = new Set<string>(Array.from(functions.keys()).map(k => k.toLowerCase()));
				function collectFunctions(node: LLSD) {
					if (!isMap(node)) return;
					for (const [k, v] of Object.entries(node as Record<string, LLSD>)) {
						if (!isMap(v)) { continue; }
						const isFuncKey = /^ll/i.test(k);
						const hasSig = Object.prototype.hasOwnProperty.call(v, 'return') || Object.prototype.hasOwnProperty.call(v, 'arguments');
						if (isFuncKey && hasSig) {
							const key = canonicalizeLl(k)!;
							if (!seen.has(key.toLowerCase())) {
								const returns = toStringLLSD(v['return'] || 'void').toLowerCase();
								const arrVal = v['arguments'];
								const arr = Array.isArray(arrVal) ? arrVal : [];
								const ps: { name: string; type: string; doc?: string }[] = [];
								for (const item of arr) {
									if (!isMap(item)) continue;
									const [pname, pinfo] = Object.entries(item as Record<string, LLSD>)[0] || [undefined, undefined];
									if (!pname || !pinfo || !isMap(pinfo)) continue;
									const ptype = toStringLLSD(pinfo['type']).toLowerCase();
									const pdoc = getDocFrom(pinfo as unknown as Record<string, unknown>);
									ps.push({ name: pname, type: TYPE_SET.has(ptype) ? ptype : (ptype || 'string'), ...(pdoc ? { doc: pdoc } : {}) });
								}
								const fdoc = getDocFrom(v as unknown as Record<string, unknown>);
								const deprecated = isTruthyLLSD(v['deprecated']);
								functions.set(key, { returns: TYPE_SET.has(returns) ? returns : returns || 'void', params: ps, ...(fdoc ? { doc: fdoc } : {}), ...(deprecated ? { deprecated: true } : {}) });
								seen.add(key.toLowerCase());
							}
						}
						collectFunctions(v);
					}
				}
				collectFunctions(top);
				const fdoc = getDocFrom(v as unknown as Record<string, unknown>);
				const deprecated = isTruthyLLSD(v['deprecated']);
				functions.set(canonicalizeLl(k)!, { returns: TYPE_SET.has(returns) ? returns : returns || 'void', params: ps, ...(fdoc ? { doc: fdoc } : {}), ...(deprecated ? { deprecated: true } : {}) });
				continue;
			}
		}
	}
	// Also support viewer XML variants where functions are under an explicit 'functions' map
	{
		const fns = llsdGetObj(top, 'functions');
		if (fns) {
			for (const [fname, fdata] of Object.entries(fns)) {
				if (!isMap(fdata)) continue;
				const hasSig = Object.prototype.hasOwnProperty.call(fdata, 'return') || Object.prototype.hasOwnProperty.call(fdata, 'arguments');
				if (!/^ll/i.test(fname) || !hasSig) continue;
				const returns = toStringLLSD(fdata['return'] || 'void').toLowerCase();
				const arrVal = fdata['arguments'];
				const arr = Array.isArray(arrVal) ? arrVal : [];
				const ps: { name: string; type: string; doc?: string }[] = [];
				for (const item of arr) {
					if (!isMap(item)) continue;
					const [pname, pinfo] = Object.entries(item as Record<string, LLSD>)[0] || [undefined, undefined];
					if (!pname || !pinfo || !isMap(pinfo)) continue;
					const ptype = toStringLLSD(pinfo['type']).toLowerCase();
					const pdoc = getDocFrom(pinfo as unknown as Record<string, unknown>);
					ps.push({ name: pname, type: TYPE_SET.has(ptype) ? ptype : (ptype || 'string'), ...(pdoc ? { doc: pdoc } : {}) });
				}
				const fdoc = getDocFrom(fdata as unknown as Record<string, unknown>);
				const key = canonicalizeLl(fname)!;
				const deprecated = isTruthyLLSD(fdata['deprecated']);
				if (!functions.has(key)) {
					functions.set(key, { returns: TYPE_SET.has(returns) ? returns : returns || 'void', params: ps, ...(fdoc ? { doc: fdoc } : {}), ...(deprecated ? { deprecated: true } : {}) });
				}
			}
		}
	}

	// Constants live under the 'constants' map
	{
		const cs = llsdGetObj(top, 'constants');
		if (cs) {
			for (const [name, v] of Object.entries(cs)) {
				if (!isMap(v)) continue;
				if (!Object.prototype.hasOwnProperty.call(v, 'type')) continue;
				const t = toStringLLSD(v['type']).toLowerCase();
				const normalized = normalizeConstantValue(t, v['value'] as string | number | null);
				const cdoc = getDocFrom(v as unknown as Record<string, unknown>);
				const deprecated = isTruthyLLSD(v['deprecated']);
				constants.set(name, { type: TYPE_SET.has(t) ? t : t, ...(normalized !== undefined ? { value: normalized } : {}), ...(cdoc ? { doc: cdoc } : {}), ...(deprecated ? { deprecated: true } : {}) });
			}
		}
	}
	return { functions, constants, events };
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
	let inStr: '"' | '\'' | null = null;
	for (let i = 0; i < argText.length; i++) {
		const ch = argText[i];
		if (inStr) {
			buf += ch;
			if (ch === '\\') { i++; if (i < argText.length) buf += argText[i]; continue; }
			if (ch === inStr) inStr = null;
			continue;
		}
		if (ch === '"' || ch === '\'') { inStr = ch; buf += ch; continue; }
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
	if (!s) return 'any';
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

export async function parseFunctionPage(html: string, expectedName?: string): Promise<{
	title: string;
	signature: string;
	function: { name: string; returns: string; params: { name: string; type: string; default?: string }[]; doc?: string; wiki?: string } | null;
	quality?: number;
}> {
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
	$('table.infobox pre, table.infobox code, #mw-content-text pre, #mw-content-text code, tt').each((_: number, el) => {
		const txt = $(el).text();
		if (!txt) return;
		for (const rawLine of txt.split(/\r?\n/)) {
			const line = rawLine.trim();
			if (!line) continue;
			if (!/[()]/.test(line)) continue;
			// Accept typical ll* lines (ll + Uppercase), or nameRegex lines (to catch page name variants)
			if (!(/\bll[A-Z]\w*\s*\(/.test(line) || nameRegex.test(line))) continue;
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

	let parsed: { name: string; returns: string; params: { name: string; type: string; default?: string }[]; doc?: string; wiki?: string } | null = null;
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
							const params = args.map((a, k) => ({ name: `arg${k + 1}`, type: inferTypeFromArg(a) }));
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
					const params = args.map((a, idx) => ({ name: `arg${idx + 1}`, type: inferTypeFromArg(a) }));
					parsed = { name: canonicalizeLl(name)!, returns: 'string', params };
					quality = 1;
					break;
				}
			}
		}
	}
	if (parsed) {
		// Drop known bogus wiki parse: a stray 'la' that is not an LSL function
		if (parsed.name === 'la') { parsed = null; }
	}
	if (parsed) {
		// Normalize title-cased "LlFoo" to canonical "llFoo"
		const canonParsedName = canonicalizeLl(parsed.name)!;
		parsed = { name: canonParsedName, returns: parsed.returns, params: parsed.params };
		// Only allow overriding to the page slug if it's a valid LSL function identifier
		const canonExpected = canonicalizeLl(expectedName);
		const shouldOverride = !!(canonExpected && VALID_FUNC_NAME.test(canonExpected) && parsed.name.toLowerCase() !== canonExpected.toLowerCase());
		if (shouldOverride) {
			parsed = { name: canonExpected!, returns: parsed.returns, params: parsed.params };
		}
		// Final guard: drop any function whose name contains invalid characters
		if (!VALID_FUNC_NAME.test(parsed.name)) {
			parsed = null;
		}
	}
	if (parsed && (!parsed.returns || !TYPE_SET.has(parsed.returns))) {
		let ret: string | null = null;
		$('*').each((_: number, el) => {
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

	// Attempt to extract a short description from the wiki page content
	function extractWikiDoc(): string | undefined {
		// Prefer the first substantial paragraph in article content
		const paras = $('#mw-content-text .mw-parser-output > p').toArray();
		for (const p of paras) {
			let text = $(p).text() || '';
			text = text.replace(/\[[0-9]+\]/g, '').replace(/\s+/g, ' ').trim();
			// Skip empty or boilerplate paragraphs
			if (!text || /This article is a stub/i.test(text)) continue;
			if (text.length >= 40 || /\./.test(text)) return text;
		}
		return undefined;
	}

	if (parsed) {
		const wikiDoc = extractWikiDoc();
		if (wikiDoc && (!('doc' in parsed) || !parsed.doc)) {
			parsed.doc = wikiDoc;
		}
	}

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
	$('table.infobox tr').each((_: number, tr) => {
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
		$('pre, code').each((_: number, el) => {
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
		const cats = $('#catlinks a').map((_: number, a) => $(a).text().toLowerCase()).get().join(' ');
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
	// Try to get a short description from the wiki page
	let doc: string | undefined;
	const paras = $('#mw-content-text .mw-parser-output > p').toArray();
	for (const p of paras) {
		let text = $(p).text() || '';
		text = text.replace(/\[[0-9]+\]/g, '').replace(/\s+/g, ' ').trim();
		if (!text || /This article is a stub/i.test(text)) continue;
		if (text.length >= 25 || /\./.test(text)) { doc = text; break; }
	}

	const normalized = normalizeConstantValue(type, value);
	return { name: nameUnderscore, type, value: normalized, ...(doc ? { doc } : {}) };
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
	$('pre, code, tt').each((_: number, el) => {
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
		for (const txt of [body, $('pre, code, tt').map((_: number, el) => $(el).text()).get().join('\n')]) {
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
	$('table.infobox pre, table.infobox code, #mw-content-text pre, #mw-content-text code, tt').each((_: number, el) => {
		const txt = $(el).text();
		if (!txt) return;
		for (const line of txt.split(/\r?\n/)) {
			if (new RegExp(`\\b(${displayNamePattern})\\s*\\(`, 'i').test(line) && Array.from(TYPE_SET).some(t => new RegExp(`\\b${t}\\b`).test(line))) {
				candidates.push(line.trim());
			}
		}
	});
	// Try to parse a signature line like: eventName(type a, type b)
	const nameRegex = new RegExp(`\\b(${displayNamePattern})\\s*\\(([^)]*)\\)`, 'i');
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
		$('pre, code').each((_: number, el) => {
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

	// Try to extract an event description paragraph
	let doc: string | undefined;
	const paras = $('#mw-content-text .mw-parser-output > p').toArray();
	for (const p of paras) {
		let text = $(p).text() || '';
		text = text.replace(/\[[0-9]+\]/g, '').replace(/\s+/g, ' ').trim();
		if (!text || /This article is a stub/i.test(text)) continue;
		if (text.length >= 25 || /\./.test(text)) { doc = text; break; }
	}

	return { name: nameLowerUnderscore, params, ...(doc ? { doc } : {}) };
}

function getAllTypes(): string[] {
	// Stable order similar to common/lsl-defs.json
	const order = ['integer', 'float', 'string', 'key', 'vector', 'rotation', 'list', 'void'];
	return order.filter(t => TYPE_SET.has(t));
}

function getKeywords(): string[] {
	// Minimal set; can be extended later
	return ['if', 'else', 'for', 'while', 'do', 'return', 'state', 'default', 'jump', 'label'];
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
			if (info.function && VALID_FUNC_NAME.test(info.function.name)) {
				info.function.wiki = url;
				return { fn: info.function, q: info.quality ?? 0 };
			}
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
	const functionsOut = Array.from(funcMap.values())
		.map(v => v.f)
		.filter(f => VALID_FUNC_NAME.test(f.name))
		.sort((a, b) => a.name.localeCompare(b.name));

	// Constants
	const constLinks = await listAllConstantLinks();
	const pConst = createProgress('constants', constLinks.length);
	const constants: LslDefs['constants'] = await mapLimit(constLinks, CONCURRENCY, async (url, _i) => {
		try {
			const page = await fetchHtml(url);
			const info = await parseConstantPage(page);
			if (info) return { ...(info), wiki: url };
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
			if (info) return { ...(info), wiki: url };
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
	// Merge in viewer keywords (LLSD XML) tooltips/docs
	try {
		const viewer = await fetchViewerKeywords();
		// Merge function docs and signatures
		const fMap = new Map<string, LslDefs['functions'][number]>();
		for (const f of functionsOut) fMap.set(f.name, f);
		for (const [name, vf] of viewer.functions) {
			const key = canonicalizeLl(name)!;
			const cur = fMap.get(key);
			if (!cur) continue;
			// Merge returns
			if ((!cur.returns || cur.returns === 'void') && vf.returns && vf.returns !== 'void') cur.returns = vf.returns;
			// Merge params by index
			if (vf.params && vf.params.length > 0) {
				const max = Math.max(cur.params?.length || 0, vf.params.length);
				const merged: { name: string; type: string; default?: string; doc?: string }[] = [];
				for (let i = 0; i < max; i++) {
					const a = cur.params?.[i];
					const b = vf.params[i];
					if (a && b) {
						const preferViewer = !a.name || /^arg\d+$/i.test(a.name);
						let nameFinal = preferViewer ? (b.name || a.name || `arg${i + 1}`) : a.name;
						if (preferViewer && nameFinal) nameFinal = nameFinal.toLowerCase();
						const typeFinal = a.type || b.type;
						merged.push({ name: nameFinal, type: typeFinal, ...(a.default ? { default: a.default } : {}), ...(b.doc ? { doc: b.doc } : {}) });
					} else if (a && !b) {
						merged.push(a);
					} else if (!a && b) {
						const n = typeof b.name === 'string' ? b.name.toLowerCase() : `arg${i + 1}`;
						merged.push({ name: n, type: b.type, ...(b.doc ? { doc: b.doc } : {}) });
					}
				}
				cur.params = merged;
			}
			// Merge doc/deprecated
			if (vf.doc) {
				if (!cur.doc || cur.doc.length < vf.doc.length) cur.doc = vf.doc;
			}
			if (vf.deprecated) cur.deprecated = true;
			// keep wiki link if present
			fMap.set(key, cur);
		}
		// Apply merged function map order-stably
		const functionsMerged = Array.from(fMap.values()).sort((a, b) => a.name.localeCompare(b.name));

		// Merge constants
		const cMapOut = new Map<string, LslDefs['constants'][number]>();
		for (const c of constantsOut) cMapOut.set(c.name, c);
		for (const [name, vc] of viewer.constants) {
			const cur = cMapOut.get(name);
			if (!cur) {
				// Only add if we have type at minimum
				if (vc.type) cMapOut.set(name, { name, type: vc.type, ...(vc.value !== undefined ? { value: vc.value } : {}), ...(vc.doc ? { doc: vc.doc } : {}), ...(vc.deprecated ? { deprecated: true } : {}) });
				continue;
			}
			// Prefer value from XML when missing in current
			if ((cur).value === undefined && vc.value !== undefined) cur.value = vc.value;
			// Prefer concrete type when ours is missing
			if (!cur.type && vc.type) cur.type = vc.type;
			if (vc.doc) {
				if (!cur.doc || cur.doc.length < vc.doc.length) cur.doc = vc.doc;
			}
			if (vc.deprecated) cur.deprecated = true;
			cMapOut.set(name, cur);
		}
		const constantsMerged = Array.from(cMapOut.values()).sort((a, b) => a.name.localeCompare(b.name));

		// Merge events
		const eMapOut = new Map<string, LslDefs['events'][number]>();
		for (const e of eventsOut) eMapOut.set(e.name, e);
		for (const [name, ve] of viewer.events) {
			const cur = eMapOut.get(name);
			if (!cur) continue;
			if (ve.params && ve.params.length > 0) {
				const max = Math.max(cur.params?.length || 0, ve.params.length);
				const merged: { name: string; type: string; doc?: string }[] = [];
				for (let i = 0; i < max; i++) {
					const a = cur.params?.[i];
					const b = ve.params[i];
					if (a && b) {
						const preferViewer = !a.name || /^arg\d+$/i.test(a.name);
						let nameFinal = preferViewer ? (b.name || a.name || `arg${i + 1}`) : a.name;
						nameFinal = (nameFinal || '').toLowerCase();
						const typeFinal = a.type || b.type;
						merged.push({ name: nameFinal, type: typeFinal, ...(b.doc ? { doc: b.doc } : {}) });
					} else if (a && !b) {
						merged.push({ ...a, name: (a.name || `arg${i + 1}`).toLowerCase() });
					} else if (!a && b) {
						const n = typeof b.name === 'string' ? b.name.toLowerCase() : `arg${i + 1}`;
						merged.push({ name: n, type: b.type, ...(b.doc ? { doc: b.doc } : {}) });
					}
				}
				cur.params = merged;
			}
			if (ve.doc && (!cur.doc || cur.doc.length < ve.doc.length)) cur.doc = ve.doc;
			eMapOut.set(name, cur);
		}
		const eventsMerged = Array.from(eMapOut.values()).sort((a, b) => a.name.localeCompare(b.name));

		// Ensure wiki links are present for all entries (use captured URL or fallback to wiki by name)
		const withWikiFuncs = functionsMerged.map(f => ({
			...f,
			wiki: f.wiki || `${WIKI_BASE}/wiki/${encodeURIComponent(f.name)}`
		}));
		const withWikiConsts = constantsMerged.map(c => ({
			...c,
			wiki: c.wiki || `${WIKI_BASE}/wiki/${encodeURIComponent(c.name)}`
		}));
		const withWikiEvents = eventsMerged.map(e => ({
			...e,
			wiki: e.wiki || `${WIKI_BASE}/wiki/${encodeURIComponent(e.name)}`
		}));

		return {
			version,
			types: getAllTypes(),
			keywords: getKeywords(),
			constants: withWikiConsts,
			events: withWikiEvents,
			functions: withWikiFuncs,
		};
	} catch (e) {
		if (VERBOSE) console.error('[warn] viewer keywords merge failed:', (e as Error).message);
		// Fall back to wiki-only data
		// Ensure wiki links exist even in fallback mode
		const withWikiFuncs = functionsOut.map(f => ({ ...f, wiki: f.wiki || `${WIKI_BASE}/wiki/${encodeURIComponent(f.name)}` }));
		const withWikiConsts = constantsOut.map(c => ({ ...c, wiki: c.wiki || `${WIKI_BASE}/wiki/${encodeURIComponent(c.name)}` }));
		const withWikiEvents = eventsOut.map(e => ({ ...e, wiki: e.wiki || `${WIKI_BASE}/wiki/${encodeURIComponent(e.name)}` }));
		return {
			version,
			types: getAllTypes(),
			keywords: getKeywords(),
			constants: withWikiConsts,
			events: withWikiEvents,
			functions: withWikiFuncs,
		};
	}
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
		function _esc(s: string) { return s.replace(/\n/g, '\\n'); }
		const title = $('#firstHeading').text().trim();
		const candidates: string[] = [];
		const typed: string[] = [];
		$('table.infobox pre, table.infobox code, #mw-content-text pre, #mw-content-text code, tt').each((_: number, el) => {
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
	} else if (which.startsWith('viewer:')) {
		// Debug viewer (LLSD XML) entry for a single function/constant/event
		// Usage:
		//	 viewer:func:<llFunctionName>
		//	 viewer:const:<CONSTANT_NAME>
		//	 viewer:event:<event_name>
		//	 viewer:<name>	(best-effort auto-detect between function/constant)
		const rest = which.slice('viewer:'.length);
		if (rest.startsWith('search:')) {
			const q = rest.slice('search:'.length).toLowerCase();
			const xml = await fetchHtml(VIEWER_KEYWORDS_URL);
			const top = parseLLSD(xml);
			const topObj = isMap(top) ? top : {};
			const keysTop = Object.keys(topObj);
			const keysFuncs = Object.keys(llsdGetObj(top, 'functions') || {});
			const events = Object.keys(llsdGetObj(top, 'events') || {});
			const match = (arr: string[]) => arr.filter(k => k.toLowerCase().includes(q)).sort();
			console.log(JSON.stringify({ query: q, functions: match(keysTop.filter(k => /^ll/i.test(k)).concat(keysFuncs)), constants: match(Object.keys(llsdGetObj(top, 'constants') || {})), events: match(events) }, null, 2));
			return;
		}
		const parts = rest.split(':');
		if (parts[0] === 'stats') {
			const xml = await fetchHtml(VIEWER_KEYWORDS_URL);
			const top = parseLLSD(xml);
			const parsed = await fetchViewerKeywords();
			const topKeys = Object.keys(top || {});
			const funcTop = topKeys.filter(k => /^ll/i.test(k));
			const funcMap = Object.keys(llsdGetObj(top, 'functions') || {});
			const sampleTop = funcTop.slice(0, 10);
			const sampleMap = funcMap.slice(0, 10);
			console.log(JSON.stringify({
				functions: parsed.functions.size,
				constants: parsed.constants.size,
				events: parsed.events.size,
				has_llGetPos: parsed.functions.has('llGetPos'),
				topLevelFuncKeys: sampleTop,
				functionsMapKeys: sampleMap,
				flags: { hasTopFunctions: !!llsdGetObj(top, 'functions'), topFuncCount: funcTop.length, mapFuncCount: funcMap.length }
			}, null, 2));
			return;
		}
		let kind: 'func' | 'const' | 'event' | 'auto' = 'auto';
		let name = parts[0];
		if (parts.length >= 2) {
			const k = parts[0].toLowerCase();
			kind = (k === 'func' || k === 'const' || k === 'event' || k === 'auto') ? k : 'auto';
			name = parts.slice(1).join(':');
		}
		const xml = await fetchHtml(VIEWER_KEYWORDS_URL);
		const top = parseLLSD(xml);
		const parsed = await fetchViewerKeywords();
		interface ViewerLookupResult {
			name: string;
			kind?: 'func' | 'const' | 'event';
			raw?: LLSD | null;
			parsed?: ViewerFunction | ViewerConstant | ViewerEvent | null;
			suggestions?: string[];
			resolvedName?: string;
			rawXmlPath?: string[];
			error?: string;
		}
		const result: ViewerLookupResult = { name, kind: kind === 'auto' ? undefined : kind };
		const cName = canonicalizeLl(name);
		const evMap = llsdGetObj(top, 'events');
		const isEvent = kind === 'event' || (kind === 'auto' && evMap && Object.prototype.hasOwnProperty.call(evMap, name));
		if (isEvent) {
			const raw = evMap?.[name];
			const p = parsed.events.get(name) || parsed.events.get(name.toLowerCase());
			result.kind = 'event';
			result.raw = raw ?? null;
			result.parsed = p ?? null;
			result.rawXmlPath = ['events', name];
			console.log(JSON.stringify(result, null, 2));
			return;
		}
		// Non-events live at the top level map
		let rawEntry: LLSD = null;
		if (kind === 'func' || kind === 'auto') {
			// try exact, canonical, and then case-insensitive resolution
			rawEntry = (cName && llsdGetObj(top, cName)) ?? llsdGetObj(top, name);
			let resolvedKey: string | undefined = undefined;
			if (!rawEntry) {
				const topObj = isMap(top) ? top : {};
				const keys = Object.keys(topObj);
				const target = (cName || name || '').toLowerCase();
				const hit = keys.find(k => k.toLowerCase() === target) || keys.find(k => k.toLowerCase().includes(target));
				if (hit) { resolvedKey = hit; rawEntry = llsdGetObj(top, hit); }
			}
			// recursive find in case functions are nested
			if (!rawEntry) {
				let foundPath: string[] | null = null;
				function findFunc(obj: LLSD, path: string[]): { [key: string]: LLSD } | null {
					if (!isMap(obj)) return null;
					if (Object.prototype.hasOwnProperty.call(obj, 'return') || Object.prototype.hasOwnProperty.call(obj, 'arguments')) {
						// path key name check
						const lastKey = path[path.length - 1] || '';
						const lk = lastKey.toLowerCase();
						const target = (cName || name || '').toLowerCase();
						if (lk === target) return obj;
					}
					for (const [k, v] of Object.entries(obj)) {
						if (isMap(v)) {
							const res = findFunc(v, path.concat(k));
							if (res) { foundPath = path.concat(k); return res; }
						}
					}
					return null;
				}
				const rec = findFunc(top, []);
				if (rec) { rawEntry = rec; resolvedKey = (foundPath || []).slice(-1)[0]; result.rawXmlPath = foundPath || undefined; }
			}
			const looksFunc = rawEntry && (Object.prototype.hasOwnProperty.call(rawEntry, 'return') || Object.prototype.hasOwnProperty.call(rawEntry, 'arguments'));
			if (looksFunc || kind === 'func') {
				// try canonical, resolvedKey, and exact name in parsed map
				const keyCandidates = [cName, resolvedKey && canonicalizeLl(resolvedKey), name].filter(Boolean) as string[];
				let p = undefined;
				for (const k of keyCandidates) { p = parsed.functions.get(k); if (p) break; }
				if (!p) {
					// case-insensitive fallback
					const low = (cName || name || '').toLowerCase();
					for (const k of parsed.functions.keys()) { if (k.toLowerCase() === low) { p = parsed.functions.get(k); break; } }
				}
				result.kind = 'func';
				result.raw = rawEntry ?? null;
				result.parsed = p ?? null;
				if (!result.raw) {
					const topObj = isMap(top) ? top : {};
					const keys = Object.keys(topObj);
					const target = (cName || name || '').toLowerCase();
					result.suggestions = keys.filter(k => k.toLowerCase() === target || k.toLowerCase().includes(target)).slice(0, 20);
					result.resolvedName = cName || name;
				}
				result.rawXmlPath = result.rawXmlPath || [resolvedKey || cName || name];
				console.log(JSON.stringify(result, null, 2));
				return;
			}
		}
		if (kind === 'const' || kind === 'auto') {
			// constants under top.constants map
			const cMap = llsdGetObj(top, 'constants');
			rawEntry = cMap?.[name] ?? null;
			let resolvedKey: string | undefined = undefined;
			if (!rawEntry) {
				const keys = Object.keys(cMap || {});
				const target = (name || '').toLowerCase();
				const hit = keys.find(k => k.toLowerCase() === target) || keys.find(k => k.toLowerCase().includes(target));
				if (hit) { resolvedKey = hit; rawEntry = (cMap || {})[hit] ?? null; }
			}
			const looksConst = rawEntry && Object.prototype.hasOwnProperty.call(rawEntry, 'type');
			if (looksConst || kind === 'const') {
				const keyCandidates = [name, resolvedKey].filter(Boolean) as string[];
				let p = undefined;
				for (const k of keyCandidates) { p = parsed.constants.get(k!); if (p) break; }
				result.kind = 'const';
				result.raw = rawEntry ?? null;
				result.parsed = p ?? null;
				if (!result.raw) {
					const keys = Object.keys(cMap || {});
					const target = (name || '').toLowerCase();
					result.suggestions = keys.filter(k => k.toLowerCase() === target || k.toLowerCase().includes(target)).slice(0, 20);
				}
				result.rawXmlPath = ['constants', resolvedKey || name];
				console.log(JSON.stringify(result, null, 2));
				return;
			}
		}
		result.error = 'Not found or unknown kind';
		console.log(JSON.stringify(result, null, 2));
		process.exitCode = 1;
	} else if (which === 'defs-all') {
		const defs = await assembleDefs();
		await fs.mkdir(path.resolve('out'), { recursive: true }).catch(() => void 0);
		const file = path.join(PKG_ROOT, 'out', 'lsl-defs.json');
		await fs.writeFile(file, JSON.stringify(defs, null, 2), 'utf8');
		console.log(`Wrote defs to ${file}`);
	} else {
		console.error('Usage:\n	lsl-crawler list\n	lsl-crawler get:llFunctionName\n	lsl-crawler funcjson:llFunctionName\n	lsl-crawler functions[:N]\n	lsl-crawler functions-all\n	lsl-crawler constjson:CONST\n	lsl-crawler constants[:N]\n	lsl-crawler constants-all\n	lsl-crawler eventjson:EVENT\n	lsl-crawler events[:N]\n	lsl-crawler events-all\n	lsl-crawler defs-all');
		process.exitCode = 2;
	}
}

if (import.meta.url === `file://${process.argv[1]}`) {
	main().catch(err => { console.error(err); process.exit(1); });
}
