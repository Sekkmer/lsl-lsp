import type { Event, Script, Value } from '@lsl-lsp/core';
import {
	ScriptExecutor,
	ScriptResetSignal,
	type BuiltinResult,
	type ExecutionHost,
} from './executor.js';
import {
	NULL_KEY,
	asInteger,
	asNumber,
	asRotation,
	asString,
	asVector,
	cloneValue,
	floatValue,
	intValue,
	keyValue,
	listValue,
	lslString,
	rotationValue,
	stringValue,
	vectorValue,
} from './value.js';

const MAX_EVENT_QUEUE = 64;
const PERMISSION_TAKE_CONTROLS = 0x00004;
const PERMISSION_TRIGGER_ANIMATION = 0x00010;
const PRIM_TEXT = 26;

export interface SimEvent {
	name: string;
	args: Value[];
	detected?: SensorEntity[];
}

export interface SensorEntity {
	key: string;
	name: string;
	type: number;
}

export type SensorAgent = Omit<SensorEntity, 'type'> & { type?: number };

export interface ScriptOptions {
	name: string;
	sourcePath: string;
	ast: Script;
	assetKey?: string;
	running?: boolean;
	startParameter?: number;
	constants?: ReadonlyMap<string, Value>;
}

export interface PrimOptions {
	link: number;
	name: string;
	key: string;
}

export interface LinksetOptions {
	name: string;
	key: string;
	owner: string;
	attached?: boolean;
	position?: [number, number, number];
	rootRotation?: [number, number, number, number];
}

export interface WorldOptions {
	unixTimeBase?: number;
	regionCorner?: [number, number, number];
}

export interface TraceEntry {
	kind: 'event' | 'linked-message' | 'chat' | 'linkset-data' | 'owner-say'
		| 'script-state' | 'dialog' | 'agent-rotation' | 'push' | 'move-target'
		| 'move-stop' | 'particles' | 'sound' | 'remote-load' | 'attachment'
		| 'prim-text' | 'prim-name' | 'runtime-error';
	script?: string;
	prim?: string;
	time?: number;
	detail: string;
}

interface Listener {
	handle: number;
	script: SimScript;
	channel: number;
	name: string;
	id: string;
	message: string;
	active: boolean;
}

interface ScheduledEvent {
	dueAt: number;
	script: SimScript;
	event: SimEvent;
}

export class SimScript {
	readonly executor: ScriptExecutor;
	readonly queue: SimEvent[] = [];
	currentState: string;
	running: boolean;
	takesControls = false;
	permissions = 0;
	permissionsKey = NULL_KEY;
	started = false;
	timerInterval = 0;
	nextTimerAt?: number;
	blockedUntil = 0;
	timeOrigin: number;
	startParameter: number;
	activeExecution?: ReturnType<ScriptExecutor['beginEvent']>;
	activeEvent?: SimEvent;
	transitionTo?: string;
	fault?: Error;

	constructor(
		readonly prim: SimPrim,
		readonly options: ScriptOptions,
	) {
		this.running = options.running ?? true;
		this.timeOrigin = prim.linkset.world.now;
		this.startParameter = options.startParameter ?? 0;
		this.currentState = options.ast.states.has('default')
			? 'default'
			: (options.ast.states.keys().next().value as string | undefined) ?? 'default';
		const host: ExecutionHost = {
			callBuiltin: (name, args) => this.prim.linkset.world.callBuiltin(this, name, args),
		};
		this.executor = new ScriptExecutor(options.ast, host, { constants: options.constants });
	}

	get name(): string {
		return this.options.name;
	}

	get sourcePath(): string {
		return this.options.sourcePath;
	}

	get ast(): Script {
		return this.options.ast;
	}

	get assetKey(): string {
		return this.options.assetKey ?? NULL_KEY;
	}

	get effectiveRunning(): boolean {
		return this.running
			&& (this.prim.linkset.world.scriptsAllowed || this.prim.keptAliveInNoScriptParcel);
	}

	hasEvent(name: string): boolean {
		return this.event(name) !== undefined;
	}

	event(name: string): Event | undefined {
		return this.ast.states.get(this.currentState)?.events.find(event => event.name === name);
	}

	enqueue(event: SimEvent): boolean {
		if (!this.effectiveRunning || !this.hasEvent(event.name)) return false;
		// SL permits at most one pending timer event, even during a long handler.
		if (event.name === 'timer' && this.queue.some(queued => queued.name === 'timer')) return false;
		if (this.queue.length >= MAX_EVENT_QUEUE) return false;
		this.queue.push({
			name: event.name,
			args: event.args.map(cloneValue),
			detected: event.detected?.map(entry => ({ ...entry })),
		});
		return true;
	}

	getGlobal(name: string): Value | undefined {
		return this.executor.getGlobal(name);
	}
}

export class SimPrim {
	readonly scripts: SimScript[] = [];
	remoteScriptPin = 0;
	hoverText = '';
	hoverTextColor: [number, number, number] = [1, 1, 1];
	hoverTextAlpha = 1;

	constructor(
		readonly linkset: SimLinkset,
		readonly options: PrimOptions,
	) {}

	get link(): number {
		return this.options.link;
	}

	get name(): string {
		return this.options.name;
	}

	setName(name: string): void {
		this.options.name = name;
	}

	get key(): string {
		return this.options.key;
	}

	get keptAliveInNoScriptParcel(): boolean {
		return this.scripts.some(script => script.running && script.takesControls);
	}

