# LSL linkset simulator

Run cooperating LSL scripts in a deterministic local world. This experimental package helps test message routing, shared data, script lifecycle, and asynchronous workflows without a viewer. It is a TypeScript test library, not a replacement for the Second Life simulator.

## Project layout

Arrange test scripts like object inventory:

```text
project/
  linkset/
    linkset.json
    prims/
      root/
        prim.json
        scripts/
          sender.lsl
      worker/
        prim.json
        scripts/
          receiver.lsl
```

The loader accepts either the project directory or its `linkset` directory. A `scripts` directory is optional, so empty prims are valid.

`linkset.json` can set `name`, `key`, `owner`, and `attached`:

```json
{
  "name": "Message test",
  "attached": false
}
```

Use `{ "link": 1 }` for the root's `prim.json` and `{ "link": 2 }` for the worker's. Explicit link numbers make routing tests easier to read; the loader assigns unused numbers when omitted. Names default to directory names, and omitted keys receive deterministic UUIDs.

A prim manifest can also set its `name`, `key`, and initial script state:

```json
{
  "link": 2,
  "scripts": {
    "receiver.lsl": { "running": false }
  }
}
```

Scripts are running by default. The manifest above stops the receiver until a test starts it.

## A request/reply test

The original fixtures in [tests/fixtures/communication](tests/fixtures/communication) demonstrate linked messages, cross-prim chat, shared data, timers, and script inventory. A test can load them, inject a touch, and inspect the reply:

```ts
import assert from 'node:assert/strict';
import { intValue, loadLinksetProject } from '@lsl-lsp/simulator';

// This path assumes the test runs from the repository root.
const { world, linkset } = await loadLinksetProject(
  'packages/simulator/tests/fixtures/communication',
);
world.start();
world.runUntilIdle();

const sender = linkset.prim(1)!.script('sender.lsl')!;
world.fireEvent(sender, 'touch_start', [intValue(1)]);
world.runUntilIdle();

assert.equal(linkset.data.get('root:reply'), '2:pong:request-1');
assert.equal(linkset.data.get('root:chat'), 'ack');
assert.ok(world.trace.some(entry => entry.kind === 'linked-message'));
```

Linkset data belongs to the whole object. Linked messages reach scripts in the selected prims. Chat cannot be heard by another script in the speaking prim; a script in another prim can listen. This distinction makes small routing fixtures useful for catching communication mistakes.

Load more objects into one world by passing `{ world }` to subsequent `loadLinksetProject` calls. Supply `{ owner }` to override a fixture's owner or `{ defs }` to use custom definitions.

## Time and lifecycle

Time is virtual; tests do not need wall-clock sleeps.

- `world.runUntilIdle()` drains queued and suspended work, advancing time as needed to resume delayed calls.
- `world.advanceTime(seconds)` processes work up to a specific virtual-time boundary. Execution can remain suspended beyond that boundary.
- `world.fireEventAfter(script, seconds, name, args)` schedules an injected event. Future timers or injected events alone do not make `runUntilIdle()` advance time; use `advanceTime()`.
- `world.setScriptRunning(script, false)` stops a script; `true` resumes it. `world.resetScript(script)` resets its runtime.
- `linkset.setOwner(uuid)` and `linkset.setAttached(boolean)` enqueue lifecycle events and revoke runtime permissions. These methods do not advance time.

```ts
world.fireEventAfter(sender, 8, 'touch_start', [intValue(1)]);
world.advanceTime(8);

linkset.setAttached(true);
world.runUntilIdle();
```

Ready scripts run round-robin. Timers coalesce when a timer event is already queued. Supported delaying calls suspend the current execution, including nested function calls, so other scripts can run. The default event-processing limit prevents tests from running indefinitely; pass a larger limit to the run methods only when the workload requires it.

Inspect `world.trace` for events, chat, linked messages, dialogs, script state changes, remote loading, and other effects. Script globals are available through `script.getGlobal(name)`; per-prim hover text is exposed as `hoverText`, `hoverTextColor`, and `hoverTextAlpha`.

Unsupported built-ins and runtime errors stop the script, add a `runtime-error` trace, and throw an error identifying the source. Reset a failed script before restarting it.

## Coverage and limits

The runtime handles common expressions and statements, globals and user functions, state changes, injected events, linked messages, filtered chat, linkset data, timers, script start/stop/reset, and simplified remote script loading with per-prim PINs. Movement, particles, sound, and agent rotation produce observable traces or test state rather than a rendered world.

Some behavior is deliberately approximate:

- Sensors use injected candidates; range, arc, occlusion, and sensor timing are not modeled.
- Chat range uses each linkset's position; child-prim offsets are not modeled.
- Remote loading uses a simplified same-owner permission model.
- Attachment-owner permission requests are granted automatically. Control-taking and no-script parcel behavior are approximations.
- Detach/reattach models lifecycle events and permission changes, without an inventory-resident object between calls.
- A state change from inside `state_exit` is currently unsupported and throws an error.
- Physics, viewer RLV handling, bytecode, heap/stack limits, garbage collection, and CPU scheduling are not simulated.

Use Second Life probes for uncertain LSL semantics and simulator-specific limits. Local probe scripts and captured results belong in ignored `.local` directories; portable regression fixtures should be small, original, and independent of application frameworks.

## Development

From the repository root:

```sh
pnpm build
pnpm -C packages/simulator test
pnpm -C packages/simulator lint
```
