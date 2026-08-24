// Never gives the main thread back — the failure patches 0008 and 0009 exist to fix.
export default async function createPpsspp(moduleArg = {}) {
  return Object.assign({}, moduleArg, {
    callMain() {
      const until = Date.now() + 120000;
      while (Date.now() < until) {
        /* the browser's main thread, held exactly as PPSSPP's GL loop used to hold it */
      }
    },
  });
}