	addScript(options: ScriptOptions): SimScript {
		if (this.scripts.some(script => script.name === options.name)) {
			throw new Error(`duplicate script ${options.name} in prim ${this.name}`);
		}
		const script = new SimScript(this, options);
		this.scripts.push(script);
		return script;
	}

	replaceScript(options: ScriptOptions): SimScript {
		const index = this.scripts.findIndex(script => script.name === options.name);
		if (index >= 0) {
			this.linkset.world.removeScriptRuntime(this.scripts[index]!);
			this.scripts.splice(index, 1);
		}
		return this.addScript(options);
	}

	script(name: string): SimScript | undefined {
		return this.scripts.find(script => script.name === name);
	}
}

export class SimLinkset {
	readonly prims: SimPrim[] = [];
	readonly data = new Map<string, string>();

	constructor(
		readonly world: SimulatorWorld,
		readonly options: LinksetOptions,
	) {}

	get name(): string {
		return this.options.name;
	}

	get key(): string {
		return this.options.key;
	}

	get owner(): string {
		return this.options.owner;
	}

	setOwner(owner: string): void {
		if (!owner || owner === this.options.owner) return;
		this.options.owner = owner;
		for (const script of this.scripts) {
			script.permissions = 0;
			script.permissionsKey = NULL_KEY;
			script.takesControls = false;
			script.enqueue({
				name: 'changed',
				args: [intValue(0x00000080)],
			});
		}
	}

	get attached(): boolean {
		return this.options.attached ?? true;
	}

	setAttached(attached: boolean): void {
		if (attached === this.attached) return;
		this.options.attached = attached;
		const attachment = attached ? this.owner : NULL_KEY;
		for (const script of this.scripts) {
			script.permissions = 0;
			script.permissionsKey = NULL_KEY;
			script.takesControls = false;
			script.enqueue({
				name: 'attach',
				args: [keyValue(attachment)],
			});
		}
		this.world.trace.push({
			kind: 'attachment',
			time: this.world.now,
			detail: attached ? `attached:${this.owner}` : 'detached',
		});
	}

	addPrim(options: PrimOptions): SimPrim {
		if (this.prims.some(prim => prim.link === options.link)) {
			throw new Error(`duplicate link number ${options.link}`);
		}
		const prim = new SimPrim(this, options);
		this.prims.push(prim);
		this.prims.sort((left, right) => left.link - right.link);
		return prim;
	}

	prim(link: number): SimPrim | undefined {
		return this.prims.find(prim => prim.link === link);
	}

	get scripts(): SimScript[] {
		return this.prims.flatMap(prim => prim.scripts);
	}
}

export class SimulatorWorld {
	readonly linksets: SimLinkset[] = [];
	readonly sameGroupAgents = new Set<string>();
	readonly sensorAgents: SensorAgent[] = [];
	readonly sensorObjects: SensorEntity[] = [];
	readonly objectOwners = new Map<string, string>();
	readonly objectNames = new Map<string, string>();
	readonly objectPositions = new Map<string, [number, number, number]>();
	readonly objectRotations = new Map<string, [number, number, number, number]>();
	readonly objectRoots = new Map<string, string>();
	readonly objectAttachedPoints = new Map<string, number>();
	readonly movementTargets = new Map<string, [number, number, number]>();
	readonly agentRotations = new Map<string, [number, number, number, number]>();
	readonly trace: TraceEntry[] = [];
	scriptsAllowed = true;
	now = 0;
	private readonly listeners: Listener[] = [];
	private readonly scheduledEvents: ScheduledEvent[] = [];
	private nextListenerHandle = 1;
	private nextGeneratedKey = 1;
	private lastScriptIndex = -1;
	private activeDetected: SensorEntity[] = [];
	private readonly unixTimeBase: number;
	private readonly regionCorner: [number, number, number];

	constructor(options: WorldOptions = {}) {
		this.unixTimeBase = Math.trunc(options.unixTimeBase ?? 0);
		this.regionCorner = options.regionCorner ?? [0, 0, 0];
	}

	addLinkset(options: LinksetOptions): SimLinkset {
		if (this.linksets.some(linkset => linkset.key === options.key)) {
			throw new Error(`duplicate linkset key ${options.key}`);
		}
		const linkset = new SimLinkset(this, options);
		this.linksets.push(linkset);
		return linkset;
	}

	start(): void {
		for (const script of this.scripts) {
			if (script.running && !script.started) {
				script.started = true;
				script.enqueue({ name: 'state_entry', args: [] });
			}
		}
	}

	runUntilIdle(maxEvents = 10_000): number {
		return this.runUntilIdleThrough(maxEvents, Number.POSITIVE_INFINITY);
	}

