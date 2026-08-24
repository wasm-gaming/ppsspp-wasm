/**
 * PPSSPP, as an engine the wasm-gaming contract can drive.
 *
 * Everything the contract prescribes — the state, the descriptors, the cumulative
 * merge, the chainable promise, the channel — is inherited from `EnginePlayBase` and
 * `EngineSDKBase`. What is written here is the part that is actually about running a
 * PSP emulator in a browser: a canvas with a WebGL context, an IndexedDB memory
 * stick, an ISO mounted without being copied, and an Emscripten module that runs
 * `main()` exactly once.
 *
 * That last fact shapes more of this file than anything else. See {@link
 * PpssppPlay.open}.
 */
import { EnginePlayBase, EngineSDKBase } from '@wasm-gaming/engine-specs';
import type {
  EngineInit,
  EventEmitter,
  EventsOf,
  PayloadKind,
  PropertiesDefinition,
  PropertyDefinition,
} from '@wasm-gaming/engine-specs';

import { stage } from './assets.js';
import { loadPpsspp } from './loader.js';
import type { PpssppFS, PpssppLoader, PpssppModule, PpssppNativeEvent } from './module.js';
import type { PpssppAssets, PpssppConfig, PpssppOptions, PpssppPayloads } from './payloads.js';
import { autoLoadSaveState, CONFIG_BINDINGS, OPTION_BINDINGS, resolve, toIni } from './settings.js';
import { spec } from './spec.js';

export type PpssppInit = EngineInit<PpssppPayloads>;
export type PpssppChannel = EventEmitter<EventsOf<PpssppPayloads>>;

/**
 * Emscripten's default home. PPSSPP's SDL build looks for its user directory under
 * `$HOME/.config`, and that is the directory the memory stick hangs off.
 */
const CONFIG_ROOT = '/home/web_user/.config';
/** Where the game is mounted. Outside the memory stick: it is not the user's data. */
const GAME_ROOT = '/game';

interface Deferred<T> {
  readonly promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
}

function defer<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** Every property has a value in the descriptor, but an unset asset's is `undefined`. */
type Values<T> = { readonly [K in keyof T]: T[K] | undefined };

/** The contract answers reads as descriptors; the emulator wants the values out of them. */
function valuesOf<T extends object>(definitions: PropertiesDefinition<T>): Values<T> {
  const out: Record<string, unknown> = {};
  for (const [key, definition] of Object.entries(definitions)) {
    out[key] = (definition as PropertyDefinition<unknown>).value;
  }
  return out as Values<T>;
}

function syncfs(fs: PpssppFS, populate: boolean): Promise<void> {
  return new Promise((resolve_, reject) => {
    fs.syncfs(populate, (error) => (error ? reject(error) : resolve_()));
  });
}

/**
 * `0` means "ask the machine", which is what a host almost always wants. The floor of
 * four matches what PPSSPP needs to keep its own worker threads apart on a dual-core
 * laptop — fewer and they serialise against each other.
 */
function poolSize(threads: number | undefined): number {
  if (threads !== undefined && threads > 0) return Math.trunc(threads);
  const cores = typeof navigator === 'undefined' ? undefined : navigator.hardwareConcurrency;
  return Math.max(4, cores ?? 4);
}

const encode = (text: string): Uint8Array => new TextEncoder().encode(text);

/**
 * Numbers the canvases, so that each one has an id nothing else on the page shares.
 *
 * Per module rather than per session on purpose: two `PpssppPlay`s on one page would
 * otherwise hand SDL3 the same selector, and the second one would render into the
 * first one's element.
 */
let canvasSerial = 0;

/**
 * The live emulator.
 *
 * @see {@link PpssppSDK} for the factory a host actually constructs.
 */
export class PpssppPlay extends EnginePlayBase<PpssppPayloads> {
  readonly #loader: PpssppLoader;
  #module: PpssppModule | undefined;
  #canvas: HTMLCanvasElement | undefined;
  /** Set only while a boot is in flight — see {@link PpssppPlay.fail}. */
  #booted: Deferred<void> | undefined;
  #storageMount: string | undefined;
  #persist = true;
  #destroyed = false;

  /**
   * The spec goes up to the base rather than living as a field here: a subclass field
   * initialiser runs *after* `super()`, which would be too late for the base to seed
   * its state from the declared defaults.
   *
   * @param loader How the wasm module is built. Defaulted rather than imported at the
   * call site so a host writes `new PpssppSDK()`, and overridable so the tests can
   * hand in a fake — the seam that lets this whole class be exercised in Node.
   */
  constructor(init?: PpssppInit, events?: PpssppChannel, loader: PpssppLoader = loadPpsspp) {
    super(spec, init, events);
    this.#loader = loader;
  }

