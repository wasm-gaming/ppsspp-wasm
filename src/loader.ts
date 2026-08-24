/**
 * The default loader: the one place that knows the generated Emscripten glue exists.
 *
 * It is separated from the SDK so that importing this package costs nothing until a
 * session actually starts — and so that `tests/` can drive the whole contract in Node
 * without a `.wasm` anywhere on disk, by passing its own {@link PpssppLoader}.
 */
import type { PpssppLoader, PpssppModule, PpssppModuleInit } from './module.js';

/**
 * The glue `make wasm` emits, next to the `.wasm` and the `.data` it references.
 *
 * Not a static `import`, and the specifier is built at runtime rather than written as
 * a literal, for one reason: this file has to typecheck and this package has to
 * publish in a tree where `native/` has not been built yet. A literal specifier would
 * make `tsc` demand a module that only exists after a 40-minute Emscripten run.
 */
const GLUE = 'native/ppsspp.js';

/**
 * Where the `.wasm` and the `.data` are, given where the glue is.
 *
 * This exists because Emscripten resolves the two halves of its own output by
 * *different* rules, and only one of them is what a reader expects. With
 * `-sEXPORT_ES6` the `.wasm` is found relative to the glue module, through
 * `import.meta.url`. The file-packager code that `--preload-file` generates is not so
 * lucky: it asks for `ppsspp.data` by a bare relative name, which the browser resolves
 * against the **document**, not against the module that referenced it.
 *
 * So on any page not served from the same directory as the glue — which is every real
 * host, since the glue ships inside `node_modules` — the `.data` 404s. And it does not
 * fail loudly: the package's run dependency is never cleared, the module factory's
 * promise never settles, and the host sees `start()` hang with nothing in the console
 * but Emscripten repeating "still waiting on run dependencies".
 *
 * Found by pointing `make smoke` at a page that serves the glue under `/native/`, which
 * is what a host looks like and what the demo's stub never was.
 */
export const besideTheGlue = (path: string): string =>
  new URL(path, new URL(GLUE, import.meta.url)).href;

/** What Emscripten's `-sMODULARIZE=1 -sEXPORT_ES6=1` default export looks like. */
type ModuleFactory = (init: Record<string, unknown>) => Promise<PpssppModule>;

let factory: Promise<ModuleFactory> | undefined;

/** Loaded once and reused: the glue is a module, and re-importing it buys nothing. */
function glue(): Promise<ModuleFactory> {
  const specifier = new URL(GLUE, import.meta.url).href;
  factory ??= import(/* @vite-ignore */ specifier).then(
    (module: { default: ModuleFactory }) => module.default,
  );
  return factory;
}

/**
 * What a page must be for the module to start at all.
 *
 * PPSSPP is genuinely multi-threaded, the build links with `-pthread`, and Emscripten
 * implements those threads with `SharedArrayBuffer` — which a browser only exposes to
 * a **cross-origin isolated** page. Without the isolation the module does not fail
 * politely: it fails somewhere inside the generated glue with a message that says
 * nothing about headers, and a host is left debugging the emulator instead of its
 * server.
 *
 * So this is checked before the glue is even imported, and the error names the two
 * headers and the way out. `=== false` rather than a falsy test on purpose: outside a
 * browser the global does not exist, and a Node process driving this package through
 * its own loader has no `SharedArrayBuffer` problem to warn about.
 */
function requireIsolation(): void {
  if (globalThis.crossOriginIsolated === false) {
    throw new Error(
      'ppsspp: this page is not cross-origin isolated, so SharedArrayBuffer is unavailable ' +
        'and the emulator cannot start its threads. Serve it with ' +
        '`Cross-Origin-Opener-Policy: same-origin` and `Cross-Origin-Embedder-Policy: require-corp`. ' +
        'On a host that cannot set headers — GitHub Pages, for one — a service worker such as ' +
        'coi-serviceworker can inject them; see native/README.md.',
    );
  }
}

/**
 * Instantiate PPSSPP.
 *
 * Note what is *not* here: `arguments`, and any expectation that the module starts
 * running. The build sets `-sINVOKE_RUN=0` so `main()` waits for
 * {@link PpssppModule.callMain}, because the memory stick has to be mounted and the
 * game staged before PPSSPP goes looking for either.
 */
export const loadPpsspp: PpssppLoader = async (init: PpssppModuleInit): Promise<PpssppModule> => {
  requireIsolation();
  const create = await glue();
  const module = await create({
    canvas: init.canvas,
    // Read by the `-sPTHREAD_POOL_SIZE` expression the build links with, which is how
    // a link-time pool size is made to follow a runtime decision. See native/README.md.
    pthreadPoolSize: init.pthreadPoolSize,
    // A host that knows better still wins; the default is only what makes the module
    // find its own files when nobody says otherwise.
    locateFile: init.locateFile ?? besideTheGlue,
    // Seeded so that SDL3 can overwrite it, and for no other reason.
    //
    // `Emscripten_CreateWindow` ends with a MAIN_THREAD_EM_ASM that does
    // `Module['requestFullscreen'] = ...`, to route the browser's own fullscreen button
    // through SDL. Under `-sASSERTIONS` Emscripten installs a getter-only tripwire on
    // every runtime symbol missing from `-sEXPORTED_RUNTIME_METHODS`, and this build's
    // export list is deliberately narrow — so that assignment throws
    // "Cannot set property requestFullscreen of #<Object> which has only a getter",
    // from inside SDL, after the window has already been created.
    //
    // An own property, however dull, is what stops the tripwire being installed. In a
    // build without assertions this line changes nothing; with them it is the
    // difference between an instrument that observes the port and one that breaks it.
    requestFullscreen: undefined,
    ...(init.print ? { print: init.print } : {}),
    ...(init.printErr ? { printErr: init.printErr } : {}),
    ...(init.onAbort ? { onAbort: init.onAbort } : {}),
    ...(init.ppssppEvent ? { ppssppEvent: init.ppssppEvent } : {}),
  });

  // The other half of "PPSSPP renders here", and the half SDL3 actually reads.
  //
  // Its Emscripten video driver resolves `SDL_HINT_EMSCRIPTEN_CANVAS_SELECTOR` in
  // `Emscripten_CreateWindow`, and `SDL_GetHint` looks at the environment before its
  // own hint table — so writing it here, after instantiation and before `callMain`,
  // is in time: the window is not created until `main()` runs. Nothing in C is
  // involved, which is why `ENV` is exported at all.
  //
  // The alternative SDL offers is `SDL_PROP_WINDOW_CREATE_EMSCRIPTEN_CANVAS_ID_STRING`
  // on `SDL_CreateWindowWithProperties`, which would be per window rather than per
  // process — a better fit for what this package does, and a patch to PPSSPP's own
  // window creation rather than a line here. This is the cheaper of the two and the
  // one that needs nothing from upstream.
  module.ENV.SDL_EMSCRIPTEN_CANVAS_SELECTOR = init.canvasSelector;
  return module;
};