	private runUntilIdleThrough(maxEvents: number, maxTime: number): number {
		let processed = 0;
		let temporalSteps = 0;
		for (;;) {
			const candidates = this.scripts;
			let script: SimScript | undefined;
			for (let offset = 1; offset <= candidates.length; offset += 1) {
				const index = (this.lastScriptIndex + offset) % candidates.length;
				const candidate = candidates[index]!;
				if (candidate.effectiveRunning
					&& (candidate.activeExecution || candidate.queue.length > 0)
					&& candidate.blockedUntil <= this.now) {
					script = candidate;
					this.lastScriptIndex = index;
					break;
				}
			}
			if (!script) {
				const nextUnblocked = this.scripts.reduce<number | undefined>(
					(earliest, candidate) => {
						if (!candidate.effectiveRunning
							|| (!candidate.activeExecution && candidate.queue.length === 0)
							|| candidate.blockedUntil <= this.now) return earliest;
						return earliest === undefined
							|| candidate.blockedUntil < earliest
							? candidate.blockedUntil
							: earliest;
					},
					undefined,
				);
				if (nextUnblocked === undefined
					|| nextUnblocked > maxTime) return processed;
				const temporal = this.nextTemporalEventAt();
				temporalSteps += 1;
				if (temporalSteps > maxEvents) throw new Error(`virtual time exceeded ${maxEvents} scheduling steps`);
				const next = temporal === undefined ? nextUnblocked : Math.min(nextUnblocked, temporal);
				this.now = Math.max(this.now, next);
				this.enqueueTemporalThrough(this.now);
				continue;
			}
			if (processed >= maxEvents) {
				throw new Error(`world did not become idle after ${maxEvents} events`);
			}
			this.runNext(script);
			processed += 1;
		}
	}

	advanceTime(seconds: number, maxEvents = 10_000): number {
		if (!Number.isFinite(seconds) || seconds < 0) {
			throw new Error(`cannot advance virtual time by ${seconds}`);
		}
		const target = this.now + seconds;
		let processed = 0;
		let temporalSteps = 0;
		for (;;) {
			processed += this.runUntilIdleThrough(maxEvents - processed, target);
			const nextTemporal = this.nextTemporalEventAt();
			const dueAt = nextTemporal !== undefined && nextTemporal <= target
				? nextTemporal
				: undefined;
			if (dueAt === undefined) break;
			temporalSteps += 1;
			if (temporalSteps > maxEvents) throw new Error(`virtual time exceeded ${maxEvents} scheduling steps`);
			this.now = Math.max(this.now, dueAt);
			this.enqueueTemporalThrough(this.now);
		}
		this.now = target;
		processed += this.runUntilIdleThrough(maxEvents - processed, target);
		return processed;
	}

	runNext(script: SimScript): boolean {
		if (!script.effectiveRunning || script.blockedUntil > this.now) return false;
		if (!script.activeExecution) {
			const queued = script.queue.shift();
			if (!queued) return false;
			if (!this.beginEvent(script, queued)) return true;
		}
		this.activeDetected = script.activeEvent?.detected ?? [];
		let step: ReturnType<NonNullable<SimScript['activeExecution']>['next']>;
		try {
			step = script.activeExecution!.next();
		} catch (error) {
			script.fault = error instanceof Error ? error : new Error(String(error));
			this.removeScriptRuntime(script);
			this.trace.push({ kind: 'runtime-error', script: script.name, prim: script.prim.name,
				time: this.now, detail: script.fault.message });
			throw new Error(`${script.sourcePath}: ${script.fault.message}`, { cause: error });
		} finally {
			this.activeDetected = [];
		}
		if (!step.done) {
			script.blockedUntil = step.value.kind === 'delay' ? this.now + step.value.seconds : this.now;
			return true;
		}
		script.activeExecution = undefined;
		script.activeEvent = undefined;
		const result = step.value;
		if (result.kind === 'state-change') {
			// A same-state statement still ends the current event, without entering/exiting.
			if (result.state === script.currentState) return true;
			if (!script.ast.states.has(result.state)) {
				throw new Error(`${script.name} changed to unknown state ${result.state}`);
			}
			script.queue.length = 0;
			script.transitionTo = result.state;
			if (!this.beginEvent(script, { name: 'state_exit', args: [] })) {
				this.finishStateChange(script);
			}
		} else if (result.kind === 'reset') {
			this.resetScript(script);
		} else if (script.transitionTo !== undefined) {
			this.finishStateChange(script);
		}
		return true;
	}

	private beginEvent(script: SimScript, queued: SimEvent): boolean {
		const event = script.event(queued.name);
		if (!event) return false;
		script.activeEvent = queued;
		script.activeExecution = script.executor.beginEvent(event, queued.args);
		this.trace.push({ kind: 'event', script: script.name, prim: script.prim.name,
			time: this.now, detail: `${script.currentState}.${queued.name}` });
		return true;
	}

	private finishStateChange(script: SimScript): void {
		this.removeListeners(script);
		script.queue.length = 0;
		script.currentState = script.transitionTo!;
		script.transitionTo = undefined;
		script.enqueue({ name: 'state_entry', args: [] });
	}

	fireEvent(
		script: SimScript,
		name: string,
		args: Value[] = [],
		detected?: SensorEntity[],
	): boolean {
		return script.enqueue({ name, args, detected });
	}

	fireEventAfter(
		script: SimScript,
		delay: number,
		name: string,
		args: Value[] = [],
		detected?: SensorEntity[],
	): boolean {
		if (!Number.isFinite(delay) || delay < 0) {
			throw new Error(`cannot delay event by ${delay}`);
		}
		if (!this.scripts.includes(script)) return false;
		this.scheduledEvents.push({
			dueAt: this.now + delay,
			script,
			event: {
				name,
				args: args.map(cloneValue),
				detected: detected?.map(entry => ({ ...entry })),
			},
		});
		return true;
	}

