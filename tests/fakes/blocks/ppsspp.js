// Never gives the main thread back — the failure patches 0008 and 0009 exist to fix.
export default async function createPpsspp(moduleArg = {}) {
  const module = Object.assign({}, moduleArg, {
    // The real glue's process environment, which the runner writes SDL3's canvas
    // selector into. A fake without one would make the harness throw where the
    // emulator would not.
    ENV: {},
    // Modelled on the real bridge rather than stubbed: 1 for a setting PPSSPP has, 0
    // for one it does not. The runner asks all three on every run, and a fake that
    // always said 1 would let a harness bug through.
    ccall(name, _returnType, _argTypes, args) {
      if (name !== 'ppsspp_web_apply_setting') return 0;
      return /^(General|CPU|Graphics|Sound|Control|SystemParam|Web)\//.test(args[0]) ? 1 : 0;
    },
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
