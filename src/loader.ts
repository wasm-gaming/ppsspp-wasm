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
 * Instantiate PPSSPP.
 *
 * Note what is *not* here: `arguments`, and any expectation that the module starts
 * running. The build sets `-sINVOKE_RUN=0` so `main()` waits for
 * {@link PpssppModule.callMain}, because the memory stick has to be mounted and the
 * game staged before PPSSPP goes looking for either.
 */
export const loadPpsspp: PpssppLoader = async (init: PpssppModuleInit): Promise<PpssppModule> => {
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
