#!/usr/bin/env node
/* eslint-env node */
const fs = require('node:fs');
const path = require('node:path');

function main() {
	const extRoot = process.cwd();
	const defsPath = path.join(extRoot, 'common', 'lsl-defs.json');
	try {
		if (fs.existsSync(defsPath)) {
			fs.rmSync(defsPath);
			console.log('[client] cleaned up common/lsl-defs.json after packaging');
		}
	} catch (e) {
		console.warn('[client] cleanup failed:', e.message);
	}
}

main();
