import { parseScriptFromText } from '@lsl-lsp/core';
import { SimulatorWorld, type SimPrim, type SimScript } from '../src/index.js';

export function addScript(prim: SimPrim, name: string, source: string): SimScript {
	return prim.addScript({
		name,
		sourcePath: `${prim.name}/${name}`,
		ast: parseScriptFromText(source, `${prim.name}/${name}`),
	});
}

export function scriptWorld(source: string): {
	world: SimulatorWorld;
	script: SimScript;
} {
	const world = new SimulatorWorld();
	const linkset = world.addLinkset({
		name: 'Example',
		key: '10000000-0000-0000-0000-000000000001',
		owner: '20000000-0000-0000-0000-000000000001',
	});
	const root = linkset.addPrim({ link: 1, name: 'root', key: linkset.key });
	return { world, script: addScript(root, 'example.lsl', source) };
}
