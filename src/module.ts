/**
 * The seam between this package and the Emscripten build of PPSSPP.
 *
 * Everything here is a **specification of the native side**, in the same way that
 * `@wasm-gaming/engine-specs` is a specification of the host side. Nothing in this
 * file talks to a real emulator: it declares the surface `native/` has to expose, and
 * the SDK is written against that declaration alone. That is what lets the whole
 * contract implementation be built and tested before the first byte of wasm exists,
 * and what keeps the eventual C++ port honest — if the port cannot export one of
 * these, the type stops compiling rather than the demo failing at runtime.
 *
 * See `native/README.md` for the C side of each export.
 */

/**
 * What the emulator tells us, unprompted.
 *
 * A discriminated union rather than a string-plus-payload, because the SDK switches
 * on it and TypeScript should narrow the payload. It crosses the boundary as a plain
 * JSON-compatible object so the same shape survives `postMessage` the day the module
 * is moved off the main thread — the reason `engine-specs` puts its own payloads
 * under `detail` rather than passing them bare.
 */
export type PpssppNativeEvent =
  /**
   * The game is up and the first frame is on its way. This is what resolves the
   * promise `start()` returned — not `callMain()` returning, which happens as soon as
   * the main loop is *registered*, long before anything has booted.
   */
  | { readonly type: 'booted'; readonly gameId: string; readonly title: string; readonly region?: string }
  /** Anything the emulator considers fatal. Becomes both a rejection and an `error` event. */
  | { readonly type: 'error'; readonly message: string }
  /** The emulator stopped on its own — the user quit from PPSSPP's own UI, say. */
  | { readonly type: 'exit' }
  /** Frames and vsyncs per second, as PPSSPP's own overlay reports them. */
  | { readonly type: 'fps'; readonly fps: number; readonly vps: number }
  /** A save state moved, whoever asked for it — PPSSPP's menu included. */
  | { readonly type: 'saveState'; readonly slot: number; readonly action: 'saved' | 'loaded' }
  /** PPSSPP's own pause menu opened or closed. Mapped onto the contract's core events. */
  | { readonly type: 'pause' }
  | { readonly type: 'resume' };

/**
 * The slice of Emscripten's `FS` this package uses.
 *
 * Deliberately not the whole of it: a narrow declaration is a list of what the build
 * has to keep exported, and `-sEXPORTED_RUNTIME_METHODS` has to name every one of
 * them. Widening this type means widening that flag.
 */
export interface PpssppFS {
  mkdirTree(path: string): void;
  writeFile(path: string, data: Uint8Array): void;
  unlink(path: string): void;
  /** `type` is one of the file system objects hanging off the module — IDBFS, WORKERFS. */
  mount(type: unknown, options: object, mountpoint: string): void;
  unmount(mountpoint: string): void;
  /** `populate: true` reads the browser store into memory; `false` writes it back out. */
  syncfs(populate: boolean, callback: (error?: unknown) => void): void;
  analyzePath(path: string): { exists: boolean };
}

/**
 * The instantiated module.
 *
 * `ccall` rather than the raw `_`-prefixed exports: the settings bridge passes strings
 * both ways, and hand-marshalling `char*` through `stringToNewUTF8`/`_free` at every
 * call site is four lines of pointer arithmetic to get wrong per setting. `ccall` is
 * the idiomatic seam and it is one `-sEXPORTED_RUNTIME_METHODS` entry.
 */
export interface PpssppModule {
  readonly FS: PpssppFS;
  /** Emscripten's IndexedDB-backed file system, for the memory stick. */
  readonly IDBFS: unknown;
  /**
   * Emscripten's `File`/`Blob`-backed file system. This is how a 1.8 GB ISO is
   * mounted without ever being read into the heap — see {@link PpssppAssets.game}.
   */
  readonly WORKERFS: unknown;

  /**
   * Run `main()`. Called by us rather than by the runtime, which is why the build
   * needs `-sINVOKE_RUN=0`: the memory stick has to be mounted and the game written
   * before PPSSPP looks for either.
   *
   * Returns as soon as the main loop is registered, not when the game has booted.
   */
  callMain(args: string[]): void;

  ccall(
    name: 'ppsspp_web_apply_setting',
    returnType: 'number',
    argTypes: ['string', 'string'],
    args: [key: string, value: string],
  ): number;
  ccall(name: 'ppsspp_web_pause' | 'ppsspp_web_resume' | 'ppsspp_web_shutdown', returnType: null, argTypes: [], args: []): void;

  /** Emscripten's own worker pool, which `close()` has to wind down. */
  readonly PThread?: { terminateAllThreads?(): void };
}

/** What the module factory is handed. Mirrors `-sINCOMING_MODULE_JS_API`. */
export interface PpssppModuleInit {
  /**
   * PPSSPP renders here.
   *
   * **This is not yet enough for SDL3, and the gap is known.** SDL2's Emscripten
   * backend took the element from the module; SDL3's resolves a *CSS selector* from
   * `SDL_HINT_EMSCRIPTEN_CANVAS_SELECTOR`, defaulting to `#canvas`, and fails window
   * creation outright when nothing matches. Since a restart builds a new canvas, they
   * cannot all carry that id, so the selector has to become part of this seam. See
   * `native/README.md`; until then the emulator gets no GL context.
   */
  canvas: HTMLCanvasElement;
  /** Worker pool size. Comes from `config.threads`, resolved against the machine. */
  pthreadPoolSize: number;
  /** Where the `.wasm` and `.data` sit, when they are not next to the JS glue. */
  locateFile?: ((path: string) => string) | undefined;
  print?: ((text: string) => void) | undefined;
  printErr?: ((text: string) => void) | undefined;
  /** Emscripten's own fatal path, which does not go through `ppssppEvent`. */
  onAbort?: ((what: unknown) => void) | undefined;
  /**
   * The one channel from C++ back to us. Registered before instantiation so an error
   * thrown while the runtime is still coming up has somewhere to land — the same rule
   * the contract states for `on()`, one layer down.
   */
  ppssppEvent?: ((event: PpssppNativeEvent) => void) | undefined;
}

/**
 * How a module gets built.
 *
 * A parameter rather than a hard `import` of the generated glue, and that is the
 * whole reason this package can be tested at all: `tests/` passes a fake that
 * implements {@link PpssppModule } in a few dozen lines, the browser passes the real
 * loader, and the SDK cannot tell the difference. It is also what will let a worker
 * build slot in later without the SDK changing.
 */
export type PpssppLoader = (init: PpssppModuleInit) => Promise<PpssppModule>;
