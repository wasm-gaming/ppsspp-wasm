/**
 * What this engine carries in each of the contract's four payloads.
 *
 * The split is the one `engine-specs` prescribes and it is worth stating in PPSSPP's
 * own terms, because the line is not obvious for an emulator:
 *
 * - **config** is how the emulator runs, and survives a game. Resolution, sound,
 *   which CPU core. A host paints a settings screen from it.
 * - **options** is what one session opens with, and is what `start()` and `restart()`
 *   take. Which save slot, whether to resume into it, whether cheats are on.
 * - **assets** are files. The game, and the things that travel beside it.
 * - **storage** is where the memory stick lives between visits.
 *
 * None of these types has an index signature, which is what `EnginePayloads` is
 * shaped to allow: the payloads are closed, so a host that writes a key PPSSPP does
 * not have stops compiling.
 */
import type { EnginePayloads } from '@wasm-gaming/engine-specs';

/**
 * Machine-facing values are PPSSPP's own (`Graphics/InternalResolution` is an int);
 * these are the host-facing names, and `src/settings.ts` is the one place the two
 * meet. A settings screen should not have to know that "linear" is `3`.
 */
export interface PpssppConfig {
  /**
   * How the PSP's 480×272 is scaled before it reaches the canvas. The single biggest
   * performance lever in the browser, which is why it defaults to `1` here and not to
   * PPSSPP's desktop default.
   */
  internalResolution: 1 | 2 | 3 | 4 | 5;
  textureFiltering: 'auto' | 'nearest' | 'linear';
  /** Frames PPSSPP is allowed to drop to keep up. `0` drops none. */
  frameSkip: number;
  /** Let PPSSPP choose the skip instead of holding it at `frameSkip`. */
  autoFrameSkip: boolean;
  soundEnabled: boolean;
  /** PPSSPP's own 0–10 scale, not a 0–1 gain. */
  volume: number;
  /** PPSSPP language file name, e.g. `en_US`, `es_ES`. */
  language: string;
  /**
   * WebAssembly has no runtime code generation, so PPSSPP's real JIT cannot exist
   * here — `X86` and `ARM64` are forced off in the Emscripten CMake path. What is
   * left is the two interpreters, and the IR one is several times the faster.
   *
   * Exposed rather than hardcoded because the plain interpreter is the fallback that
   * still runs when an IR bug makes a title crash, and a host should be able to offer
   * that trade rather than shipping a game that never boots.
   */
  cpuCore: 'ir-interpreter' | 'interpreter';
  /**
   * Size of the Emscripten worker pool. `0` derives it from
   * `navigator.hardwareConcurrency`, which is what a host almost always wants.
   *
   * Fixed at instantiation — the pool is created with the module — so unlike the rest
   * of `config` this one genuinely cannot be `live`.
   */
  threads: number;
}

export interface PpssppOptions {
  /** Which of PPSSPP's save state slots `resume` reads and the UI writes. */
  stateSlot: number;
  /** Boot straight into `stateSlot` instead of starting the game from the top. */
  resume: boolean;
  /** Run unthrottled. The one option that genuinely applies to a running session. */
  fastForward: boolean;
  cheats: boolean;
}

/**
 * `Blob` is listed first in each union on purpose, and it is not a stylistic
 * preference: a `Blob` (a `File` from a picker is one) is mounted through Emscripten's
 * WORKERFS and read lazily, so a 1.8 GB ISO costs nothing in the wasm heap. A
 * `Uint8Array` has to be written into MEMFS, which costs its own size again inside a
 * heap that is capped at 4 GB. Both work; only one of them works for a full-size ISO.
 */
export interface PpssppAssets {
  /** The game: ISO, CSO, CHD, PBP or a raw ELF. */
  game?: Blob | Uint8Array;
  /** A `.ppst` dropped into `options.stateSlot` before boot. */
  saveState?: Blob | Uint8Array;
  /** A cheat database, in PPSSPP's own `.db`/`.ini` format. */
  cheatDb?: Blob | Uint8Array;
}

export interface PpssppStorage {
  /**
   * The IndexedDB-backed directory PPSSPP owns — its memory stick. Two games under
   * one namespace share saves, which is usually what a host wants; two namespaces
   * keep them apart.
   */
  namespace: string;
  /**
   * Whether `destroy()` flushes the memory stick back to IndexedDB. Off is for a
   * kiosk or a demo, where a session should leave nothing behind.
   */
  persist: boolean;
}

/**
 * What this engine announces **beyond** the core set. `start`, `error`, `exit`,
 * `pause` and `resume` are not here: every engine emits those and no engine declares
 * them, so `EventsOf` unions them in.
 */
export interface PpssppEvents {
  /** Read off the disc at boot. The first moment a host can name what it is running. */
  gameInfo: { id: string; title: string; region?: string };
  /** Both rates, because they diverge: a game can render 30 fps at a 60 Hz vsync. */
  fps: { fps: number; vps: number };
  /** Whoever moved it — a host's button, or PPSSPP's own pause menu. */
  saveState: { slot: number; action: 'saved' | 'loaded' };
}

export interface PpssppPayloads extends EnginePayloads {
  config: PpssppConfig;
  options: PpssppOptions;
  assets: PpssppAssets;
  storage: PpssppStorage;
  events: PpssppEvents;
}
