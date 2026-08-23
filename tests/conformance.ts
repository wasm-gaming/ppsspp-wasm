/**
 * Does this engine satisfy the contract, and is the result pleasant to drive?
 *
 * Two different questions, and both are answered by compiling this file. There is
 * nothing to run: `make typecheck-tests` passing *is* the assertion, which is why
 * every line below is written the way a host would write it rather than the way a
 * test usually is.
 */
import type { EngineSDK, EngineSDKConstructor } from '@wasm-gaming/engine-specs';

import { PpssppPlay, PpssppSDK } from '../src/ppsspp-wasm.js';
import type { PpssppPayloads } from '../src/payloads.js';

/**
 * The one line that belongs in an engine's CI.
 *
 * Note what it proves beyond "the methods exist": identity is static and readable
 * without constructing anything, and the extra `loader` parameter on the constructor
 * — this engine's own, invisible to the contract — does not stop the class from being
 * a plain `EngineSDKConstructor`.
 */
export const contract: EngineSDKConstructor<PpssppPayloads> = PpssppSDK;

declare const element: HTMLElement;
declare const iso: File;
declare const state: File;

// ---- A host drives it, knowing nothing but the contract ----

export async function host(): Promise<void> {
  const sdk: EngineSDK<PpssppPayloads> = new PpssppSDK({
    config: { internalResolution: 2, volume: 6 },
    // Registered in the constructor, which is the one shape the chain cannot express.
    on: { error: (event) => console.error(event.detail.message) },
  });

  const play = await sdk
    .assets({ game: iso, saveState: state })
    .storage({ namespace: 'daxter' })
    .mount(element)
    // Subscribing before there is an engine is the normal way, not a special case —
    // and this listener is live before `start()` has finished opening the session.
    .on('gameInfo', (event) => {
      const id: string = event.detail.id;
      const title: string = event.detail.title;
      void `${id} ${title}`;
    })
    .on('fps', (event) => {
      const rate: number = event.detail.fps;
      void rate;
    })
    // A core event, which this engine never declared and cannot forget.
    .on('exit', (event) => {
      const nothing: void = event.detail;
      void nothing;
    })
    .start({ stateSlot: 1, resume: true });

  // The getter answers with a descriptor per key — enough to paint a settings screen
  // without the host knowing a single key name.
  const config = await play.config();
  const resolution: 1 | 2 | 3 | 4 | 5 = config.internalResolution.value;
  const choices: readonly (1 | 2 | 3 | 4 | 5)[] | undefined = config.internalResolution.enum;
  const live: boolean | undefined = config.internalResolution.live;
  void `${resolution} ${choices?.length} ${live}`;

  const assets = await play.assets();
  const accepts: readonly string[] | undefined = assets.game.allowedTypes;
  void accepts;

  // Writing keeps the chain, and the chain is a promise of the engine.
  await play.config({ frameSkip: 1 }).options({ fastForward: true }).restart({ stateSlot: 2 });

  await play.destroy();
}

// ---- The engine's own surface, beyond the contract ----

export function ownMembers(play: PpssppPlay): void {
  // Not contract members: `pause`/`resume` are this engine's, and what makes them
  // legible to a host that has never heard of PPSSPP is that they emit core events.
  play.pause('host-menu');
  play.resume('host-menu');
}
