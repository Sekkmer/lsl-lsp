import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const packageDir = path.resolve(scriptDir, '..');
const packageJson = JSON.parse(await readFile(path.join(packageDir, 'package.json'), 'utf8'));

await build({
	entryPoints: [path.join(packageDir, 'src/index.ts')],
	bundle: true,
	platform: 'node',
	target: 'node22',
	format: 'cjs',
	minify: true,
	sourcemap: true,
	loader: { '.yaml': 'text' },
	outfile: path.join(packageDir, 'out/lsl-lsp.cjs'),
	define: {
		CLI_VERSION: JSON.stringify(packageJson.version),
	},
	logLevel: 'info',
});
