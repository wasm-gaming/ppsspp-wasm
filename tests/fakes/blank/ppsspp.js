// Turns the event loop honestly and never asks for a surface at all.
//
// The pre-0008 shape of the failure, minus the blocking: everything the heartbeat can
// see is healthy. Only the canvas says otherwise.
export default async function createPpsspp(moduleArg = {}) {
  const module = Object.assign({}, moduleArg, {
    // The real glue's process environment, which the runner writes SDL3's canvas
    // selector into. A fake without one would make the harness throw where the
    // emulator would not.
    ENV: {},
    callMain() {
      const spin = () => requestAnimationFrame(spin);
      requestAnimationFrame(spin);
    },
  });
  // Emscripten calls these before the static constructors that copy ENV into the
  // environment C sees, and hands each one the module. That is where the runner writes
  // SDL3's canvas selector, so a fake that never called them would leave the one path
  // the real build depends on untested.
  for (const fn of moduleArg.preRun ?? []) fn(module);
  return module;
}
