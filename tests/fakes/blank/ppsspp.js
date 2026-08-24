// Turns the event loop honestly and never asks for a surface at all.
//
// The pre-0008 shape of the failure, minus the blocking: everything the heartbeat can
// see is healthy. Only the canvas says otherwise.
export default async function createPpsspp(moduleArg = {}) {
  return Object.assign({}, moduleArg, {
    // The real glue's process environment, which the runner writes SDL3's canvas
    // selector into before callMain. A fake without one would make the harness throw
    // where the emulator would not.
    ENV: {},
    callMain() {
      const spin = () => requestAnimationFrame(spin);
      requestAnimationFrame(spin);
    },
  });
}