  // ---- What the contract asks a subclass for ----

  /**
   * Open, or reopen, a session.
   *
   * **An Emscripten module runs `main()` once.** There is no supported way to run it
   * again, so `restart()` cannot mean "tell the emulator to reboot" — it means tear
   * the module down and build another. That is why this begins by disposing of
   * whatever is already running, and it is the one place where the contract's
   * chainable `restart()` costs considerably more than it reads like it should.
   */
  protected override async open(options: PpssppOptions): Promise<void> {
    const assets = valuesOf(await this.assets());
    // Checked before anything is built: booting into PPSSPP's own file browser is not
    // a session a host in this ecosystem wants, and instantiating a module to discover
    // that would waste several seconds and a few hundred megabytes.
    if (!assets.game) {
      throw new Error('ppsspp: assets({ game }) before start() — there is nothing to boot');
    }
    if (!this.target) {
      throw new Error('ppsspp: mount(target) before start() — the emulator needs an element to draw into');
    }

    if (this.#module) await this.#dispose();
    this.#destroyed = false;

    // Armed before the module is even built, and that ordering is the whole point:
    // Emscripten can abort during runtime initialisation, which arrives through
    // `onAbort` while there is nothing else in flight to reject. Racing the boot work
    // against this promise means such a failure ends the boot, rather than being
    // emitted into a session that then waits forever for a first frame.
    const booted = defer<void>();
    this.#booted = booted;
    const work = this.#boot(booted, options, assets);
    // The race is what reports the failure; this only keeps the loser of the race
    // from surfacing as an unhandled rejection.
    work.catch(() => {});

    try {
      await Promise.race([work, booted.promise]);
    } finally {
      this.#booted = undefined;
    }
  }

  /** Everything between "no module" and "the first frame is on its way". */
  async #boot(booted: Deferred<void>, options: PpssppOptions, assets: Values<PpssppAssets>): Promise<void> {
    const config = valuesOf(await this.config());
    const storage = valuesOf(await this.storage());
    const namespace = storage.namespace ?? 'ppsspp';
    this.#persist = storage.persist ?? true;

    const canvas = this.#freshCanvas();
    const module = await this.#loader({
      canvas,
      // SDL3 finds the canvas by selector rather than by element — see
      // `PpssppModuleInit.canvasSelector`. The id is this session's own, so two
      // players on one page do not fight over it, and so a restart's new canvas is a
      // new target rather than a stale one.
      canvasSelector: `#${canvas.id}`,
      pthreadPoolSize: poolSize(config.threads),
      ppssppEvent: (event) => this.#native(event),
      // Emscripten's own fatal path does not go through `ppssppEvent`, so it needs
      // wiring separately or an abort would be silent.
      onAbort: (what) => this.#fail(new Error(`ppsspp: aborted — ${String(what)}`)),
    });
    this.#module = module;

    const userDir = `${CONFIG_ROOT}/${namespace}`;
    await this.#mountStorage(module, userDir);
    const gamePath = await this.#writeAssets(module, assets, `${userDir}/PSP`);
    // After the memory stick is populated, deliberately: whatever PPSSPP persisted
    // last session is overwritten by the state this contract holds. Otherwise
    // `config()` would describe settings the emulator is not actually running with,
    // and a getter that lies is worse than no getter.
    module.FS.writeFile(`${userDir}/ppsspp.ini`, encode(this.#ini(config, options)));

    // Returns as soon as the main loop is registered — long before a game has booted.
    // `booted` is what the native side resolves when the first frame is on its way,
    // and it is what makes `await start()` mean what a host reads it to mean.
    module.callMain(['ppsspp', gamePath]);
    await booted.promise;
  }

  /** Stop and release. The base emits `exit` once this returns. */
  protected override async close(): Promise<void> {
    await this.#dispose();
    this.#canvas?.remove();
    this.#canvas = undefined;
  }

  /**
   * A payload changed on a running session.
   *
   * Only what the spec advertises as `live` is applied; the rest is already in the
   * contract's state and reaches the emulator through the ini the next `restart()`
   * writes. Nothing happens at all when no module is up — the same reason.
   */
  protected override patched(kind: PayloadKind, patch: object): void {
    const module = this.#module;
    if (!module) return;
    if (kind !== 'config' && kind !== 'options') return;

    const bindings = kind === 'config' ? CONFIG_BINDINGS : OPTION_BINDINGS;
    const declared = spec[kind] as Record<string, { live?: boolean }>;
    const live: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(patch)) {
      if (declared[key]?.live) live[key] = value;
    }

    for (const setting of resolve(bindings as never, live)) {
      module.ccall(
        'ppsspp_web_apply_setting',
        'number',
        ['string', 'string'],
        [`${setting.section}/${setting.key}`, setting.value],
      );
    }
  }

  // ---- The contract, with one guarantee tightened ----

  /**
   * Idempotent, which the base's is not.
   *
   * The emulator can also stop on its own — the user quits from PPSSPP's own pause
   * menu — and the honest response to that is to destroy the session, so `exit`
   * reaches the host through the one path the contract describes. But a host that
   * then calls `destroy()` itself would emit `exit` a second time, and the contract
   * says it fires once. Guarding here is what keeps that true whoever asks first.
   */
  override async destroy(): Promise<void> {
    if (this.#destroyed) return;
    this.#destroyed = true;
    await super.destroy();
  }

  // ---- Beyond the contract: this engine's own members ----

  /**
   * Pause and resume are **not** in the contract — `pause` and `resume` are core
   * *events*, and this is how a host asks for them. PPSSPP's own pause menu emits the
   * same pair, so a host can react to either without knowing which happened.
   */
  pause(owner = 'host'): void {
    this.#module?.ccall('ppsspp_web_pause', null, [], []);
    this.emit('pause', { owner });
  }

  resume(owner = 'host'): void {
    this.#module?.ccall('ppsspp_web_resume', null, [], []);
    this.emit('resume', { owner });
  }

  // ---- Machinery ----

  /**
   * A **new** canvas every time, and this is not tidiness.
   *
   * A canvas hands out one WebGL context for its entire lifetime: once SDL has taken
   * it, no second Emscripten module can ever get a context from that element again.
   * Reusing it across a `restart()` would fail at the point where the picture is
   * supposed to appear, with an error that says nothing about why.
   */
  #freshCanvas(): HTMLCanvasElement {
    const target = this.target;
    if (!target) throw new Error('ppsspp: mount(target) before start()');
    this.#canvas?.remove();
    const canvas = target.ownerDocument.createElement('canvas');
    // Unique, and generated rather than fixed: SDL3 is handed `#<this>` and resolves
    // it against the whole document, so a second session on the same page — or the
    // canvas a previous `start()` has not finished removing — must not match it. The
    // shape is ours, so it needs no escaping to be a valid selector.
    canvas.id = `ppsspp-canvas-${++canvasSerial}`;
    canvas.width = 480;
    canvas.height = 272;
    canvas.style.display = 'block';
    canvas.style.width = '100%';
    // So the keyboard reaches the emulator rather than the page behind it.
    canvas.tabIndex = 0;
    target.appendChild(canvas);
    this.#canvas = canvas;
    return canvas;
  }

  async #mountStorage(module: PpssppModule, userDir: string): Promise<void> {
    module.FS.mkdirTree(userDir);
    module.FS.mount(module.IDBFS, {}, userDir);
    this.#storageMount = userDir;
    // `true` reads the browser's copy in. Without it the memory stick starts empty
    // every visit and PPSSPP writes saves nobody ever sees again.
    await syncfs(module.FS, true);
  }

  /** @returns the path PPSSPP is told to boot. */
  async #writeAssets(
    module: PpssppModule,
    assets: Values<PpssppAssets>,
    pspDir: string,
  ): Promise<string> {
    const fs = module.FS;
    const game = await stage(assets.game as Blob | Uint8Array, 'game');
    fs.mkdirTree(GAME_ROOT);
    if (game.blob) {
      // The whole reason a Blob is worth preferring: mounted, never read.
      fs.mount(module.WORKERFS, { blobs: [{ name: game.name, data: game.blob }] }, GAME_ROOT);
    } else if (game.bytes) {
      fs.writeFile(`${GAME_ROOT}/${game.name}`, game.bytes);
    }

    if (assets.saveState) {
      const state = await stage(assets.saveState, '');
      // PPSSPP finds a state by its file name — `<gameId>_1.<slot>.ppst` — so a name
      // we invented would simply never be found. A `.ppst` exported from PPSSPP
      // already carries the right one; an anonymous Blob cannot.
      if (!state.name.endsWith('.ppst')) {
        throw new Error(
          'ppsspp: assets({ saveState }) needs a File keeping PPSSPP\'s own name, e.g. ULUS10041_1.00.ppst — that name is how PPSSPP finds the state',
        );
      }
      const states = `${pspDir}/PPSSPP_STATE`;
      fs.mkdirTree(states);
      await this.#write(fs, `${states}/${state.name}`, state);
    }

    if (assets.cheatDb) {
      const cheats = `${pspDir}/Cheats`;
      fs.mkdirTree(cheats);
      await this.#write(fs, `${cheats}/cheat.db`, await stage(assets.cheatDb, 'cheat'));
    }

    return `${GAME_ROOT}/${game.name}`;
  }

  /** Small files only — everything here is measured in kilobytes, so a copy is fine. */
  async #write(fs: PpssppFS, path: string, asset: { blob?: Blob; bytes?: Uint8Array }): Promise<void> {
    const bytes = asset.bytes ?? new Uint8Array(await (asset.blob as Blob).arrayBuffer());
    fs.writeFile(path, bytes);
  }

  #ini(config: Values<PpssppConfig>, options: PpssppOptions): string {
    return toIni([
      ...resolve(CONFIG_BINDINGS, config as Partial<PpssppConfig>),
      ...resolve(OPTION_BINDINGS, options),
      autoLoadSaveState(options),
    ]);
  }

  /** Translate what the emulator says into what the contract says. */
  #native(event: PpssppNativeEvent): void {
    switch (event.type) {
      case 'booted': {
        this.emit(
          'gameInfo',
          event.region === undefined
            ? { id: event.gameId, title: event.title }
            : { id: event.gameId, title: event.title, region: event.region },
        );
        this.#booted?.resolve();
        return;
      }
      case 'error':
        this.#fail(new Error(event.message));
        return;
      case 'exit':
        // The emulator went away on its own. Destroying is what turns that into the
        // one `exit` the contract describes, rather than a second kind of ending a
        // host would have to learn about.
        void this.destroy();
        return;
      case 'fps':
        this.emit('fps', { fps: event.fps, vps: event.vps });
        return;
      case 'saveState':
        this.emit('saveState', { slot: event.slot, action: event.action });
        return;
      case 'pause':
        this.emit('pause', { owner: 'ppsspp' });
        return;
      case 'resume':
        this.emit('resume', { owner: 'ppsspp' });
        return;
    }
  }

  /**
   * An error reaches the host **both ways**, and which way depends on when it arrives.
   *
   * While a boot is in flight, rejecting is enough: `open()` throws, and the base
   * turns that single throw into the rejection *and* the `error` event. Afterwards
   * there is no promise left to reject, so emitting is the only path there is.
   */
  #fail(error: Error): void {
    const booted = this.#booted;
    if (booted) {
      this.#booted = undefined;
      booted.reject(error);
      return;
    }
    this.emit('error', error);
  }

  /** Wind the module down without touching the canvas — `close()` owns that. */
  async #dispose(): Promise<void> {
    const module = this.#module;
    if (!module) return;
    // Cleared first, so an event arriving mid-teardown finds nothing to act on.
    this.#module = undefined;

    try {
      module.ccall('ppsspp_web_shutdown', null, [], []);
    } catch {
      // Already gone. Nothing here is worth failing a `destroy()` over.
    }

    if (this.#storageMount) {
      const mount = this.#storageMount;
      this.#storageMount = undefined;
      try {
        // The flush that makes a save survive the tab closing.
        if (this.#persist) await syncfs(module.FS, false);
        module.FS.unmount(mount);
      } catch {
        // A module that already aborted has no working FS. Losing the flush is bad;
        // throwing here would also lose the thread teardown below, which is worse.
      }
    }

    module.PThread?.terminateAllThreads?.();
  }
}

