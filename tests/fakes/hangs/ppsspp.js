// A factory promise that never settles — what a missing preloaded file looks like.
//
// Round 12's real failure: ppsspp.data 404'd, the run dependency was never cleared, and
// the module simply never finished coming up, with the main thread perfectly alive.
export default function createPpsspp() {
  return new Promise(() => {});
}
