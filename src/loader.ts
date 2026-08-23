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
  return create({
    canvas: init.canvas,
    // Read by the `-sPTHREAD_POOL_SIZE` expression the build links with, which is how
    // a link-time pool size is made to follow a runtime decision. See native/README.md.
    pthreadPoolSize: init.pthreadPoolSize,
    ...(init.locateFile ? { locateFile: init.locateFile } : {}),
    ...(init.print ? { print: init.print } : {}),
    ...(init.printErr ? { printErr: init.printErr } : {}),
    ...(init.onAbort ? { onAbort: init.onAbort } : {}),
    ...(init.ppssppEvent ? { ppssppEvent: init.ppssppEvent } : {}),
  });
};
