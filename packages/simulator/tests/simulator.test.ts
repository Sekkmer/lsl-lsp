import path from 'node:path';
import type { Value } from '@lsl-lsp/core';
import { describe, expect, it } from 'vitest';
import { intValue, loadLinksetProject, SimulatorWorld } from '../src/index.js';

const fixturePath = path.resolve(process.cwd(), 'tests/fixtures/communication');

describe('linkset simulator', () => {
	it('leaves a supplied world unchanged when a project fails to load', async () => {
		const world = new SimulatorWorld();
		await expect(loadLinksetProject(path.resolve(process.cwd(), 'tests/fixtures/invalid-linkset'), { world }))
			.rejects.toThrow('must contain a root prim');
		expect(world.linksets).toHaveLength(0);
	});
	it('loads linkset/prims/scripts and simulates request/reply communication', async () => {
		const { world, linkset } = await loadLinksetProject(fixturePath);
		const root = linkset.prim(1)!;
		const app = linkset.prim(2)!;
		const sender = root.script('sender.lsl')!;
		const receiver = app.script('receiver.lsl')!;
		const stopped = app.script('stopped.lsl')!;

		expect(linkset.prims.map(prim => prim.link)).toEqual([1, 2, 3, 4]);
		expect(stopped.running).toBe(false);

		world.start();
		world.runUntilIdle();

		expect(sender.takesControls).toBe(true);
		expect(receiver.takesControls).toBe(true);
		expect(app.name).toBe('Communication Example');
		expect(linkset.data.get('app:name')).toBe('Communication Example');
		expect(world.trace).toContainEqual(expect.objectContaining({
			kind: 'prim-name',
			script: 'receiver.lsl',
			prim: 'Communication Example',
			detail: 'worker:Communication Example',
		}));
		expect(asInteger(sender.getGlobal('rhs_evaluations'))).toBe(1);
		expect(linkset.data.has('stopped:boot')).toBe(false);

		expect(world.fireEvent(sender, 'touch_start', [{ kind: 'value', type: 'integer', value: 1 }])).toBe(true);
		world.runUntilIdle();

		expect(linkset.data.get('boot')).toBe('ready');
		expect(linkset.data.get('app:linked')).toBe('1:ping:request-1:ready');
		expect(linkset.data.get('root:reply')).toBe('2:pong:request-1');
		expect(linkset.data.get('app:chat')).toBe('hello');
		expect(linkset.data.get('root:chat')).toBe('ack');
		expect(linkset.data.has('same-prim:ack')).toBe(false);
		expect(asInteger(sender.getGlobal('changes'))).toBeGreaterThan(0);

		world.setScriptRunning(stopped, true);
		world.runUntilIdle();
		expect(linkset.data.get('stopped:boot')).toBe('yes');
	});

	it('keeps only control-holding prims active on no-script parcels', async () => {
		const { world, linkset } = await loadLinksetProject(fixturePath);
		const sender = linkset.prim(1)!.script('sender.lsl')!;
		const idle = linkset.prim(3)!.script('idle.lsl')!;
		world.start();
		world.runUntilIdle();

		world.scriptsAllowed = false;
		expect(world.fireEvent(sender, 'touch_start', [intValue(1)])).toBe(true);
		expect(world.fireEvent(idle, 'touch_start', [intValue(1)])).toBe(false);
		world.runUntilIdle();
		expect(linkset.data.has('idle:touch')).toBe(false);

		world.scriptsAllowed = true;
		expect(world.fireEvent(idle, 'touch_start', [intValue(1)])).toBe(true);
		world.runUntilIdle();
		expect(linkset.data.get('idle:touch')).toBe('yes');
	});

	it('advances repeating timers with deterministic virtual time', async () => {
		const { world, linkset } = await loadLinksetProject(fixturePath);
		const idle = linkset.prim(3)!.script('idle.lsl')!;
		world.start();
		world.runUntilIdle();

		world.advanceTime(1.9);
		expect(asInteger(idle.getGlobal('ticks'))).toBe(0);
		world.advanceTime(0.1);
		expect(asInteger(idle.getGlobal('ticks'))).toBe(1);
		world.advanceTime(4);
		expect(asInteger(idle.getGlobal('ticks'))).toBe(3);
		expect(world.now).toBe(6);

		world.setScriptRunning(idle, false);
		world.advanceTime(4);
		expect(asInteger(idle.getGlobal('ticks'))).toBe(3);
		world.setScriptRunning(idle, true);
		world.advanceTime(2);
		expect(asInteger(idle.getGlobal('ticks'))).toBe(4);
	});

	it('changes ownership, revokes permissions, and emits CHANGED_OWNER', async () => {
		const { world, linkset } = await loadLinksetProject(fixturePath);
		const sender = linkset.prim(1)!.script('sender.lsl')!;
		const newOwner = '20000000-0000-0000-0000-000000000003';
		world.start();
		world.runUntilIdle();
		expect(sender.takesControls).toBe(true);

		linkset.setOwner(newOwner);
		expect(linkset.owner).toBe(newOwner);
		expect(sender.permissions).toBe(0);
		expect(sender.takesControls).toBe(false);
		world.runUntilIdle();

		expect(linkset.data.get('owner')).toBe(newOwner);
		expect(sender.permissionsKey).toBe(newOwner);
		expect(sender.takesControls).toBe(true);
	});

	it('emits attachment lifecycle events and revokes runtime permissions', async () => {
		const { world, linkset } = await loadLinksetProject(fixturePath);
		const sender = linkset.prim(1)!.script('sender.lsl')!;
		world.start();
		world.runUntilIdle();
		expect(sender.takesControls).toBe(true);

		linkset.setAttached(false);
		expect(linkset.attached).toBe(false);
		expect(sender.permissions).toBe(0);
		expect(sender.takesControls).toBe(false);
		world.runUntilIdle();

		linkset.setAttached(true);
		expect(linkset.attached).toBe(true);
		world.runUntilIdle();
		expect(world.trace.filter(entry =>
			entry.kind === 'attachment').map(entry => entry.detail)).toEqual([
			'detached',
			`attached:${linkset.owner}`,
		]);
		expect(sender.permissionsKey).toBe(linkset.owner);
		expect(sender.takesControls).toBe(true);
	});

	it('validates PINs and silently replaces same-name remote scripts', async () => {
		const { world, linkset } = await loadLinksetProject(fixturePath);
		const root = linkset.prim(1)!;
		const app = linkset.prim(2)!;
		const loader = root.script('remote-loader.lsl')!;
		const source = root.script('candidate.lsl')!;
		world.start();
		world.runUntilIdle();

		const oldAsset = app.script('candidate.lsl')!.assetKey;
		expect(oldAsset).not.toBe(source.assetKey);
		expect(linkset.data.get('candidate:version')).toBe('old');

		app.remoteScriptPin = 4321;
		world.fireEvent(loader, 'touch_start', [intValue(1)]);
		world.runUntilIdle();
		expect(app.script('candidate.lsl')!.assetKey).toBe(oldAsset);
		expect(world.trace.filter(entry => entry.kind === 'remote-load').at(-1)).toMatchObject({
			kind: 'remote-load',
			detail: expect.stringContaining('rejected'),
		});

		app.remoteScriptPin = 1234;
		world.fireEvent(loader, 'touch_start', [intValue(1)]);
		world.runUntilIdle();
		expect(app.script('candidate.lsl')!.assetKey).toBe(source.assetKey);
		expect(linkset.data.get('candidate:version')).toBe('new');
		expect(world.trace.some(entry =>
			entry.kind === 'remote-load' && entry.detail.includes(':ok:1'))).toBe(true);
	});

	it('tracks llSetText and link-targeted PRIM_TEXT state', async () => {
		const { world, linkset } = await loadLinksetProject(fixturePath);
		const root = linkset.prim(1)!;
		const title = linkset.prim(4)!;
		const hoverText = root.script('hover-text.lsl')!;

		world.start();
		world.runUntilIdle();
		world.setScriptRunning(hoverText, true);
		world.runUntilIdle();

		expect(root.hoverText).toBe('Root');
		expect(root.hoverTextColor).toEqual([1, 0.5, 0.25]);
		expect(root.hoverTextAlpha).toBe(0.75);
		expect(title.hoverText).toBe('');

		world.fireEvent(hoverText, 'touch_start', [intValue(1)]);
		world.runUntilIdle();

		expect(title.hoverText).toBe('Linked');
		expect(title.hoverTextColor).toEqual([0.1, 0.2, 0.3]);
		expect(title.hoverTextAlpha).toBe(0.4);
		expect(world.trace.filter(entry =>
			entry.kind === 'prim-text' && entry.script === 'hover-text.lsl').at(-1))
			.toMatchObject({
				kind: 'prim-text',
				script: 'hover-text.lsl',
				prim: 'display',
				detail: '4:Linked:0.1,0.2,0.3:0.4',
			});

		world.fireEvent(hoverText, 'listen', [
			intValue(-42),
			{ kind: 'value', type: 'string', value: 'Wearer' },
			{ kind: 'value', type: 'key', value: linkset.owner },
			{ kind: 'value', type: 'string', value: 'OK' },
		]);
		world.runUntilIdle();
		expect(world.now).toBe(1);
		expect(asInteger(hoverText.getGlobal('responses'))).toBe(1);
		expect(world.trace.filter(entry =>
			entry.kind === 'event' && entry.script === 'hover-text.lsl').at(-1))
			.toMatchObject({ detail: 'default.listen', time: 1 });
	});

	it('injects delayed world events at deterministic virtual times', async () => {
		const { world, linkset } = await loadLinksetProject(fixturePath);
		const hoverText = linkset.prim(1)!.script('hover-text.lsl')!;
		world.start();
		world.runUntilIdle();
		world.setScriptRunning(hoverText, true);
		world.runUntilIdle();

		expect(world.fireEventAfter(hoverText, 8, 'listen', [
			intValue(-42),
			{ kind: 'value', type: 'string', value: 'Wearer' },
			{ kind: 'value', type: 'key', value: linkset.owner },
			{ kind: 'value', type: 'string', value: 'OK' },
		])).toBe(true);
		expect(world.runUntilIdle()).toBe(0);
		world.advanceTime(7.9);
		expect(asInteger(hoverText.getGlobal('responses'))).toBe(0);
		expect(world.advanceTime(0.1)).toBeGreaterThanOrEqual(1);
		expect(asInteger(hoverText.getGlobal('responses'))).toBe(1);
		expect(world.trace.filter(entry =>
			entry.kind === 'event' && entry.script === 'hover-text.lsl').at(-1))
			.toMatchObject({ detail: 'default.listen', time: 8 });
	});
});

function asInteger(value: Value | undefined): number {
	if (!value || value.kind !== 'value' || value.type !== 'integer') {
		throw new Error('expected an integer value');
	}
	return value.value;
}
