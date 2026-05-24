#!/usr/bin/env node
/* eslint-env node */
/* globals console, __dirname */
const fs = require('node:fs');
const path = require('node:path');
const src = path.resolve(__dirname, '../../../third_party/lsl-definitions/lsl_definitions.yaml');
const dest = process.argv[2]
	? path.resolve(process.cwd(), process.argv[2])
	: path.resolve(__dirname, '../out/lsl_definitions.yaml');
const destDir = path.dirname(dest);
try {
	fs.mkdirSync(destDir, { recursive: true });
	fs.copyFileSync(src, dest);
	console.log(`[defs] copied defs to ${dest}`);
} catch (e) {
	console.warn('[defs] copy defs failed:', e.message);
}
