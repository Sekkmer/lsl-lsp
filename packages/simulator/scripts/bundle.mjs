import { readFile, writeFile, readdir, access } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { generateDtsBundle } from 'dts-bundle-generator';
import { loadDefs } from '@lsl-lsp/core';

const packageDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const repoDir = path.resolve(packageDir, '../..');
const definitions = await loadDefs(path.join(repoDir, 'third_party/lsl-definitions/lsl_definitions.yaml'));
const result = await build({
	entryPoints: [path.join(packageDir, 'src/index.ts')],
	bundle: true,
	platform: 'node',
	target: 'node22',
	format: 'cjs',
	minify: true,
	sourcemap: true,
	sourcesContent: true,
	metafile: true,
	legalComments: 'eof',
	outfile: path.join(packageDir, 'out/lsl-simulator.cjs'),
	define: { SIMULATOR_BUNDLED_DEFINITIONS: JSON.stringify(definitions.file) },
	plugins: [{
		name: 'workspace-definition-resolution',
		setup(builder) {
			// Only the unbundled workspace fallback uses require.resolve. Keep
			// ordinary core imports bundled; the fallback is removed by the define.
			builder.onResolve({ filter: /^@lsl-lsp\/core$/ }, args => args.kind === 'require-resolve'
				? { path: args.path, external: true }
				: undefined);
		},
	}],
	logLevel: 'info',
});

const [types] = generateDtsBundle([{
	filePath: path.join(packageDir, 'src/index.ts'),
	libraries: { inlinedLibraries: ['@lsl-lsp/core'] },
	output: { noBanner: true },
}], { preferredConfigPath: path.join(packageDir, 'tsconfig.json') });
await writeFile(path.join(packageDir, 'out/lsl-simulator.d.cts'), types);

// Carry full license texts with the downloaded bundle, including normalized
// Second Life definitions and dependencies that actually contributed code.
const notices = [
	`LSL LSP\n\n${await readFile(path.join(repoDir, 'LICENSE'), 'utf8')}`,
	`Second Life definitions\n\n${await readFile(path.join(repoDir, 'third_party/lsl-definitions/LICENSE'), 'utf8')}`,
];
const packageRoots = new Set();
for (const input of Object.keys(result.metafile.inputs)) {
	if (!input.includes('node_modules/')) continue;
	let dir = path.dirname(path.resolve(input));
	while (dir !== path.dirname(dir)) {
		try {
			await access(path.join(dir, 'package.json'));
			packageRoots.add(dir);
			break;
		} catch {
			dir = path.dirname(dir);
		}
	}
}
for (const dir of [...packageRoots].sort()) {
	const metadata = JSON.parse(await readFile(path.join(dir, 'package.json'), 'utf8'));
	const licenses = (await readdir(dir)).filter(name => /^(?:licen[cs]e|notice)(?:[._-].*)?$/i.test(name)).sort();
	for (const file of licenses) {
		notices.push(`${metadata.name} ${metadata.version} (${file})\n\n${await readFile(path.join(dir, file), 'utf8')}`);
	}
}
await writeFile(path.join(packageDir, 'out/lsl-simulator.LICENSE.txt'), notices.join('\n\n---\n\n'));