	setScriptRunning(script: SimScript, running: boolean): void {
		if (running && script.fault) throw new Error(`cannot restart faulted script ${script.name}; reset it first`);
		if (script.running === running) return;
		script.running = running;
		this.trace.push({
			kind: 'script-state',
			time: this.now,
			script: script.name,
			prim: script.prim.name,
			detail: running ? 'running' : 'stopped',
		});
		if (!running) {
			return;
		}
		if (!script.started) {
			script.started = true;
			script.enqueue({ name: 'state_entry', args: [] });
		}
	}

	resetScript(script: SimScript): void {
		script.queue.length = 0;
		script.started = false;
		script.activeExecution = undefined;
		script.activeEvent = undefined;
		script.transitionTo = undefined;
		script.fault = undefined;
		script.startParameter = 0;
		script.executor.reset();
		script.currentState = script.ast.states.has('default')
			? 'default'
			: (script.ast.states.keys().next().value as string | undefined) ?? 'default';
		script.takesControls = false;
		script.permissions = 0;
		script.permissionsKey = NULL_KEY;
		script.timerInterval = 0;
		script.nextTimerAt = undefined;
		script.blockedUntil = this.now;
		script.timeOrigin = this.now;
		this.removeListeners(script);
		if (script.running) {
			script.started = true;
			script.enqueue({ name: 'state_entry', args: [] });
		}
	}

	get scripts(): SimScript[] {
		return this.linksets.flatMap(linkset => linkset.scripts);
	}

