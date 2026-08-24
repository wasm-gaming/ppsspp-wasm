// Never gives the main thread back — the failure patches 0008 and 0009 exist to fix.
export default async function createPpsspp(moduleArg = {}) {
  return Object.assign({}, moduleArg, {
    // The real glue's process environment, which the runner writes SDL3's canvas
    // selector into before callMain. A fake without one would make the harness throw
    // where the emulator would not.
    ENV: {},
    callMain() {
      const until = Date.now() + 120000;
      while (Date.now() < until) {
        /* the browser's main thread, held exactly as PPSSPP's GL loop used to hold it */
      }
    },
  });
}