/**
 * The factory a host constructs.
 *
 * Identity is static, so a launcher can list this engine beside eleven others without
 * instantiating any of them — and without loading a megabyte of wasm to find out what
 * it is called.
 */
export class PpssppSDK extends EngineSDKBase<PpssppPayloads> {
  static id = 'ppsspp';
  static version = '0.1.0';
  static name = 'PPSSPP';
  static description = 'PlayStation Portable emulator, compiled to WebAssembly.';

  readonly #loader: PpssppLoader;

  /**
   * The second parameter is this engine's own, and it stays invisible to the
   * contract: `EngineSDKConstructor` asks for `new (init?) => EngineSDK`, and a
   * constructor with an extra *optional* parameter still satisfies it. That is what
   * lets the tests inject a fake module without the conformance check weakening.
   */
  constructor(init?: PpssppInit, loader: PpssppLoader = loadPpsspp) {
    super(init);
    this.#loader = loader;
  }

  protected override createPlay(init: PpssppInit, events: PpssppChannel): PpssppPlay {
    return new PpssppPlay(init, events, this.#loader);
  }
}

export { spec } from './spec.js';
export { detectExtension, stage } from './assets.js';
export type { StagedAsset } from './assets.js';
export { loadPpsspp } from './loader.js';
export * from './module.js';
export * from './payloads.js';
export * from './settings.js';

export default PpssppSDK;
