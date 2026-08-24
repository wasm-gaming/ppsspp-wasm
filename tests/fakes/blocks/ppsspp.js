// Never gives the main thread back — the failure patches 0008 and 0009 exist to fix.
export default async function createPpsspp(moduleArg = {}) {
  const module = Object.assign({}, moduleArg, {
    // The real glue's process environment, which the runner writes SDL3's canvas
    // selector into. A fake without one would make the harness throw where the
    // emulator would not.
    ENV: {},
    callMain() {
      const until = Date.now() + 120000;
      while (Date.now() < until) {
        /* the browser's main thread, held exactly as PPSSPP's GL loop used to hold it */
      }
    },
  });
  // Emscripten calls these before the static constructors that copy ENV into the
  // environment C sees, and hands each one the module. That is where the runner writes
  // SDL3's canvas selector, so a fake that never called them would leave the one path
  // the real build depends on untested.
  for (const fn of moduleArg.preRun ?? []) fn(module);
  return module;
}
