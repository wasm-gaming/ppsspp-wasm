/**
 * What must NOT compile.
 *
 * Every `@ts-expect-error` below is an assertion in the strict sense: the line fails
 * the build if the error ever *stops* happening. That is what makes this file a test
 * rather than a comment — closing the payloads is only worth anything if the closure
 * actually rejects something.
 */
import type { EngineSDKConstructor } from '@wasm-gaming/engine-specs';

import { PpssppSDK } from '../src/ppsspp-wasm.js';

declare const element: HTMLElement;
declare const iso: File;

const sdk = new PpssppSDK();

// ---- The payloads are closed ----

// @ts-expect-error - PPSSPP has no such setting, and inventing one would silently do nothing.
sdk.config({ ambientOcclusion: true });

// @ts-expect-error - `internalResolution` is a fixed set of multipliers, not any number.
sdk.config({ internalResolution: 7 });

// @ts-expect-error - 'bilinear' is not one of the three choices the descriptor advertises.
sdk.config({ textureFiltering: 'bilinear' });

// @ts-expect-error - the CPU cores that cannot exist in wasm are not offered.
sdk.config({ cpuCore: 'jit' });

// @ts-expect-error - `volume` is a number on PPSSPP's 0-10 scale, not a string.
sdk.config({ volume: 'loud' });

// @ts-expect-error - `stateSlot` belongs to options; the payloads do not overlap.
sdk.config({ stateSlot: 1 });

// @ts-expect-error - a game is a Blob or bytes, not a path the host made up.
sdk.assets({ game: '/roms/daxter.iso' });

// ---- Read and write are different shapes ----

// @ts-expect-error - the descriptor shape is what a getter returns, never what a setter takes.
sdk.config({ internalResolution: { value: 2, default: 1 } });

// A read takes no argument and answers descriptors, not values.
const reading: Promise<unknown> = sdk.config();
void reading;

// ---- Events ----

// @ts-expect-error - this engine emits no such event, and a typo would otherwise be silent.
sdk.on('frameDrop', () => {});

sdk.on('gameInfo', (event) => {
  // @ts-expect-error - the payload travels under `detail`, not as the argument itself.
  void event.id;
  // @ts-expect-error - `gameInfo` carries an id and a title, and nothing else.
  void event.detail.publisher;
});

sdk.on('error', (event) => {
  // @ts-expect-error - `error` carries an Error, so this is not a string.
  const message: string = event.detail;
  void message;
});

// @ts-expect-error - `off` takes the listener too: dropping every listener for a type
// would silence a component that subscribed independently.
sdk.off('exit');

// ---- The surface ----

// @ts-expect-error - `mount` takes an element, not a selector.
sdk.mount('#stage');

// @ts-expect-error - there is no way in but `start()`; the removed `boot()` stays removed.
sdk.boot();

// @ts-expect-error - `start` opens a session with options, not with config.
sdk.start({ internalResolution: 2 });

// ---- A closed engine is not an open one ----

// An engine that leaves its payloads open is typed `EngineSDKConstructor` with no
// argument. This one closed them, and the two are deliberately not interchangeable:
// `EngineInit` sits in argument position, so accepting the open form would mean
// accepting a host that writes `config({ anything: true })` — exactly the checking
// closing the payloads bought.
// @ts-expect-error
const asOpen: EngineSDKConstructor = PpssppSDK;
void asOpen;

// ---- Chaining ----

// A write keeps the chain; the factory hands back the factory.
const chained: PpssppSDK = sdk.config({ frameSkip: 1 }).mount(element).assets({ game: iso });
void chained;

export {};
