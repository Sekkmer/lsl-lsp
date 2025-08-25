#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const src = path.resolve(__dirname, '../../common/lsl-defs.json');
const destDir = path.resolve(__dirname, '../out');
const dest = path.join(destDir, 'lsl-defs.json');
try {
  fs.mkdirSync(destDir, { recursive: true });
  fs.copyFileSync(src, dest);
  console.log(`[server] copied defs to ${dest}`);
} catch (e) {
  console.warn('[server] copy defs failed:', e.message);
}
