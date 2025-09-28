#!/usr/bin/env node
/* eslint-env node */
/* globals process, console */
const fs = require('node:fs');
const path = require('node:path');

function main() {
	const extRoot = process.cwd();
	const defsPath = path.join(extRoot, 'common', 'lsl_definitions.yaml');
	try {
		if (fs.existsSync(defsPath)) {
			fs.rmSync(defsPath);
			console.log('[client] cleaned up common/lsl_definitions.yaml after packaging');
		}
	} catch (e) {
		console.warn('[client] cleanup failed:', e.message);
	}
}

main();
