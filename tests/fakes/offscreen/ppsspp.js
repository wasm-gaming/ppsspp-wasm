// Renders, and never blits: every clear lands in a framebuffer of its own.
//
// The second kind of "nothing was drawn", and the reason the runner counts GL calls
// rather than only reading pixels. From the canvas alone this is indistinguishable from
// a port whose render loop never runs at all — same BLANK, same zero opaque pixels —
// and the two have nothing in common as bugs.
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
      const gl = moduleArg.canvas.getContext('webgl2');
      if (!gl) throw new Error('no webgl2 context');

      const tex = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 64, 64, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
      const fbo = gl.createFramebuffer();
      gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);

      const draw = () => {
        gl.clearColor(0.9, 0.2, 0.4, 1);
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
