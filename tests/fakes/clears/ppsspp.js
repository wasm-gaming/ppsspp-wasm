// Comes up, owns a GL context, clears it every frame — and draws nothing.
//
// This is the fake that matters. It is what a port that boots, registers its main loop
// and renders nothing actually looks like from outside: a live tab, a turning event
// loop, and a canvas that is uniformly *some* colour rather than empty. Any pixel check
// that asks "is there anything on the canvas?" passes this, which is why the runner asks
// how many colours instead.
export default async function createPpsspp(moduleArg = {}) {
  const module = Object.assign({}, moduleArg, {
    // The real glue's process environment, which the runner writes SDL3's canvas
    // selector into. A fake without one would make the harness throw where the
    // emulator would not.
    ENV: {},
    callMain() {
      const gl = moduleArg.canvas.getContext('webgl2');
      if (!gl) throw new Error('no webgl2 context');
      const draw = () => {
        gl.clearColor(0.05, 0.07, 0.12, 1);
        gl.clear(gl.COLOR_BUFFER_BIT);
        requestAnimationFrame(draw);
      };
      requestAnimationFrame(draw);
    },
  });
  // Emscripten calls these before the static constructors that copy ENV into the
  // environment C sees, and hands each one the module. That is where the runner writes
  // SDL3's canvas selector, so a fake that never called them would leave the one path
  // the real build depends on untested.
  for (const fn of moduleArg.preRun ?? []) fn(module);
  return module;
}