	callBuiltin(script: SimScript, name: string, args: Value[]): BuiltinResult {
		switch (name) {
			case 'llGetLinkNumber':
				return { handled: true, value: intValue(script.prim.link) };
			case 'llGetNumberOfPrims':
				return { handled: true, value: intValue(script.prim.linkset.prims.length) };
			case 'llGetKey':
				return { handled: true, value: keyValue(script.prim.key) };
			case 'llGetOwner':
				return { handled: true, value: keyValue(script.prim.linkset.owner) };
			case 'llGetOwnerKey': {
				const id = asString(args[0]!, name);
				const local = this.linksets.find(linkset =>
					linkset.key === id || linkset.prims.some(prim => prim.key === id));
				return {
					handled: true,
					value: keyValue(local?.owner ?? this.objectOwners.get(id) ?? id),
				};
			}
			case 'llKey2Name': {
				const id = asString(args[0]!, name);
				const prim = this.linksets.flatMap(linkset => linkset.prims)
					.find(candidate => candidate.key === id);
				return {
					handled: true,
					value: stringValue(prim?.name ?? this.objectNames.get(id) ?? ''),
				};
			}
			case 'llSameGroup':
				return {
					handled: true,
					value: intValue(
						this.sameGroupAgents.has(asString(args[0]!, name)) ? 1 : 0,
					),
				};
			case 'llGetScriptName':
				return { handled: true, value: stringValue(script.name) };
			case 'llGetStartParameter':
				return { handled: true, value: intValue(script.startParameter) };
			case 'llGetObjectName':
				return { handled: true, value: stringValue(script.prim.name) };
			case 'llSetObjectName': {
				const oldName = script.prim.name;
				const newName = asString(args[0]!, name).slice(0, 63);
				script.prim.setName(newName);
				this.trace.push({
					kind: 'prim-name',
					time: this.now,
					script: script.name,
					prim: newName,
					detail: `${oldName}:${newName}`,
				});
				return { handled: true };
			}
			case 'llGetInventoryKey': {
				const target = script.prim.script(asString(args[0]!, name));
				return { handled: true, value: keyValue(target?.assetKey ?? NULL_KEY) };
			}
			case 'llGetInventoryType':
				return {
					handled: true,
					// INVENTORY_SCRIPT is 10 and INVENTORY_NONE is -1.
					value: intValue(script.prim.script(asString(args[0]!, name)) ? 10 : -1),
				};
			case 'llGenerateKey': {
				const suffix = this.nextGeneratedKey.toString(16).padStart(12, '0');
				this.nextGeneratedKey += 1;
				return {
					handled: true,
					value: keyValue(`90000000-0000-0000-0000-${suffix}`),
				};
			}
			case 'llGetLinkKey': {
				const prim = script.prim.linkset.prim(asInteger(args[0]!, name));
				return { handled: true, value: keyValue(prim?.key ?? NULL_KEY) };
			}
			case 'llGetUnixTime':
				return { handled: true, value: intValue(this.unixTimeBase + Math.floor(this.now)) };
			case 'llGetRegionCorner':
				return {
					handled: true,
					value: vectorValue(this.regionCorner),
				};
			case 'llGetPos':
			case 'llGetRootPosition':
				return {
					handled: true,
					value: vectorValue(script.prim.linkset.options.position ?? [0, 0, 0]),
				};
			case 'llGetRootRotation':
				return {
					handled: true,
					value: rotationValue(
						this.agentRotations.get(script.prim.linkset.owner)
							?? script.prim.linkset.options.rootRotation
							?? [0, 0, 0, 1],
					),
				};
			case 'llGetObjectDetails': {
				const target = asString(args[0]!, name);
				const parameters = args[1]?.kind === 'value'
					&& args[1].type === 'list' ? args[1].value : [];
				const values: Value[] = [];
				for (const parameter of parameters) {
					switch (asInteger(parameter, name)) {
						case 1:
							values.push(stringValue(
								this.objectNames.get(target)
									?? this.linksets.flatMap(linkset => linkset.prims)
										.find(prim => prim.key === target)?.name
									?? '',
							));
							break;
						case 3:
							values.push(vectorValue(
								this.objectPositions.get(target)
									?? this.positionForWorldKey(target)
									?? [0, 0, 0],
							));
							break;
						case 4:
							values.push(rotationValue(
								this.objectRotations.get(target) ?? [0, 0, 0, 1],
							));
							break;
						case 18:
							values.push(keyValue(this.objectRoots.get(target) ?? target));
							break;
						case 19:
							values.push(intValue(this.objectAttachedPoints.get(target) ?? 0));
							break;
						default:
							values.push(stringValue(''));
							break;
					}
				}
				return { handled: true, value: listValue(values) };
			}
			case 'llGetAgentSize': {
				const target = asString(args[0]!, name);
				const present = target === script.prim.linkset.owner
					|| this.sensorAgents.some(agent => agent.key === target);
				return {
					handled: true,
					value: vectorValue(present ? [0.45, 0.6, 1.8] : [0, 0, 0]),
				};
			}
			case 'llGetTime':
				return { handled: true, value: floatValue(this.now - script.timeOrigin) };
			case 'llSleep': {
				const delay = asNumber(args[0]!, name);
				if (!Number.isFinite(delay)) throw new Error('llSleep requires a finite duration');
				return { handled: true, delay: Math.max(0, delay) };
			}
			case 'llResetTime':
				script.timeOrigin = this.now;
				return { handled: true };
			case 'llGetAndResetTime': {
				const elapsed = this.now - script.timeOrigin;
				script.timeOrigin = this.now;
				return { handled: true, value: floatValue(elapsed) };
			}
			case 'llSetTimerEvent': {
				const interval = asNumber(args[0]!, name);
				if (!Number.isFinite(interval) || interval <= 0) {
					script.timerInterval = 0;
					script.nextTimerAt = undefined;
				} else {
					script.timerInterval = interval;
					script.nextTimerAt = this.now + interval;
				}
				return { handled: true };
			}
			case 'llSensor': {
				const wantedName = asString(args[0]!, name);
				const wantedKey = asString(args[1]!, name);
				const typeMask = asInteger(args[2]!, name);
				const entities: SensorEntity[] = [];
				if ((typeMask & 0x1) !== 0) {
					entities.push(...this.sensorAgents.map(agent => ({
						...agent,
						type: agent.type ?? 0x1,
					})));
				}
				if ((typeMask & 0xe) !== 0) {
					entities.push(...this.sensorObjects.filter(entity =>
						(entity.type & typeMask) !== 0));
				}
				const matches = entities
					.filter(entity => !wantedName || entity.name === wantedName)
					.filter(entity =>
						!wantedKey || wantedKey === NULL_KEY || entity.key === wantedKey)
					.slice(0, 16);
				if (matches.length > 0) {
					script.enqueue({
						name: 'sensor',
						args: [intValue(matches.length)],
						detected: matches.map(agent => ({ ...agent })),
					});
				} else {
					script.enqueue({ name: 'no_sensor', args: [] });
				}
				return { handled: true };
			}
			case 'llDetectedKey': {
				const detected = this.activeDetected[asInteger(args[0]!, name)];
				return { handled: true, value: keyValue(detected?.key ?? NULL_KEY) };
			}
			case 'llDetectedName': {
				const detected = this.activeDetected[asInteger(args[0]!, name)];
				return { handled: true, value: stringValue(detected?.name ?? '') };
			}
			case 'llDetectedType': {
				const detected = this.activeDetected[asInteger(args[0]!, name)];
				return { handled: true, value: intValue(detected?.type ?? 0) };
			}
			case 'llSetAgentRot': {
				if ((script.permissions & PERMISSION_TRIGGER_ANIMATION) === 0) {
					throw new Error(
						`${script.name} called llSetAgentRot without PERMISSION_TRIGGER_ANIMATION`,
					);
				}
				const rotation = asRotation(args[0]!, name);
				this.agentRotations.set(script.prim.linkset.owner, rotation);
				this.trace.push({
					kind: 'agent-rotation',
					time: this.now,
					script: script.name,
					prim: script.prim.name,
					detail: `${script.prim.linkset.owner}:${rotation.join(',')}:${asInteger(args[1]!, name)}`,
				});
				return { handled: true };
			}
			case 'llPushObject': {
				const target = asString(args[0]!, name);
				const impulse = asVector(args[1]!, name);
				const angular = asVector(args[2]!, name);
				this.trace.push({
					kind: 'push',
					time: this.now,
					script: script.name,
					prim: script.prim.name,
					detail: `${target}:${impulse.join(',')}:${angular.join(',')}:${asInteger(args[3]!, name)}`,
				});
				return { handled: true };
			}
			case 'llMoveToTarget': {
				const position = asVector(args[0]!, name);
				this.movementTargets.set(script.prim.linkset.owner, position);
				this.trace.push({
					kind: 'move-target',
					time: this.now,
					script: script.name,
					prim: script.prim.name,
					detail: `${script.prim.linkset.owner}:${position.join(',')}:${asNumber(args[1]!, name)}`,
				});
				return { handled: true };
			}
			case 'llStopMoveToTarget':
				this.movementTargets.delete(script.prim.linkset.owner);
				this.trace.push({
					kind: 'move-stop',
					time: this.now,
					script: script.name,
					prim: script.prim.name,
					detail: script.prim.linkset.owner,
				});
				return { handled: true };
			case 'llLinkParticleSystem':
				this.trace.push({
					kind: 'particles',
					time: this.now,
					script: script.name,
					prim: script.prim.name,
					detail: `${asInteger(args[0]!, name)}:${lslString(args[1]!)}`,
				});
				return { handled: true };
			case 'llSetLinkPrimitiveParamsFast': {
				const target = asInteger(args[0]!, name);
				const rules = args[1];
				if (rules?.kind !== 'value' || rules.type !== 'list') {
					throw new Error(`${name} requires a list of primitive parameters`);
				}
				this.setPrimitiveParameters(script, target, rules.value, name);
				return { handled: true };
			}
			case 'llSetText':
				this.setPrimText(
					script,
					script.prim,
					asString(args[0]!, name),
					asVector(args[1]!, name),
					asNumber(args[2]!, name),
				);
				return { handled: true };
			case 'llPlaySound':
				this.trace.push({
					kind: 'sound',
					time: this.now,
					script: script.name,
					prim: script.prim.name,
					detail: `${lslString(args[0]!)}:${asNumber(args[1]!, name)}`,
				});
				return { handled: true };
			case 'llDialog':
			case 'llTextBox':
				this.trace.push({
					kind: 'dialog',
					time: this.now,
					script: script.name,
					prim: script.prim.name,
					detail: args.map(lslString).join(':'),
				});
				return { handled: true, delay: 1 };
			case 'llMessageLinked':
				this.messageLinked(
					script,
					asInteger(args[0]!, name),
					asInteger(args[1]!, name),
					asString(args[2]!, name),
					asString(args[3]!, name),
				);
				return { handled: true };
			case 'llListen':
				return {
					handled: true,
					value: intValue(this.listen(
						script,
						asInteger(args[0]!, name),
						asString(args[1]!, name),
						asString(args[2]!, name),
						asString(args[3]!, name),
					)),
				};
			case 'llListenRemove':
				this.removeListener(script, asInteger(args[0]!, name));
				return { handled: true };
			case 'llListenControl':
				this.controlListener(script, asInteger(args[0]!, name), asInteger(args[1]!, name) !== 0);
				return { handled: true };
			case 'llWhisper':
			case 'llSay':
			case 'llShout':
			case 'llRegionSay':
				this.chat(script, asInteger(args[0]!, name), asString(args[1]!, name), undefined,
					name === 'llWhisper' ? 10 : name === 'llSay' ? 20 : name === 'llShout' ? 100 : Infinity);
				return { handled: true };
			case 'llRegionSayTo':
				this.chat(
					script,
					asInteger(args[1]!, name),
					asString(args[2]!, name),
					asString(args[0]!, name),
				);
				return { handled: true };
			case 'llLinksetDataRead':
				return {
					handled: true,
					value: stringValue(script.prim.linkset.data.get(asString(args[0]!, name)) ?? ''),
				};
			case 'llLinksetDataFindKeys': {
				const expression = asString(args[0]!, name);
				const start = Math.max(0, asInteger(args[1]!, name));
				const count = Math.max(0, asInteger(args[2]!, name));
				let matcher: RegExp;
				try {
					matcher = new RegExp(expression);
				} catch {
					return { handled: true, value: listValue([]) };
				}
				const matches = [...script.prim.linkset.data.keys()]
					.filter(key => matcher.test(key))
					.sort()
					.slice(start, start + count)
					.map(stringValue);
				return { handled: true, value: listValue(matches) };
			}
			case 'llLinksetDataWrite':
				return {
					handled: true,
					value: intValue(this.writeLinksetData(
						script.prim.linkset,
						asString(args[0]!, name),
						asString(args[1]!, name),
					)),
				};
			case 'llLinksetDataDelete':
				return {
					handled: true,
					value: intValue(this.deleteLinksetData(script.prim.linkset, asString(args[0]!, name))),
				};
			case 'llLinksetDataReset':
				this.resetLinksetData(script.prim.linkset);
				return { handled: true };
			case 'llSetScriptState': {
				const target = script.prim.script(asString(args[0]!, name));
				if (target) this.setScriptRunning(target, asInteger(args[1]!, name) !== 0);
				return { handled: true, stopped: target === script && !script.running };
			}
			case 'llGetScriptState': {
				const target = script.prim.script(asString(args[0]!, name));
				return { handled: true, value: intValue(target?.running ? 1 : 0) };
			}
			case 'llResetOtherScript': {
				const target = script.prim.script(asString(args[0]!, name));
				if (target) this.resetScript(target);
				return { handled: true };
			}
			case 'llResetScript':
				return this.resetCurrentScript();
			case 'llRequestPermissions': {
				const agent = asString(args[0]!, name);
				const requested = asInteger(args[1]!, name);
				if (agent === NULL_KEY || requested === 0) {
					script.permissions = 0;
					script.permissionsKey = NULL_KEY;
					script.takesControls = false;
					return { handled: true };
				}
				// The initial model auto-grants attachment-owner requests. Interactive
				// permission policy for rezzed objects belongs to the richer world slice.
				script.permissionsKey = agent;
				script.permissions = script.prim.linkset.attached
					&& agent === script.prim.linkset.owner ? requested : 0;
				script.enqueue({
					name: 'run_time_permissions',
					args: [intValue(script.permissions)],
				});
				return { handled: true };
			}
			case 'llGetPermissions':
				return { handled: true, value: intValue(script.permissions) };
			case 'llGetPermissionsKey':
				return { handled: true, value: keyValue(script.permissionsKey) };
			case 'llTakeControls':
				if ((script.permissions & PERMISSION_TAKE_CONTROLS) === 0) {
					throw new Error(`${script.name} called llTakeControls without PERMISSION_TAKE_CONTROLS`);
				}
				script.takesControls = true;
				return { handled: true };
			case 'llReleaseControls':
				script.takesControls = false;
				return { handled: true };
			case 'llSetRemoteScriptAccessPin':
				script.prim.remoteScriptPin = asInteger(args[0]!, name);
				return { handled: true };
			case 'llRemoteLoadScriptPin': {
				const targetKey = asString(args[0]!, name);
				const scriptName = asString(args[1]!, name);
				const pin = asInteger(args[2]!, name);
				const running = asInteger(args[3]!, name) !== 0;
				const target = this.linksets.flatMap(linkset => linkset.prims)
					.find(prim => prim.key === targetKey);
				const source = script.prim.script(scriptName);
				const allowed = target !== undefined
					&& target !== script.prim
					&& target.linkset.owner === script.prim.linkset.owner
					&& pin !== 0
					&& target.remoteScriptPin === pin
					&& source !== undefined;
				if (allowed && target && source) {
					const installed = target.replaceScript({
						name: source.name,
						sourcePath: source.sourcePath,
						ast: source.ast,
						assetKey: source.assetKey,
						running,
						startParameter: asInteger(args[4]!, name),
						constants: source.options.constants,
					});
					if (running) {
						installed.started = true;
						installed.enqueue({ name: 'state_entry', args: [] });
					}
				}
				this.trace.push({
					kind: 'remote-load',
					time: this.now,
					script: script.name,
					prim: script.prim.name,
					detail: `${targetKey}:${scriptName}:${allowed ? 'ok' : 'rejected'}:${running ? 1 : 0}`,
				});
				return { handled: true, delay: 3 };
			}
			case 'llOwnerSay':
				this.trace.push({
					kind: 'owner-say',
					time: this.now,
					script: script.name,
					prim: script.prim.name,
					detail: asString(args[0]!, name),
				});
				return { handled: true };
			default:
				return { handled: false };
		}
	}

