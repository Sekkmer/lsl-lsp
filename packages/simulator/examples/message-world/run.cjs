/* globals __dirname, console, process */
const assert = require('node:assert/strict');
const path = require('node:path');
const { SimulatorWorld, intValue, loadLinksetProject } = require('../../out/index.js');

async function main() {
	const world = new SimulatorWorld();
	const { linkset: attachment } = await loadLinksetProject(
		path.join(__dirname, 'attachment'), { world },
	);
	const { linkset: panel } = await loadLinksetProject(
		path.join(__dirname, 'panel'), { world },
	);
	world.start();
	world.runUntilIdle();

	const panelScript = panel.prim(1).script('panel.lsl');
	assert.equal(world.fireEvent(panelScript, 'touch_start', [intValue(1)]), true);
	world.runUntilIdle();

	assert.equal(attachment.attached, true);
	assert.equal(panel.attached, false);
	assert.equal(attachment.owner, panel.owner);
	assert.equal(attachment.data.get('worker:received'), 'ping');
	assert.equal(panel.data.get('panel:reply'), 'pong');
	assert.equal(panel.data.has('worker:received'), false);
	console.log('PASS: rezzed panel -> attachment root -> child prim -> panel reply');
}

main().catch(error => {
	console.error(error);
	process.exitCode = 1;
});
