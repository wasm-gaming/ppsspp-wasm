/**
 * What this engine declares about its properties — the whole of what a host needs to
 * paint a settings screen without knowing a single key name, and without asking the
 * emulator anything.
 *
 * `default` appears **here and nowhere else**. `EnginePlayBase` seeds its starting
 * state from it, so the value the engine actually boots with and the value it
 * advertises as the default cannot drift apart.
 *
 * `live` is a promise to the host: `true` means changing it on a running session
 * applies now, `false` means it waits for `restart()`. Every `live: true` property
 * below has a binding in `settings.ts` to apply it with, and `tests/spec.test.mjs`
 * fails if one ever loses it — an unbacked `live: true` is a lie a host would act on
 * by not offering the restart the change actually needs.
 */
import type { EngineSpec } from '@wasm-gaming/engine-specs';
import type { PpssppPayloads } from './payloads.js';

export const spec: EngineSpec<PpssppPayloads> = {
  config: {
    internalResolution: {
      default: 1,
      enum: [1, 2, 3, 4, 5],
      description:
        'Multiplier over the PSP native 480×272. The biggest performance lever in the browser — 1× is the default here, unlike on desktop.',
      live: true,
    },
    textureFiltering: {
      default: 'auto',
      enum: ['auto', 'nearest', 'linear'],
      description: 'How textures are sampled. "auto" lets the game decide, as PPSSPP does by default.',
      live: true,
    },
    frameSkip: {
      default: 0,
      description: 'Frames the emulator may drop to keep up. 0 drops none.',
      live: true,
    },
    autoFrameSkip: {
      default: false,
      description: 'Let PPSSPP choose the skip rather than holding it at frameSkip.',
      live: true,
    },
    soundEnabled: { default: true, description: 'Emulate the PSP audio hardware at all.', live: true },
    volume: {
      default: 8,
      description: "Game volume on PPSSPP's own 0–10 scale, not a 0–1 gain.",
      live: true,
    },
    language: {
      default: 'en_US',
      description: "PPSSPP UI language file name, e.g. 'en_US', 'es_ES'.",
      live: true,
    },
    cpuCore: {
      default: 'ir-interpreter',
      enum: ['ir-interpreter', 'interpreter'],
      description:
        'WebAssembly cannot generate code at runtime, so PPSSPP\'s JIT does not exist in this build. The IR interpreter is several times faster than the plain one; the plain one is the fallback for a title the IR path miscompiles.',
      live: false,
    },
    threads: {
      default: 0,
      description:
        'Emscripten worker pool size. 0 derives it from navigator.hardwareConcurrency. Fixed when the module is instantiated, so it cannot be live.',
      live: false,
    },
  },

  options: {
    stateSlot: {
      default: 0,
      enum: [0, 1, 2, 3, 4],
      description: 'Which PPSSPP save state slot resume reads and the pause menu writes.',
      live: true,
    },
    resume: {
      default: false,
      description: 'Boot straight into stateSlot instead of starting the game from the top.',
      live: false,
    },
    fastForward: { default: false, description: 'Run unthrottled.', live: true },
    cheats: { default: false, description: 'Apply the cheat database, if one was supplied.', live: true },
  },

  assets: {
    game: {
      description:
        'The game. A Blob or File is mounted through WORKERFS and read lazily, so a full-size ISO costs nothing in the wasm heap; a Uint8Array is copied into memory and costs its own size again.',
      allowedTypes: ['.iso', '.cso', '.chd', '.pbp', '.elf', '.zip'],
      live: false,
    },
    saveState: {
      description: 'A PPSSPP save state, written into options.stateSlot before boot.',
      allowedTypes: ['.ppst'],
      live: false,
    },
    cheatDb: {
      description: "A cheat database in PPSSPP's own format. Inert unless options.cheats is on.",
      allowedTypes: ['.db', '.ini'],
      live: false,
    },
  },

  storage: {
    namespace: {
      default: 'ppsspp',
      description:
        'The IndexedDB-backed directory PPSSPP owns — its memory stick. Two games under one namespace share saves; two namespaces keep them apart.',
      live: false,
    },
    persist: {
      default: true,
      description:
        'Whether destroy() flushes the memory stick back to IndexedDB. Off leaves nothing behind, which is what a kiosk wants.',
      live: true,
    },
  },
};
