/* eslint-env node */
/* globals process */
const fs = require('node:fs');
const path = require('node:path');
// const __dirname = path.dirname(__filename);

function copyDir(src, dest) {
	if (!fs.existsSync(src)) return;
	fs.mkdirSync(dest, { recursive: true });
	for (const entry of fs.readdirSync(src)) {
		const s = path.join(src, entry);
		const d = path.join(dest, entry);
		const st = fs.statSync(s);
		if (st.isDirectory()) copyDir(s, d);
		else fs.copyFileSync(s, d);
	}
}

function main() {
	const repoRoot = path.resolve(process.cwd(), '..');
	const serverOut = path.join(repoRoot, 'server', 'out');
	const destServer = path.resolve(process.cwd(), 'server', 'out');
	copyDir(serverOut, destServer);

	const commonSrc = path.join(repoRoot, 'common', 'lsl_definitions.yaml');
	const commonDestDir = path.resolve(process.cwd(), 'common');
	fs.mkdirSync(commonDestDir, { recursive: true });
	if (fs.existsSync(commonSrc)) fs.copyFileSync(commonSrc, path.join(commonDestDir, 'lsl_definitions.yaml'));
}

main();