	private resetCurrentScript(): BuiltinResult {
		throw new ScriptResetSignal();
	}

	private nextTemporalEventAt(): number | undefined {
		let earliest: number | undefined;
		for (const script of this.scripts) {
			if (script.timerInterval <= 0 || script.nextTimerAt === undefined) continue;
			if (earliest === undefined || script.nextTimerAt < earliest) {
				earliest = script.nextTimerAt;
			}
		}
		for (const scheduled of this.scheduledEvents) {
			if (earliest === undefined || scheduled.dueAt < earliest) {
				earliest = scheduled.dueAt;
			}
		}
		return earliest;
	}

	private enqueueTemporalThrough(target: number): void {
		for (const script of this.scripts) {
			if (script.timerInterval <= 0 || script.nextTimerAt === undefined
				|| script.nextTimerAt > target) continue;
			script.enqueue({ name: 'timer', args: [] });
			const elapsedIntervals = Math.floor(
				(target - script.nextTimerAt) / script.timerInterval,
			) + 1;
			script.nextTimerAt += elapsedIntervals * script.timerInterval;
		}
		const due = this.scheduledEvents
			.filter(scheduled => scheduled.dueAt <= target)
			.sort((left, right) => left.dueAt - right.dueAt);
		for (const scheduled of due) {
			const index = this.scheduledEvents.indexOf(scheduled);
			if (index >= 0) this.scheduledEvents.splice(index, 1);
			scheduled.script.enqueue(scheduled.event);
		}
	}

