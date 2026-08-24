// Turns the event loop honestly and never asks for a surface at all.
//
// The pre-0008 shape of the failure, minus the blocking: everything the heartbeat can
// see is healthy. Only the canvas says otherwise.
export default async function createPpsspp(moduleArg = {}) {
  return Object.assign({}, moduleArg, {
    callMain() {
      const spin = () => requestAnimationFrame(spin);
      requestAnimationFrame(spin);
    },
  });
}
