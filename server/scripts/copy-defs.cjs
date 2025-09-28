#!/usr/bin/env node
/* eslint-env node */
/* globals console, __dirname */
const fs = require('node:fs');
const path = require('node:path');
const src = path.resolve(__dirname, '../../third_party/lsl-definitions/lsl_definitions.yaml');
const destDir = path.resolve(__dirname, '../out');
const dest = path.join(destDir, 'lsl_definitions.yaml');
try {
	fs.mkdirSync(destDir, { recursive: true });
	fs.copyFileSync(src, dest);
	console.log(`[server] copied defs to ${dest}`);
} catch (e) {
	console.warn('[server] copy defs failed:', e.message);
}