	private targetPrims(sender: SimScript, target: number): SimPrim[] {
		return sender.prim.linkset.prims.filter(prim => {
			if (target > 0) return prim.link === target;
			if (target === -1) return true;
			if (target === -2) return prim !== sender.prim;
			if (target === -3) return prim.link !== 1;
			if (target === -4) return prim === sender.prim;
			return false;
		});
	}

	private setPrimitiveParameters(
		script: SimScript,
		target: number,
		rules: Value[],
		context: string,
	): void {
		let index = 0;
		while (index < rules.length) {
			const rule = asInteger(rules[index]!, context);
			index += 1;
			if (rule !== PRIM_TEXT) {
				throw new Error(`${context} does not simulate primitive parameter ${rule}`);
			}
			if (index + 2 >= rules.length) {
				throw new Error(`${context} received incomplete PRIM_TEXT parameters`);
			}
			const text = asString(rules[index]!, context);
			const color = asVector(rules[index + 1]!, context);
			const alpha = asNumber(rules[index + 2]!, context);
			index += 3;
			for (const prim of this.targetPrims(script, target)) {
				this.setPrimText(script, prim, text, color, alpha);
			}
		}
	}

	private setPrimText(
		script: SimScript,
		prim: SimPrim,
		text: string,
		color: [number, number, number],
		alpha: number,
	): void {
		prim.hoverText = text;
		prim.hoverTextColor = [...color];
		prim.hoverTextAlpha = alpha;
		this.trace.push({
			kind: 'prim-text',
			time: this.now,
			script: script.name,
			prim: prim.name,
			detail: `${prim.link}:${text}:${color.join(',')}:${alpha}`,
		});
	}

