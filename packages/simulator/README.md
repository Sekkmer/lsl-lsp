# LSL linkset simulator

Run cooperating LSL scripts in a deterministic local world. This experimental package helps test message routing, shared data, script lifecycle, and asynchronous workflows without a viewer. It is a JavaScript/TypeScript test library, not a replacement for the Second Life simulator.

## Run an example

The simulator currently lives in this source checkout; it is not published as a separate npm package or included in the standalone CLI bundle. With Node.js 22+ and pnpm installed, run from the repository root:

```sh
git submodule update --init --recursive
pnpm install
pnpm --filter '@lsl-lsp/simulator...' build
node packages/simulator/examples/message-world/run.cjs
```

Expected output:

```text
PASS: rezzed panel -> attachment root -> child prim -> panel reply
```

The [example directory](examples/message-world) contains two objects and a JavaScript runner. A rezzed panel sends private chat to its owner's attachment. The attachment's root forwards the request to a child prim with a linked message, then returns the reply to the panel. The runner checks the reply and verifies that the objects have separate linkset data.

Use `node /path/to/lsl-lsp/packages/simulator/examples/message-world/run.cjs` to run it from another directory. The runner resolves its fixtures relative to itself.

## Describe one object

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

Each `linkset` is one object, whether it is attached or rezzed. Each directory under `prims` is one linked prim, and each `.lsl` file directly inside a prim's `scripts` directory is one inventory script. Several scripts can share a prim, and separate prims can contain scripts with the same filename. A `scripts` directory is optional, so empty prims are valid.

The loader accepts `project/`, `project/linkset/`, or another directory containing `prims/` directly. It does not recursively search for objects or scripts.

`linkset.json` describes the object:

```json
{
  "name": "Message test",
  "owner": "20000000-0000-0000-0000-000000000001",
  "attached": false
}
```

| Field | Meaning and default |
| --- | --- |
| `name` | Object name; defaults to the linkset directory's name |
| `key` | Object UUID; generated from the absolute linkset path if omitted |
| `owner` | Avatar UUID; also generated from the path if omitted |
| `attached` | `true` for an attachment, `false` for a rezzed object; defaults to `true` |

These manifests are optional, but explicit owners and attachment flags make tests easier to understand. Generated IDs are repeatable at the same path; moving a fixture changes its generated IDs. Different fixture directories get different default owners, so set the same `owner` when modeling objects belonging to one avatar. Loading with `{ owner: avatarUuid }` overrides the manifest owner.

Use `{ "link": 1 }` for the root's `prim.json` and `{ "link": 2 }` for the worker's. Link numbers must be unique and contiguous starting at 1. The directory name `root` is just a convention; `link: 1` identifies the root. When link numbers are omitted, the loader processes directories alphabetically and assigns unused numbers.

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

The other prim fields are `name` (defaults to the directory name) and `key` (generated from the object key and link number). The `scripts` object uses exact inventory filenames; each entry accepts `{ "running": false }` or the shorthand `false`. It configures initial running/stopped status, not a named LSL state. Scripts begin in their normal initial state when started.

Keep include-only headers out of `scripts/*.lsl`, which would load them as separate inventory scripts. Use `.lslh` headers or a separate include directory. Include lookup covers the script directory, its prim directory, the linkset directory, and the project directory passed to the loader; for example, a project-level `include/protocol.lslh` can be referenced as `#include "include/protocol.lslh"`.

## Put several objects in one world

A world is created by JavaScript or TypeScript code. There is no `world.json` format or automatic scan of an `objects` directory. Group object projects however you prefer and load each into the same world:

```text
message-world/
  run.cjs
  attachment/
    linkset/
      linkset.json              # attached: true, owner A
      prims/
        root/prim.json          # link 1
        root/scripts/bridge.lsl
        worker/prim.json        # link 2
        worker/scripts/worker.lsl
  panel/
    linkset/
      linkset.json              # attached: false, owner A
      prims/
        root/prim.json          # link 1 in this object
        root/scripts/panel.lsl
```

In a workspace that depends on `@lsl-lsp/simulator`, the setup is:

```ts
import { SimulatorWorld, intValue, loadLinksetProject } from '@lsl-lsp/simulator';

const world = new SimulatorWorld();
const { linkset: attachment } = await loadLinksetProject('message-world/attachment', { world });
const { linkset: panel } = await loadLinksetProject('message-world/panel', { world });

world.start();
world.runUntilIdle(); // Let each script initialize its listeners.

const panelScript = panel.prim(1)!.script('panel.lsl')!;
world.fireEvent(panelScript, 'touch_start', [intValue(1)]);
world.runUntilIdle();

console.log(attachment.data.get('worker:received')); // ping
console.log(panel.data.get('panel:reply'));          // pong
```

Those relative paths are resolved from the process working directory. The [runnable CommonJS version](examples/message-world/run.cjs) uses `__dirname` for stable paths and imports this checkout's built simulator directly; it needs no package published to npm.

Each object has its own prim numbering, inventory, and data store. `llMessageLinked` and linkset data stay within that object. Region chat can cross objects. `llRegionSayTo(avatarUuid, nonzeroChannel, ...)` reaches that avatar's attachments, while targeting an object/prim UUID addresses that object. Scripts in the speaking prim cannot hear their own chat.

For another avatar, load more attachments with a different `owner`; no rendered avatar or separate avatar directory is required. `attached` is a logical flag, not a wearable body/attachment-point simulation. To place objects for supported distance calculations, set their public options in the test:

```ts
panel.options.position = [128, 128, 20];
attachment.options.position = [130, 128, 20];
```

Position and rotation are currently programmatic `LinksetOptions`, not `linkset.json` fields. For generated scenarios you can also use `world.addLinkset(...)`, `linkset.addPrim(...)`, and `prim.addScript(...)` with a parsed LSL AST instead of directories.

The original [communication fixtures](tests/fixtures/communication) and [package tests](tests/simulator.test.ts) cover additional cases such as timers, stopped scripts, remote loading, and hover text. Supply `{ defs }` to `loadLinksetProject` to use custom definitions; otherwise it loads the checkout's bundled Second Life definitions.

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
