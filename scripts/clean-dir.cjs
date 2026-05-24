/* eslint-env node */
/* globals process */
const fs = require('node:fs');
const path = require('node:path');

const dir = process.argv[2];
if (!dir) {
	console.error('Usage: node scripts/clean-dir.cjs <dir>');
	process.exitCode = 1;
} else {
	fs.rmSync(path.resolve(process.cwd(), dir), { recursive: true, force: true });
}