	private messageLinked(sender: SimScript, target: number, number: number, text: string, id: string): void {
		const targets = this.targetPrims(sender, target);
		for (const prim of targets) {
			for (const recipient of prim.scripts) {
				recipient.enqueue({
					name: 'link_message',
					args: [
						intValue(sender.prim.link),
						intValue(number),
						stringValue(text),
						keyValue(id),
					],
				});
			}
		}
		this.trace.push({
			kind: 'linked-message',
			time: this.now,
			script: sender.name,
			prim: sender.prim.name,
			detail: `${target}:${number}:${text}:${id}`,
		});
	}

	private listen(script: SimScript, channel: number, name: string, id: string, message: string): number {
		const handle = this.nextListenerHandle;
		this.nextListenerHandle += 1;
		this.listeners.push({ handle, script, channel, name, id, message, active: true });
		return handle;
	}

	private removeListener(script: SimScript, handle: number): void {
		const index = this.listeners.findIndex(listener =>
			listener.script === script && listener.handle === handle);
		if (index >= 0) this.listeners.splice(index, 1);
	}

	private controlListener(script: SimScript, handle: number, active: boolean): void {
		const listener = this.listeners.find(candidate =>
			candidate.script === script && candidate.handle === handle);
		if (listener) listener.active = active;
	}

	private removeListeners(script: SimScript): void {
		for (let index = this.listeners.length - 1; index >= 0; index -= 1) {
			if (this.listeners[index]!.script === script) this.listeners.splice(index, 1);
		}
	}

	removeScriptRuntime(script: SimScript): void {
		script.queue.length = 0;
		script.activeExecution = undefined;
		script.activeEvent = undefined;
		script.transitionTo = undefined;
		script.running = false;
		script.timerInterval = 0;
		script.nextTimerAt = undefined;
		this.removeListeners(script);
		for (let index = this.scheduledEvents.length - 1; index >= 0; index -= 1) {
			if (this.scheduledEvents[index]!.script === script) this.scheduledEvents.splice(index, 1);
		}
	}

	private chat(sender: SimScript, channel: number, message: string, target?: string, range = Infinity): void {
		const speakerName = sender.prim.name;
		const speakerId = sender.prim.key;
		const targetLinkset = target ? this.linksets.find(linkset =>
			linkset.key === target || linkset.prims.some(prim => prim.key === target)) : undefined;
		for (const listener of this.listeners) {
			if (!listener.active || !listener.script.effectiveRunning) continue;
			if (listener.script.prim === sender.prim) continue;
			if (listener.channel !== channel) continue;
			const from = sender.prim.linkset.options.position ?? [0, 0, 0];
			const to = listener.script.prim.linkset.options.position ?? [0, 0, 0];
			if (Math.hypot(from[0] - to[0], from[1] - to[1], from[2] - to[2]) > range) continue;
			if (target && listener.script.prim.key !== target
				&& listener.script.prim.linkset.key !== target
				&& listener.script.prim.linkset !== targetLinkset
				&& !(channel !== 0 && listener.script.prim.linkset.attached
					&& listener.script.prim.linkset.owner === target)) continue;
			if (listener.name && listener.name !== speakerName) continue;
			if (listener.id && listener.id !== NULL_KEY && listener.id !== speakerId) continue;
			if (listener.message && listener.message !== message) continue;
			listener.script.enqueue({
				name: 'listen',
				args: [
					intValue(channel),
					stringValue(speakerName),
					keyValue(speakerId),
					stringValue(message),
				],
			});
		}
		this.trace.push({
			kind: 'chat',
			time: this.now,
			script: sender.name,
			prim: sender.prim.name,
			detail: `${target ?? '*'}:${channel}:${message}`,
		});
	}

	private positionForWorldKey(target: string): [number, number, number] | undefined {
		for (const linkset of this.linksets) {
			if (linkset.key === target || linkset.owner === target
				|| linkset.prims.some(prim => prim.key === target)) {
				return linkset.options.position ?? [0, 0, 0];
			}
		}
		return undefined;
	}

	private writeLinksetData(linkset: SimLinkset, name: string, value: string): number {
		if (!name) return 2;
		if (!value) return this.deleteLinksetData(linkset, name);
		if (linkset.data.get(name) === value) return 5;
		let bytes = Buffer.byteLength(name) + Buffer.byteLength(value);
		for (const [existingName, existingValue] of linkset.data) {
			if (existingName !== name) bytes += Buffer.byteLength(existingName) + Buffer.byteLength(existingValue);
		}
		if (bytes > 131_072) return 1;
		linkset.data.set(name, value);
		this.linksetDataChanged(linkset, 1, name, value);
		return 0;
	}

	private deleteLinksetData(linkset: SimLinkset, name: string): number {
		if (!name) return 2;
		if (!linkset.data.has(name)) return 4;
		linkset.data.delete(name);
		this.linksetDataChanged(linkset, 2, name, '');
		return 0;
	}

	private resetLinksetData(linkset: SimLinkset): void {
		if (linkset.data.size === 0) return;
		linkset.data.clear();
		this.linksetDataChanged(linkset, 0, '', '');
	}

	private linksetDataChanged(linkset: SimLinkset, action: number, name: string, value: string): void {
		for (const script of linkset.scripts) {
			script.enqueue({
				name: 'linkset_data',
				args: [intValue(action), stringValue(name), stringValue(value)],
			});
		}
		this.trace.push({
			kind: 'linkset-data',
			time: this.now,
			detail: `${action}:${name}:${value}`,
		});
	}
}
