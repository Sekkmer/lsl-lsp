import { describe, expect, it } from 'vitest';
import { intValue, SimulatorWorld } from '../src/index.js';
import { addScript, scriptWorld } from './helpers.js';

describe('virtual world execution', () => {
	it('suspends a nested function at each dialog and sleep before continuing the handler', () => {
		const { world, script } = scriptWorld(`
			float afterDialog; float finished;
			respond() {
				llDialog(llGetOwner(), "Choose", ["OK"], -42);
				afterDialog = llGetTime();
				llSleep(0.25);
				llTextBox(llGetOwner(), "Type", -42);
				finished = llGetTime();
			}
			default { state_entry() { respond(); } }
		`);
		world.start();
		world.advanceTime(0.5);
		expect(script.getGlobal('afterDialog')).toMatchObject({ value: 0 });
		world.advanceTime(0.5);
		expect(script.getGlobal('afterDialog')).toMatchObject({ value: 1 });
		world.advanceTime(1.24);
		expect(script.getGlobal('finished')).toMatchObject({ value: 0 });
		world.advanceTime(0.01);
		expect(script.getGlobal('finished')).toMatchObject({ value: 2.25 });
	});

	it('preserves detected data across suspension and schedules other scripts meanwhile', () => {
		const { world, script } = scriptWorld(`
			string before; string after;
			default { touch_start(integer count) {
				before = llDetectedName(0); llSleep(2); after = llDetectedName(0);
			} }
		`);
		const peer = addScript(script.prim, 'peer.lsl', 'default { state_entry() { llSleep(1); llLinksetDataWrite("peer", "ready"); } }');
		world.start();
		world.fireEvent(script, 'touch_start', [intValue(1)], [{ key: 'test', name: 'Tester', type: 1 }]);
		world.advanceTime(1);
		expect(script.prim.linkset.data.get('peer')).toBe('ready');
		expect(peer.activeExecution).toBeUndefined();
		expect(script.getGlobal('after')).toMatchObject({ value: '' });
		world.advanceTime(1);
		expect(script.getGlobal('before')).toMatchObject({ value: 'Tester' });
		expect(script.getGlobal('after')).toMatchObject({ value: 'Tester' });
	});

	it('runs state_exit, removes listeners on transition and aborts same-state statements without reentry', () => {
		const { world, script } = scriptWorld(`
			string stages; integer heard;
			default {
				state_entry() { llListen(42, "", NULL_KEY, ""); stages += "A"; }
				touch_start(integer count) { state next; }
				state_exit() { stages += "X"; llSleep(0.5); stages += "Y"; }
			}
			state next {
				state_entry() { stages += "B"; state next; stages += "bad"; }
				listen(integer c, string n, key id, string m) { ++heard; }
			}
		`);
		const peerPrim = script.prim.linkset.addPrim({ link: 2, name: 'peer', key: 'peer' });
		const peer = addScript(peerPrim, 'peer.lsl', 'default { touch_start(integer count) { llSay(42, "hello"); } }');
		world.start(); world.runUntilIdle();
		world.fireEvent(script, 'touch_start', [intValue(1)]);
		world.advanceTime(0.25);
		expect(script.getGlobal('stages')).toMatchObject({ value: 'AX' });
		world.advanceTime(0.25);
		expect(script.getGlobal('stages')).toMatchObject({ value: 'AXYB' });
		world.fireEvent(peer, 'touch_start', [intValue(1)]); world.runUntilIdle();
		expect(script.getGlobal('heard')).toMatchObject({ value: 0 });
	});

	it('retains listening registrations across script stop/start', () => {
		const { world, script } = scriptWorld(`
			integer heard;
			default {
				state_entry() { llListen(42, "", NULL_KEY, ""); }
				listen(integer c, string n, key id, string m) { ++heard; }
			}
		`);
		const peerPrim = script.prim.linkset.addPrim({ link: 2, name: 'peer', key: 'peer' });
		const peer = addScript(peerPrim, 'peer.lsl', 'default { touch_start(integer count) { llSay(42, "hello"); } }');
		world.start(); world.runUntilIdle();
		world.setScriptRunning(script, false);
		world.fireEvent(peer, 'touch_start', [intValue(1)]); world.runUntilIdle();
		world.setScriptRunning(script, true);
		world.fireEvent(peer, 'touch_start', [intValue(1)]); world.runUntilIdle();
		expect(script.getGlobal('heard')).toMatchObject({ value: 1 });
	});

	it('reports unsupported nested state changes instead of leaving a transition suspended forever', () => {
		const { world } = scriptWorld(`
			default { state_entry() { state next; } state_exit() { state default; } }
			state next { state_entry() {} }
		`);
		world.start();
		expect(() => world.runUntilIdle()).toThrow('state changes inside state_exit are not simulated');
	});

	it('suspends a self-stopping handler and resumes the same invocation when restarted', () => {
		const { world, script } = scriptWorld(`
			string stages;
			pause() { stages += "before"; llSetScriptState(llGetScriptName(), FALSE); stages += "after"; }
			default { state_entry() { pause(); stages += "done"; } }
		`);
		world.start(); world.runUntilIdle();
		expect(script.running).toBe(false);
		expect(script.getGlobal('stages')).toMatchObject({ value: 'before' });
		world.setScriptRunning(script, true); world.runUntilIdle();
		expect(script.getGlobal('stages')).toMatchObject({ value: 'beforeafterdone' });
		expect(world.trace.filter(entry => entry.kind === 'event')).toHaveLength(1);
	});

	it('coalesces pending timers and preserves insertion order of simultaneous external events', () => {
		const { world, script } = scriptWorld(`
			string order;
			default {
				state_entry() { llSetTimerEvent(0.1); llSleep(1); llSetTimerEvent(0); }
				timer() { order += "T"; }
				link_message(integer sender, integer n, string text, key id) { order += text; }
			}
		`);
		world.start();
		world.fireEventAfter(script, 0.5, 'link_message', [intValue(1), intValue(0), { kind: 'value', type: 'string', value: 'A' }, { kind: 'value', type: 'key', value: '' }]);
		world.fireEventAfter(script, 0.5, 'link_message', [intValue(1), intValue(0), { kind: 'value', type: 'string', value: 'B' }, { kind: 'value', type: 'key', value: '' }]);
		world.advanceTime(1);
		expect(script.getGlobal('order')).toMatchObject({ value: 'TAB' });
	});

	it('starts reset scripts with state_entry even when reset while stopped', () => {
		const { world, script } = scriptWorld(`
			integer booted;
			default { state_entry() { ++booted; } }
		`);
		world.start(); world.runUntilIdle();
		world.setScriptRunning(script, false);
		world.resetScript(script);
		expect(script.getGlobal('booted')).toMatchObject({ value: 0 });
		world.setScriptRunning(script, true); world.runUntilIdle();
		expect(script.getGlobal('booted')).toMatchObject({ value: 1 });
	});

	it('delivers a remote-load start parameter and discards the replaced script continuation', () => {
		const { world, script: loader } = scriptWorld(`
			default { touch_start(integer count) { llRemoteLoadScriptPin(llGetLinkKey(2), "candidate.lsl", 777, TRUE, 77); } }
		`);
		const candidate = addScript(loader.prim, 'candidate.lsl', `
			integer parameter;
			default { state_entry() { parameter = llGetStartParameter(); } }
		`);
		world.setScriptRunning(candidate, false);
		const target = loader.prim.linkset.addPrim({ link: 2, name: 'target', key: 'target' });
		target.remoteScriptPin = 777;
		const old = addScript(target, 'candidate.lsl', 'default { state_entry() { llSleep(5); llLinksetDataWrite("old", "bad"); } }');
		world.start(); world.advanceTime(1);
		world.fireEvent(loader, 'touch_start', [intValue(1)]); world.advanceTime(3);
		expect(target.script('candidate.lsl')!.getGlobal('parameter')).toMatchObject({ value: 77 });
		expect(old.running).toBe(false);
		world.advanceTime(5);
		expect(loader.prim.linkset.data.has('old')).toBe(false);
	});

	it('limits a timer with no handler and accepts future events before their target state is entered', () => {
		const { world, script } = scriptWorld(`
			integer delivered;
			default { state_entry() { llSleep(0.5); state ready; } }
			state ready { touch_start(integer count) { delivered = count; } }
		`);
		world.start();
		expect(world.fireEventAfter(script, 1, 'touch_start', [intValue(7)])).toBe(true);
		world.advanceTime(1);
		expect(script.getGlobal('delivered')).toMatchObject({ value: 7 });
		world.callBuiltin(script, 'llSetTimerEvent', [{ kind: 'value', type: 'float', value: 0.001 }]);
		expect(() => world.advanceTime(100, 20)).toThrow('scheduling steps');
	});

	it('gives each ready script a turn instead of starving a recipient behind a self-message loop', () => {
		const { world, script } = scriptWorld(`
			integer turns;
			default {
				state_entry() { llMessageLinked(LINK_THIS, 1, "work", ""); }
				link_message(integer sender, integer n, string text, key id) {
					++turns; if (turns < 3) llMessageLinked(LINK_THIS, 1, "work", "");
				}
			}
		`);
		const observer = addScript(script.prim, 'observer.lsl', `
			integer count;
			default { link_message(integer sender, integer n, string text, key id) { ++count; } }
		`);
		world.start(); world.runUntilIdle();
		expect(observer.getGlobal('count')).toMatchObject({ value: 3 });
		expect(world.trace.filter(entry => entry.kind === 'event').slice(1, 3)
			.map(entry => entry.script)).toEqual(['observer.lsl', 'example.lsl']);
	});

	it('returns linkset-data status codes, deletes empty writes and enforces UTF-8 capacity', () => {
		const { world, script } = scriptWorld(`
			integer missing; integer empty; integer removed; integer same;
			default { state_entry() {
				missing = llLinksetDataDelete("missing"); empty = llLinksetDataWrite("", "value");
				llLinksetDataWrite("a", "value"); same = llLinksetDataWrite("a", "value");
				removed = llLinksetDataWrite("a", "");
			} }
		`);
		world.start(); world.runUntilIdle();
		expect(script.getGlobal('missing')).toMatchObject({ value: 4 });
		expect(script.getGlobal('empty')).toMatchObject({ value: 2 });
		expect(script.getGlobal('same')).toMatchObject({ value: 5 });
		expect(script.getGlobal('removed')).toMatchObject({ value: 0 });
		expect(script.prim.linkset.data.has('a')).toBe(false);
		const result = world.callBuiltin(script, 'llLinksetDataWrite', [
			{ kind: 'value', type: 'string', value: 'large' },
			{ kind: 'value', type: 'string', value: '😀'.repeat(32_768) },
		]);
		expect(result).toMatchObject({ value: { value: 1 } });
	});

	it('uses chat distance for say/whisper/shout and delivers region chat across linksets', () => {
		const world = new SimulatorWorld();
		const owner = '20000000-0000-0000-0000-000000000001';
		const from = world.addLinkset({ name: 'Sender', key: 'from', owner, position: [0, 0, 0] });
		const to = world.addLinkset({ name: 'Receiver', key: 'to', owner, position: [25, 0, 0] });
		addScript(from.addPrim({ link: 1, name: 'sender', key: 'sender' }), 'sender.lsl', `
			default { touch_start(integer count) {
				llSay(42, "say"); llWhisper(42, "whisper"); llShout(42, "shout"); llRegionSay(42, "region");
			} }
		`);
		const receiver = addScript(to.addPrim({ link: 1, name: 'receiver', key: 'receiver' }), 'receiver.lsl', `
			string heard;
			default { state_entry() { llListen(42, "", NULL_KEY, ""); }
				listen(integer c, string n, key id, string m) { heard += m + ","; } }
		`);
		world.start(); world.runUntilIdle();
		world.fireEvent(from.scripts[0]!, 'touch_start', [intValue(1)]); world.runUntilIdle();
		expect(receiver.getGlobal('heard')).toMatchObject({ value: 'shout,region,' });
	});

	it('routes avatar-targeted nonzero chat only to that avatar\'s attachments and excludes the speaking prim', () => {
		const world = new SimulatorWorld();
		const owner = '20000000-0000-0000-0000-000000000001';
		const source = world.addLinkset({ name: 'Source', key: 'source', owner, attached: true });
		const sourcePrim = source.addPrim({ link: 1, name: 'source', key: 'source-root' });
		const sender = addScript(sourcePrim, 'sender.lsl', `
			default { touch_start(integer count) {
				llRegionSayTo(llGetOwner(), -42, "private");
				llRegionSayTo(llGetOwner(), 0, "viewer-only");
			} }
		`);
		const receiverSource = `
			integer heard;
			default { state_entry() { llListen(-42, "", NULL_KEY, ""); llListen(0, "", NULL_KEY, ""); }
				listen(integer c, string n, key id, string m) { ++heard; } }
		`;
		const samePrim = addScript(sourcePrim, 'observer.lsl', receiverSource);
		const receivers = [
			{ name: 'attached', owner, attached: true },
			{ name: 'rezzed', owner, attached: false },
			{ name: 'wrong-owner', owner: '20000000-0000-0000-0000-000000000002', attached: true },
		].map(options => {
			const linkset = world.addLinkset({ ...options, key: options.name });
			const prim = linkset.addPrim({ link: 1, name: options.name, key: `${options.name}-root` });
			return addScript(prim, 'receiver.lsl', receiverSource);
		});
		world.start(); world.runUntilIdle();
		world.fireEvent(sender, 'touch_start', [intValue(1)]); world.runUntilIdle();
		expect(receivers.map(receiver => receiver.getGlobal('heard'))).toMatchObject([
			{ value: 1 }, { value: 0 }, { value: 0 },
		]);
		expect(samePrim.getGlobal('heard')).toMatchObject({ value: 0 });
	});
});
