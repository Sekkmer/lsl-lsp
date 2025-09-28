#!/usr/bin/env node
import process from 'node:process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '..');

const SOURCE_PATH = path.join(REPO_ROOT, 'third_party', 'lsl-definitions', 'lsl_definitions.yaml');
const DEST_PATHS = [
	path.join(REPO_ROOT, 'client-vscode', 'common', 'lsl_definitions.yaml'),
];

async function copyDefinitions() {
	const data = await fs.readFile(SOURCE_PATH);
	await Promise.all(DEST_PATHS.map(async dest => {
		await fs.mkdir(path.dirname(dest), { recursive: true });
		await fs.writeFile(dest, data);
		globalThis.console?.log(`[defs] copied ${path.relative(REPO_ROOT, SOURCE_PATH)} -> ${path.relative(REPO_ROOT, dest)}`);
	}));
}

copyDefinitions().catch(err => {
	globalThis.console?.error('[defs] copy failed:', err);
	process.exitCode = 1;
});
